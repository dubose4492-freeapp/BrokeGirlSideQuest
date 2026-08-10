// functions/_shared/quota.js
//
// Tracks how many times each TIER's primary search engine has actually
// been called, so search-providers.js's tier system knows when a tier's
// free-tier allotment is used up and it's time to advance to the next one
// (Tavily -> Serper -> Exa -> DuckDuckGo). See the tier table at the top of
// search-providers.js for the full picture.
//
// Same best-effort KV-counter pattern as rate-limit.js: not perfectly
// atomic under truly concurrent writes (KV reads/writes aren't atomic), and
// FAILS OPEN if QUOTA_KV isn't bound — getQuotaUsage() always reports 0
// used, incrementQuotaUsage() is a no-op. That means an unconfigured KV
// namespace never breaks search; it just means the tier system can't
// actually track usage, so resolveActiveTier() in search-providers.js will
// keep landing on Tier 1 forever (as long as Tavily is configured) instead
// of ever advancing. See DEPLOY_INSTRUCTIONS.md for the one-time KV setup —
// same binding pattern as RATE_LIMIT_KV, just a separate namespace so
// quota-tracking and rate-limiting never step on each other's counters.
//
// Two counting "periods", matching how each engine's free tier actually
// resets:
//   - "monthly": resets automatically every calendar month (Tavily's free
//     grounded-search tier renews monthly). The KV key itself is scoped to
//     the current YYYY-MM, so a new month just starts a fresh key — no
//     explicit reset job needed.
//   - "total": never resets — for one-time free allotments (Serper's
//     2,500-query total, Exa's one-time $10 credit approximated as a call
//     count — see EXA_CALL_LIMIT in search-providers.js). If you upgrade
//     off a provider's free tier, bump that provider's *_LIMIT env var
//     rather than trying to reset/delete the "total" key — a higher cap is
//     the correct fix, not pretending zero calls happened.
//
// Also tracks, separately from the above: a per-engine "zero-result
// streak" — see incrementZeroStreak/resetZeroStreak/setQuotaExhausted
// below. Three CONSECUTIVE empty (but non-error) responses from a tier's
// primary engine are treated as that tier being quota-exhausted, jumping
// its usage counter straight to cap. One non-empty response resets the
// streak. This is intentionally a 3-strike rule, not immediate, because a
// single empty response is ambiguous (narrow query vs. actually
// exhausted) — three in a row is a much stronger signal.

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quotaKey(engine, period) {
  return period === "monthly" ? `quota:${engine}:${monthKey()}` : `quota:${engine}:total`;
}

