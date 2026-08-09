// functions/_shared/search-providers.js
//
// Shared search-provider layer, built around a STRICT SEQUENTIAL TIER
// system: only the currently-active tier's engines are ever called. The
// next tier is never touched until the active tier's primary engine has
// used up its free-tier quota — tracked for real in KV via quota.js, not
// approximated. This replaced an earlier "fire every engine every scan"
// design; that mode is gone, this is the whole search layer now.
//
//   Tier 1 — Tavily + Gemini (grounded search) + OpenAI (web_search tool)
//   Tier 2 — Serper.dev + OpenAI (web_search tool)          [once Tavily's quota is used up]
//   Tier 3 — Exa + Gemini (grounded search) + OpenAI (web_search tool)  [once Serper's quota is used up]
//   Tier 4 — DuckDuckGo (scrape) + Gemini + OpenAI          [once Exa's quota is used up — terminal, unlimited]
//
// Each tier's engines are called IN PARALLEL and merged (same merge/dedupe
// behavior the old searchAllSources() had) — it's only the tier-to-tier
// progression that's sequential, not the calls within one tier. A tier is
// skipped entirely if its primary engine isn't configured (no key set);
// Gemini/OpenAI inside a tier are just cross-checking extras and are
// silently dropped from that tier's parallel call if their own keys aren't
// configured — they never block tier selection.
//
// Quota bookkeeping is keyed off each tier's PRIMARY engine only (Tavily,
// Serper, Exa) — Gemini/OpenAI ride along in whichever tier is active
// without being quota-tracked themselves, matching the tier spec above.
// Caps, all overridable via env vars, with a conservative built-in default:
//   TAVILY_MONTHLY_LIMIT  (default 1000)   — resets monthly
//   SERPER_TOTAL_LIMIT    (default 2500)   — one-time free-tier total, never resets
//   EXA_CALL_LIMIT        (default 1000)   — Exa's free tier is a one-time
//     $10 CREDIT, not a call count, and there's no live "credit remaining"
//     endpoint to check — this approximates it as a call-count budget.
//     Set EXA_CALL_LIMIT explicitly once you know your actual Exa pricing
//     if this default drifts from what $10 actually buys you.
// See functions/_shared/quota.js for how usage is persisted (KV, fails
// open — an unbound QUOTA_KV means the tier system can't track usage and
// effectively stays on Tier 1 forever; see that file's header).
//
// Two entry points, same as before:
//
// searchWithFallback() — cheap, narrow, single-answer lookups (e.g. "find
// this one company's official site"). Tries the active tier's engines in
// order (primary first), and only spills into the NEXT tier if every
// engine in the active tier fails outright — a resilience fallback for
// real failures, distinct from (and never a substitute for) the
// quota-driven tier advancement above. Only counts against quota when the
// primary engine itself is the one that actually returns results.
//
// searchAllSources() — the main per-scan result list used by freebies.js /
// restaurant-deals.js / grocery-price.js / gas-price.js. Fires the active
// tier's engines in parallel, merges/de-dupes by URL same as before. If
// that tier comes back completely empty, tries the next tier down as the
// same kind of resilience fallback (never blocks a scan just because one
// tier's engines all timed out), all the way down to the DuckDuckGo
// terminal tier, which is always available.
//
// Every provider function returns the same normalized shape:
//   [{ title, url, content, publishedDate }]
//
// `includeDomains` (optional array) scopes a search to specific sites —
// used for the priority-source pass in freebies.js / restaurant-deals.js,
// and for the official-chain-domain pass in grocery-price.js.
// `options` (optional): { maxResults, days }
//   - maxResults: how many results to request (provider default ~10)
//   - days: restrict to results from the last N days. Every provider now
//     honors this in whatever form it natively supports (Tavily: exact
//     `days`; Serper/DuckDuckGo: nearest Google-style day/week/month/year
//     bucket; Exa: exact `startPublishedDate` cutoff) — it's no longer
//     Tavily-only, so a fallback hop doesn't silently drop the recency
//     requirement the way it used to. Gemini has no native `days`/
//     `maxResults` knob for grounding — see geminiGroundedSearch below for
//     how those are approximated instead.

import { getQuotaUsage, incrementQuotaUsage } from "./quota.js";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

