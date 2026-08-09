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