// Current usage count for one engine/period. Always 0 if QUOTA_KV isn't
// bound or a read fails — see file header on why that's the right default
// rather than throwing (a broken quota check should never block search).
export async function getQuotaUsage(env, engine, period) {
  if (!env.QUOTA_KV) return 0;
  try {
    const raw = await env.QUOTA_KV.get(quotaKey(engine, period));
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch (err) {
    console.warn(`[quota] read failed for ${engine}/${period}, treating as 0 used — ${err.message}`);
    return 0;
  }
}

// Records one more call against an engine/period's counter. Called once
// per actual outbound request to that engine — see search-providers.js —
// so the counter reflects real usage, not just successful ones (a request
// that hit the provider still spent toward most providers' rate/quota
// limits even if it happened to error).
export async function incrementQuotaUsage(env, engine, period) {
  if (!env.QUOTA_KV) return; // nothing to persist to — see file header
  const key = quotaKey(engine, period);
  try {
    const raw = await env.QUOTA_KV.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    // "monthly" keys get a TTL a little past two months so a stray old key
    // never lingers forever; "total" keys never expire (they're not
    // supposed to reset).
    const opts = period === "monthly" ? { expirationTtl: 60 * 60 * 24 * 62 } : {};
    await env.QUOTA_KV.put(key, String(count + 1), opts);
  } catch (err) {
    console.warn(`[quota] increment failed for ${engine}/${period} — ${err.message}`);
  }
}

// SEARCHER-ONLY, by design (see search-providers.js callers — NOT used
// anywhere in llm-providers.js's sorter chain).
//
// Jumps an engine/period's counter straight to `cap` instead of the usual
// +1. Called when a search tier's PRIMARY engine responds successfully
// but with zero results — the app treats that the same as an exhausted
// free-tier quota (many search providers silently return an empty page
// instead of a hard error once you're over your allotment, so "no data
// back" is read as "tokens/credits used up" for this engine) and
// resolveActiveTierIndex() will skip straight past it on every
// subsequent call until this counter's period resets.
//
// One legitimate false-positive to be aware of: a genuinely narrow query
// (e.g. a very specific address search) can also come back empty from a
// perfectly healthy engine. This function can't tell the two apart — it's
// deliberately aggressive per the app's design, not a bug. If an engine
// seems to "go quiet" for the rest of a month after a single odd query,
// this is why; the fix is bumping that provider's *_LIMIT env var once
// you confirm (via its own dashboard) that it wasn't actually exhausted.
export async function setQuotaExhausted(env, engine, period, cap) {
  if (!env.QUOTA_KV) return; // fails open — same as incrementQuotaUsage
  const key = quotaKey(engine, period);
  try {
    const opts = period === "monthly" ? { expirationTtl: 60 * 60 * 24 * 62 } : {};
    await env.QUOTA_KV.put(key, String(cap), opts);
    console.log(`[quota] ${engine}/${period} marked exhausted (zero results) — set to cap (${cap})`);
  } catch (err) {
    console.warn(`[quota] exhaust-mark failed for ${engine}/${period} — ${err.message}`);
  }
}

// --- Zero-result streak tracking (SEARCHER-ONLY, same scope as
// setQuotaExhausted above) -----------------------------------------------
//
// A single empty response from a primary engine isn't a reliable signal
// on its own — a genuinely narrow query can look identical to an
// exhausted quota. So instead of exhausting on the first empty response,
// this counts CONSECUTIVE empty responses per engine; three in a row is
// what actually triggers setQuotaExhausted. Any non-empty response resets
// the streak to 0 — one good pull clears the slate.
//
// This streak is deliberately NOT scoped to the same monthly/total period
// as the quota counter above — it's tracking recent call-to-call
// behavior, not a billing period, so it gets its own short-lived key
// (1-day TTL) that can't linger stale for months.
const ZERO_STREAK_THRESHOLD = 3;
const ZERO_STREAK_TTL = 60 * 60 * 24; // 1 day — plenty for "recent calls", short enough not to go stale

function zeroStreakKey(engine) {
  return `zerostreak:${engine}`;
}

// Increments an engine's consecutive-empty-response counter and returns
// the new count. Fails open (returns 0, i.e. "no streak yet") if QUOTA_KV
// isn't bound or a read/write fails — same fail-open contract as the rest
// of this file, since a broken streak counter should never block search.
export async function incrementZeroStreak(env, engine) {
  if (!env.QUOTA_KV) return 0;
  const key = zeroStreakKey(engine);
  try {
    const raw = await env.QUOTA_KV.get(key);
    const count = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
    await env.QUOTA_KV.put(key, String(count), { expirationTtl: ZERO_STREAK_TTL });
    return count;
  } catch (err) {
    console.warn(`[quota] zero-streak increment failed for ${engine} — ${err.message}`);
    return 0;
  }
}

// Clears an engine's streak — called on any non-empty response so a
// single good pull undoes prior empty ones rather than letting them
// accumulate across unrelated queries.
export async function resetZeroStreak(env, engine) {
  if (!env.QUOTA_KV) return;
  try {
    await env.QUOTA_KV.delete(zeroStreakKey(engine));
  } catch (err) {
    console.warn(`[quota] zero-streak reset failed for ${engine} — ${err.message}`);
  }
}

export { ZERO_STREAK_THRESHOLD };