// Google (and DuckDuckGo, which mirrors the same bucket values) only
// support coarse day/week/month/year recency buckets, not an exact N-day
// cutoff like Tavily/Exa do — this rounds a `days` value UP to the
// smallest bucket that still covers it, so results are never older than
// requested, just possibly a bit fresher than strictly necessary.
function daysToGoogleBucket(days) {
  if (days <= 1) return "d";
  if (days <= 7) return "w";
  if (days <= 31) return "m";
  return "y";
}

export async function tavilySearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const body = {
    api_key: env.TAVILY_API_KEY,
    query,
    max_results: maxResults,
    search_depth: "advanced",
    include_raw_content: true,
    ...(includeDomains && includeDomains.length ? { include_domains: includeDomains } : {}),
    ...(days ? { days } : {})
  };
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Tavily search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title, url: r.url, content: r.content, publishedDate: r.published_date || null
  }));
}

// Gemini — not a traditional search API. Google Search grounding is a TOOL
// on top of a normal chat call: you send a natural-language prompt with
// tools: [{ google_search: {} }], and the model decides whether/how to
// search, then returns ONE synthesized answer plus groundingMetadata
// listing the real source URLs it drew from (groundingChunks) and which
// stretch of the answer text came from which source (groundingSupports).
//
// That's a different shape than Tavily/Serper/Exa (which each return N
// independent {title,url,snippet} hits for a keyword query), so this
// reshapes it to match: one output "result" per real source URL Gemini
// cited, with that source's content set to just the portion of the answer
// actually attributed to it (via groundingSupports) — falling back to the
// full answer text for a source if no specific segment was attributed to
// it. This keeps every other provider function, and everything downstream
// that classifies these results, unaware anything is different here.
//
// No native `includeDomains`/`days`/`maxResults` knobs on the grounding
// tool itself (unlike Tavily/Serper/Exa) — includeDomains and days get
// folded into the natural-language prompt as instructions instead (the
// model generally respects this, but not with the hard guarantee a real
// API parameter gives), and maxResults just truncates the returned list
// after the fact.
export async function geminiGroundedSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const model = env.GOOGLE_AI_MODEL || "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_AI_API_KEY}`;

  const constraints = [
    includeDomains && includeDomains.length ? `Only use results from these sites: ${includeDomains.join(", ")}.` : "",
    days ? `Only include information from roughly the last ${days} days.` : ""
  ].filter(Boolean).join(" ");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${query}${constraints ? " " + constraints : ""}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 }
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini grounded search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const answerText = candidate?.content?.parts?.map(p => p.text || "").join("") || "";
  const grounding = candidate?.groundingMetadata;
  const chunks = grounding?.groundingChunks || [];
  if (!answerText || !chunks.length) return []; // ungrounded/empty answer — nothing usable to return

  // Build chunk-index -> attributed-text-segments map from groundingSupports.
  const segmentsByChunk = {};
  for (const support of grounding?.groundingSupports || []) {
    const text = support.segment?.text;
    if (!text) continue;
    for (const idx of support.groundingChunkIndices || []) {
      (segmentsByChunk[idx] ||= []).push(text);
    }
  }

  return chunks.slice(0, maxResults).map((chunk, i) => ({
    title: chunk.web?.title || "Gemini search result",
    url: chunk.web?.uri || "",
    content: (segmentsByChunk[i] || [answerText]).join(" "),
    publishedDate: null
  })).filter(r => r.url);
}

// OpenAI — like Gemini above, not a traditional N-results search API. The
// Responses API's built-in `web_search` tool lets the model search the web
// as part of answering a prompt, then returns one synthesized answer plus
// `annotations` of type `url_citation` on the output text — each one a
// {url, title, start_index, end_index} pointing at the real source and
// which stretch of the answer text came from it. Same idea as Gemini's
// groundingChunks/groundingSupports, different field names.
//
// This reshapes that into the same {title, url, content, publishedDate}
// list every other provider returns: one result per distinct cited URL,
// with that source's `content` set to just the slice of the answer text
// attributed to it (via start_index/end_index), falling back to the full
// answer if a citation has no indices.
//
// No native includeDomains/days/maxResults knobs on the web_search tool
// itself, so — same as the Gemini function — includeDomains/days get
// folded into the natural-language prompt as instructions instead, and
// maxResults just truncates the returned list after the fact.
export async function openaiSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const model = env.OPENAI_MODEL || "gpt-5.4";

  const constraints = [
    includeDomains && includeDomains.length ? `Only use results from these sites: ${includeDomains.join(", ")}.` : "",
    days ? `Only include information from roughly the last ${days} days.` : ""
  ].filter(Boolean).join(" ");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: `${query}${constraints ? " " + constraints : ""}`,
      tools: [{ type: "web_search" }]
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI web search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();

  const message = (data.output || []).find(o => o.type === "message");
  const textPart = (message?.content || []).find(c => c.type === "output_text");
  const answerText = textPart?.text || data.output_text || "";
  const citations = (textPart?.annotations || []).filter(a => a.type === "url_citation");
  if (!answerText || !citations.length) return []; // ungrounded/empty answer — nothing usable to return

  // Dedup by URL (a source can be cited more than once), keep first-seen
  // order, and slice out just the text attributed to each citation.
  const seen = new Map();
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    const segment = (typeof c.start_index === "number" && typeof c.end_index === "number")
      ? answerText.slice(c.start_index, c.end_index)
      : answerText;
    seen.set(c.url, { title: c.title || "ChatGPT search result", url: c.url, content: segment, publishedDate: null });
  }
  return Array.from(seen.values()).slice(0, maxResults);
}

// Serper.dev — a Google SERP proxy. The free tier is 2,500 queries
// *total*, not monthly, so it's positioned after Gemini's renewing
// monthly allotment rather than something to lean on daily.
export async function serperSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query + siteFilter,
      num: maxResults,
      ...(days ? { tbs: `qdr:${daysToGoogleBucket(days)}` } : {})
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Serper search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.organic || [];
  return results.map(r => ({
    title: r.title, url: r.link, content: r.snippet || "", publishedDate: r.date || null
  }));
}

// Exa — neural/semantic search. $10 free credit, one-time. Asked to return
// page text directly (contents.text) so we don't need a second fetch per
// result the way a plain links-only search would require.
export async function exaSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: "auto",
      contents: { text: { maxCharacters: 1000 } },
      ...(includeDomains && includeDomains.length ? { includeDomains } : {}),
      ...(days ? { startPublishedDate: new Date(Date.now() - days * 86400000).toISOString() } : {})
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Exa search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.results || [];
  return results.map(r => ({
    title: r.title, url: r.url, content: (r.text || "").slice(0, 500), publishedDate: r.publishedDate || null
  }));
}

// DuckDuckGo — no API key, no signup, effectively unlimited. There's no
// official free web-search API behind this (DDG's public API is
// instant-answers only, not web results), so this scrapes their no-JS
// HTML results page instead. It's the most fragile provider here — if
// DuckDuckGo changes their markup this quietly returns fewer/zero results
// rather than throwing — which is why it's the last resort, not the
// default, even though it's the only one that never runs out of quota.
// Headers are set to look like an ordinary browser request rather than a
// script — DDG (like most sites) is more likely to block an obvious
// bot User-Agent than a standard Chrome one.
export async function duckduckgoSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const dfParam = days ? `&df=${daysToGoogleBucket(days)}` : "";
  const res = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query + siteFilter)}${dfParam}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed (${res.status}).`);
  }
  const html = await res.text();
  return parseDdgHtml(html).slice(0, maxResults);
}

// Minimal, dependency-free scrape of DDG's HTML results page. Each result
// block looks roughly like:
//   <a class="result__a" href="...">Title</a> ... <a class="result__snippet" ...>snippet text</a>
// DDG's href is usually a redirect wrapper
// (`//duckduckgo.com/l/?uddg=<encoded-real-url>&...`), so unwrap that to
// get the actual destination site rather than linking back through DDG.
function parseDdgHtml(html) {
  const results = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const url = unwrapDdgRedirect(m[1]);
    const title = stripTags(m[2]);
    const content = stripTags(m[3]);
    if (url) results.push({ title, url, content, publishedDate: null });
  }
  return results;
}

function unwrapDdgRedirect(href) {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const u = new URL(absolute);
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : absolute;
  } catch {
    return href;
  }
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// ---------- Tier definitions ----------
// `primaryEngine` is what quota is tracked against and what decides
// whether this tier is "exhausted". `keyEnv` is the env var that must be
// set for the primary engine (and therefore this tier) to be usable at
// all — a tier with an unconfigured primary is skipped entirely, same as
// how individual providers used to be skipped when unkeyed. `extraEngines`
// are the cross-checking engines that ride along in this tier's parallel
// call; each is only actually included if ITS OWN key is configured, but
// their absence never disqualifies the tier itself.
const TIER_DEFS = [
  {
    id: "tier1", primaryEngine: "tavily", keyEnv: "TAVILY_API_KEY",
    extraEngines: ["gemini", "openai"],
    capEnv: "TAVILY_MONTHLY_LIMIT", defaultCap: 1000, period: "monthly"
  },
  {
    id: "tier2", primaryEngine: "serper", keyEnv: "SERPER_API_KEY",
    extraEngines: ["openai"],
    capEnv: "SERPER_TOTAL_LIMIT", defaultCap: 2500, period: "total"
  },
  {
    id: "tier3", primaryEngine: "exa", keyEnv: "EXA_API_KEY",
    extraEngines: ["gemini", "openai"],
    capEnv: "EXA_CALL_LIMIT", defaultCap: 1000, period: "total"
  },
  {
    id: "tier4", primaryEngine: "duckduckgo", keyEnv: null, // no key — always available, the terminal floor
    extraEngines: ["gemini", "openai"],
    capEnv: null, defaultCap: Infinity, period: "total"
  }
];

const ENGINE_FN = { tavily: tavilySearch, gemini: geminiGroundedSearch, serper: serperSearch, exa: exaSearch, openai: openaiSearch, duckduckgo: duckduckgoSearch };
const ENGINE_KEY_ENV = { tavily: "TAVILY_API_KEY", gemini: "GOOGLE_AI_API_KEY", serper: "SERPER_API_KEY", exa: "EXA_API_KEY", openai: "OPENAI_API_KEY" };

// This tier's primary engine, plus whichever of its extraEngines are
// actually keyed — duckduckgo needs no key so it's always included when
// it's the primary.
function configuredEngines(env, tier) {
  const engines = [];
  if (tier.primaryEngine === "duckduckgo" || env[tier.keyEnv]) engines.push(tier.primaryEngine);
  for (const name of tier.extraEngines) {
    if (env[ENGINE_KEY_ENV[name]]) engines.push(name);
  }
  return engines;
}

// Index of the first tier that's both usable (primary engine configured)
// and not yet quota-exhausted. Falls through to the terminal DuckDuckGo
// tier (always usable, never exhausted) if every earlier tier is either
// unconfigured or used up.
async function resolveActiveTierIndex(env) {
  for (let i = 0; i < TIER_DEFS.length - 1; i++) {
    const tier = TIER_DEFS[i];
    if (!env[tier.keyEnv]) continue; // primary engine not configured — skip this tier entirely
    const cap = Number(env[tier.capEnv]) || tier.defaultCap;
    const used = await getQuotaUsage(env, tier.primaryEngine, tier.period);
    if (used < cap) return i;
    console.log(`[search] ${tier.id} (${tier.primaryEngine}) exhausted — ${used}/${cap} — advancing`);
  }
  return TIER_DEFS.length - 1; // terminal tier
}

// Fires one tier's configured engines in parallel, merges/de-dupes by URL
// exactly like the old searchAllSources() did, and — only when the
// PRIMARY engine is the one that actually succeeded — records one unit of
// quota usage against it. Cross-checking extras (Gemini/OpenAI riding
// along) are never quota-tracked themselves.
async function runTierParallel(env, tier, query, includeDomains, options) {
  const engines = configuredEngines(env, tier);
  if (!engines.length) return { results: [], providers: [], failedProviders: [], tierId: tier.id };

  console.log(`[search] ${tier.id} — firing in parallel: ${engines.join(", ")}`);
  const settled = await Promise.allSettled(engines.map(name => ENGINE_FN[name](env, query, includeDomains, options)));

  const merged = new Map(); // url -> { title, url, content, publishedDate, sources: [] }
  const succeeded = [];
  const failures = [];
  settled.forEach((s, i) => {
    const name = engines[i];
    if (s.status === "fulfilled") {
      succeeded.push(name);
      for (const r of s.value) {
        if (!r.url) continue;
        const existing = merged.get(r.url);
        if (!existing) {
          merged.set(r.url, { ...r, sources: [name] });
        } else {
          existing.sources.push(name);
          if ((r.content || "").length > (existing.content || "").length) existing.content = r.content;
          existing.publishedDate = existing.publishedDate || r.publishedDate;
        }
      }
    } else {
      failures.push(`${name}: ${s.reason.message}`);
    }
  });

  if (succeeded.includes(tier.primaryEngine)) {
    await incrementQuotaUsage(env, tier.primaryEngine, tier.period);
  }

  console.log(`[search] ${tier.id} — ${succeeded.join(", ") || "(none)"} succeeded, ${merged.size} unique results` + (failures.length ? ` | failed: ${failures.join(" | ")}` : ""));
  return { results: Array.from(merged.values()), providers: succeeded, failedProviders: failures, tierId: tier.id };
}

// Tries a tier's engines one at a time (primary first) and returns the
// first one that succeeds — used by searchWithFallback for cheap, narrow
// single-answer lookups where firing every engine in the tier at once
// would be wasteful.
async function runTierSequential(env, tier, query, includeDomains, options) {
  const engines = configuredEngines(env, tier);
  const failures = [];
  for (const name of engines) {
    try {
      const results = await ENGINE_FN[name](env, query, includeDomains, options);
      if (name === tier.primaryEngine) await incrementQuotaUsage(env, tier.primaryEngine, tier.period);
      return { results, provider: name, tierId: tier.id };
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  return { results: [], provider: null, tierId: tier.id, failures };
}

// Narrow, single-answer lookups (e.g. "find this one company's official
// site"). Uses the currently-active tier's engines, primary first; only
// spills into the NEXT tier down if every engine in the active tier fails
// outright — a resilience fallback for real failures, not a substitute for
// the quota-driven tier advancement in resolveActiveTierIndex.
//
// err.message (server logs only) carries every failure seen; err.publicMessage
// is the safe, generic string to show the end user — same contract as before.
export async function searchWithFallback(env, query, includeDomains, options = {}) {
  const startIndex = await resolveActiveTierIndex(env);
  const failures = [];
  for (let i = startIndex; i < TIER_DEFS.length; i++) {
    const tier = TIER_DEFS[i];
    if (!configuredEngines(env, tier).length) continue;
    const outcome = await runTierSequential(env, tier, query, includeDomains, options);
    if (outcome.failures) failures.push(...outcome.failures);
    if (outcome.results.length) return { results: outcome.results, provider: outcome.provider };
  }
  const err = new Error(`All search tiers failed — ${failures.join(" | ") || "no engines configured"}`);
  err.publicMessage = "Search is temporarily unavailable. Please try again in a few minutes.";
  throw err;
}

// Main per-scan result list used by freebies.js / restaurant-deals.js /
// grocery-price.js / gas-price.js. Fires the active tier's engines in
// parallel and merges them (see runTierParallel). If the active tier comes
// back completely empty, falls through to the next tier down as a
// resilience measure for a single call — it does NOT advance the tier for
// future calls; that's still governed purely by quota usage.
export async function searchAllSources(env, query, includeDomains, options = {}) {
  const startIndex = await resolveActiveTierIndex(env);
  let lastFailures = [];
  for (let i = startIndex; i < TIER_DEFS.length; i++) {
    const tier = TIER_DEFS[i];
    const outcome = await runTierParallel(env, tier, query, includeDomains, options);
    if (outcome.results.length || i === TIER_DEFS.length - 1) {
      if (!outcome.providers.length && !outcome.results.length && i === TIER_DEFS.length - 1) {
        const err = new Error(`All search tiers failed — ${[...lastFailures, ...outcome.failedProviders].join(" | ")}`);
        err.publicMessage = "Search is temporarily unavailable. Please try again in a few minutes.";
        throw err;
      }
      return { results: outcome.results, providers: outcome.providers, failedProviders: outcome.failedProviders, tier: outcome.tierId };
    }
    lastFailures = outcome.failedProviders;
  }
  // Unreachable in practice (the loop always returns at the terminal tier
  // above), but keeps the function's return type honest.
  const err = new Error(`All search tiers failed — ${lastFailures.join(" | ")}`);
  err.publicMessage = "Search is temporarily unavailable. Please try again in a few minutes.";
  throw err;
}
