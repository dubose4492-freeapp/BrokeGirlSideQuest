// functions/_shared/search-providers.js
//
// Shared search-provider layer, built around a STRICT SEQUENTIAL TIER
// system: only the currently-active tier's engines are ever called. The
// next tier is never touched until the active tier's primary engine has
// used up its free-tier quota — tracked for real in KV via quota.js, not
// approximated. This replaced an earlier "fire every engine every scan"
// design; that mode is gone, this is the whole search layer now.
//
// Twelve tiers now, primaries in this order (each tier's parallel extras —
// Gemini/OpenAI/Google CSE, plus SearXNG in the terminal tier — omitted
// below for brevity, see TIER_DEFS for the exact list per tier):
//   Monthly-renewing (resets automatically, tried first):
//     Tier 1  — Tavily        (1,000/mo)
//     Tier 2  — ContextWire   (1,000/mo)
//     Tier 3  — Firecrawl     (1,000 credits/mo, ~500 searches)
//     Tier 4  — Exa           ($10/mo recurring credit, ~1,000 calls)
//     Tier 5  — Linkup        ($5/mo recurring credit, ~1,000 calls, after a 4,000-query signup bonus)
//     Tier 6  — Zenserp       (50/mo)
//   One-time (never resets — bump the *_LIMIT env var if you upgrade):
//     Tier 7  — Serper.dev    (2,500 total)
//     Tier 8  — Searlo        (3,000 total)
//     Tier 9  — SearchApi.io  (100 total)
//     Tier 10 — Value SERP    (100 total)
//     Tier 11 — Serpent API   (10 total)
//   Terminal (no key, never exhausted):
//     Tier 12 — DuckDuckGo (scrape) + SearXNG (only if self-hosted, see searxngSearch)
//
// Deliberately NOT wired in, and why:
//   - Parallel Search's free tier is MCP-protocol-only (search.parallel.ai/mcp,
//     no plain REST endpoint) — not something a normal fetch() call can hit
//     reliably, and this app has no MCP client. Skipped rather than guessed at.
//   - InfoMesh is a decentralized P2P Python package (libp2p/Kademlia DHT) —
//     it needs real TCP sockets and a Python runtime, neither of which a
//     Cloudflare Worker (V8 isolate, JS only) can do. Not portable here.
//   - The "DuckDuckGo Python trick" (duckduckgo_search) is the same idea as
//     duckduckgoSearch() below, just in Python — already covered.
//   - Search1API, Olostep, NewsCatcher weren't verified against live docs
//     before this was wired up — ask if you want any of them added next.
//
// Each tier's engines are called IN PARALLEL and merged (same merge/dedupe
// behavior the old searchAllSources() had) — it's only the tier-to-tier
// progression that's sequential, not the calls within one tier. A tier is
// skipped entirely if its primary engine isn't configured (no key set);
// Gemini/OpenAI/Google CSE inside a tier are just cross-checking extras and
// are silently dropped from that tier's parallel call if their own keys
// aren't configured — they never block tier selection.
//
// Quota bookkeeping is keyed off each tier's PRIMARY engine only (Tavily,
// Serper, Exa) — Gemini/OpenAI/Google CSE ride along in whichever tier is
// active without being quota-tracked themselves, matching the tier spec
// above. Google's Custom Search JSON API does have its own free-tier cap
// (100 queries/DAY, then billed) — same as OpenAI having no free tier at
// all — but since it's an unmetered ride-along rather than a tier's
// primary, this app doesn't track that usage; a 429 once you're over it
// just drops out of that one scan's result merge like any other transient
// engine failure. Caps for every PRIMARY engine, all overridable via env
// vars (see TIER_DEFS's capEnv/defaultCap for the authoritative list),
// with conservative built-in defaults:
//   TAVILY_MONTHLY_LIMIT       (default 1000)  — resets monthly
//   CONTEXTWIRE_MONTHLY_LIMIT  (default 1000)  — resets monthly
//   FIRECRAWL_MONTHLY_LIMIT    (default 500)   — resets monthly (1,000 credits/mo ÷ ~2 credits/search)
//   EXA_CALL_LIMIT             (default 1000)  — resets monthly (approximated call-count budget, see below)
//   LINKUP_MONTHLY_LIMIT       (default 1000)  — resets monthly (approximated call-count budget, same idea as Exa)
//   ZENSERP_MONTHLY_LIMIT      (default 50)    — resets monthly
//   SERPER_TOTAL_LIMIT         (default 2500)  — one-time free-tier total, never resets
//   SEARLO_TOTAL_LIMIT         (default 3000)  — one-time free-tier total, never resets
//   SEARCHAPI_IO_TOTAL_LIMIT   (default 100)   — one-time free-tier total, never resets
//   VALUESERP_TOTAL_LIMIT      (default 100)   — one-time free-tier total, never resets
//   SERPENT_API_TOTAL_LIMIT    (default 10)    — one-time free-tier total, never resets
// Exa and Linkup's free tiers are both a one-time/recurring DOLLAR credit,
// not a call count, and neither exposes a live "credit remaining" endpoint
// — both are approximated as a call-count budget the same way. Set the
// matching env var explicitly once you know your actual per-call cost if
// the 1000-call default drifts from what your plan's credit actually buys.
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

// Google Custom Search JSON API — Google's own, ToS-compliant search API
// (distinct from Serper.dev, which is a third-party proxy in front of
// Google's consumer search results; this one calls Google directly).
// Needs TWO env vars, not one: GOOGLE_CSE_API_KEY (from Google Cloud
// Console) and GOOGLE_CSE_ENGINE_ID (the "cx" value from a Programmable
// Search Engine configured at programmablesearchengine.google.com set to
// search the whole web). Free tier is 100 queries/DAY (not monthly, not a
// one-time total) — after that Google returns 429s, which this treats
// like any other engine failure: this is a ride-along extra, not a
// tier's primary, so one 429 just drops Google CSE from that scan's
// result merge, same as an unconfigured or briefly-down Gemini/OpenAI
// would. No separate quota-tracking key was added in quota.js for this —
// same reasoning as OpenAI having no free-tier tracking: it's an
// unmetered extra, cost/cap is whatever Google's dashboard says. Unlike
// Serper (Google-bucket-only tbs=qdr:d/w/m/y) or the grounding-tool-based
// Gemini/OpenAI (natural-language date hints only), the real API supports
// an exact day count via `dateRestrict=dN`, so this is the most precise
// of the bunch on recency.
export async function googleCseSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10, days } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({
    key: env.GOOGLE_CSE_API_KEY,
    cx: env.GOOGLE_CSE_ENGINE_ID,
    q: query + siteFilter,
    num: String(Math.min(maxResults, 10)) // CSE hard-caps at 10 results per request, no way to ask for more in one call
  });
  if (days) params.set("dateRestrict", `d${days}`);
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google Custom Search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const items = data.items || [];
  return items.map(r => ({ title: r.title, url: r.link, content: r.snippet || "", publishedDate: null }));
}

// Firecrawl — AI-first search+scrape API (docs.firecrawl.dev). Free tier is
// 1,000 credits/month, no card required at signup; a plain (unscraped)
// search costs 2 credits per 10 results, so this is roughly 500 searches/
// month before you'd need to pay. Only ONE env var needed: FIRECRAWL_API_KEY
// (a Bearer token, "fc-..."). No scrapeOptions are requested here — we only
// want the lightweight title/description/url search hit (matching every
// other engine's shape), not full-page markdown, since scraping each result
// would burn credits far faster for no benefit to the classifier step
// downstream (which only reads title+snippet text anyway).
export async function firecrawlSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const body = {
    query,
    limit: Math.min(maxResults, 10),
    sources: [{ type: "web" }]
  };
  if (includeDomains && includeDomains.length) body.includeDomains = includeDomains;
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Firecrawl search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const items = (data.data && data.data.web) || [];
  return items.map(r => ({ title: r.title, url: r.url, content: r.description || "", publishedDate: null }));
}

// Linkup — RAG-focused search. Free tier is 4,000 queries at signup, then
// $5/month in RECURRING credits (roughly 1,000+ searches/mo depending on
// depth) — so like Tavily/Firecrawl it's a monthly-renewing tier, not a
// one-time total. depth:"standard" balances quality vs cost; "fast" skips
// the LLM-interpretation step entirely if you want to shave latency/cost
// further (see docs.linkup.so) but standard matches this app's other
// AI-native engines (Tavily/Exa) most closely.
export async function linkupSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const res = await fetch("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.LINKUP_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query,
      depth: "standard",
      outputType: "searchResults",
      ...(includeDomains && includeDomains.length ? { includeDomains } : {})
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Linkup search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = (data.results || []).filter(r => r.type !== "image");
  return results.slice(0, maxResults).map(r => ({
    title: r.name, url: r.url, content: r.content || "", publishedDate: null
  }));
}

// ContextWire — AI-native search built for agents (contextwire.dev), 1,000
// free queries/month, no card. Only ONE env var needed: CONTEXTWIRE_API_KEY.
export async function contextwireSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ q: query + siteFilter });
  const res = await fetch(`https://contextwire.dev/api/search?${params.toString()}`, {
    headers: { "Authorization": `Bearer ${env.CONTEXTWIRE_API_KEY}` }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ContextWire search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.results || [];
  return results.slice(0, maxResults).map(r => ({
    title: r.title, url: r.url, content: r.snippet || r.description || "", publishedDate: null
  }));
}

// Searlo — Google SERP proxy (searlo.tech). Free tier is 3,000 credits at
// signup, one-time (does not renew) — same "use it up, then move on"
// shape as Serper.dev, just a bigger allotment. Only ONE env var needed:
// SEARLO_API_KEY.
export async function searloSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ q: query + siteFilter, num: String(Math.min(maxResults, 10)) });
  const res = await fetch(`https://api.searlo.tech/api/v1/search/web?${params.toString()}`, {
    headers: { "X-API-Key": env.SEARLO_API_KEY }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Searlo search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.organic || [];
  return results.map(r => ({
    title: r.title, url: r.link, content: r.snippet || "", publishedDate: null
  }));
}

// Zenserp — Google SERP scraper (zenserp.com/app.zenserp.com), a small but
// genuinely RECURRING free tier: 50 searches/month on the Hobby plan. Only
// ONE env var needed: ZENSERP_API_KEY.
export async function zenserpSearch(env, query, includeDomains, options = {}) {
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ q: query + siteFilter });
  const res = await fetch(`https://app.zenserp.com/api/v2/search?${params.toString()}`, {
    headers: { "apikey": env.ZENSERP_API_KEY }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Zenserp search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.organic || [];
  return results.map(r => ({
    title: r.title, url: r.url, content: r.description || "", publishedDate: null
  }));
}

// SearchApi.io — multi-engine SERP scraper (Google/Bing/YouTube/Scholar).
// Free tier is 100 queries at signup, one-time. Only ONE env var needed:
// SEARCHAPI_IO_KEY (named with the _IO suffix so it can never collide with
// a differently-shaped "SEARCHAPI_*" var from another provider).
export async function searchApiIoSearch(env, query, includeDomains, options = {}) {
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ engine: "google", q: query + siteFilter, api_key: env.SEARCHAPI_IO_KEY });
  const res = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`SearchApi.io search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.organic_results || [];
  return results.map(r => ({
    title: r.title, url: r.link, content: r.snippet || "", publishedDate: r.date || null
  }));
}

// Value SERP — no-frills Google SERP scraper (valueserp.com). Free tier is
// 100 queries at signup, one-time. Only ONE env var needed: VALUESERP_API_KEY.
export async function valueSerpSearch(env, query, includeDomains, options = {}) {
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ api_key: env.VALUESERP_API_KEY, q: query + siteFilter });
  const res = await fetch(`https://api.valueserp.com/search?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Value SERP search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.organic_results || [];
  return results.map(r => ({
    title: r.title, url: r.link, content: r.snippet || "", publishedDate: r.date || null
  }));
}

// Serpent API (apiserpent.com) — multi-engine SERP scraper. Free tier is
// only 10 queries at signup, one-time — the smallest allotment in the
// whole chain, which is why it sits second-to-last among the one-time
// tiers, just above the always-on terminal tier. Only ONE env var needed:
// SERPENT_API_KEY.
export async function serpentApiSearch(env, query, includeDomains, options = {}) {
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const params = new URLSearchParams({ q: query + siteFilter, engine: "google" });
  const res = await fetch(`https://apiserpent.com/api/search/quick?${params.toString()}`, {
    headers: { "X-API-Key": env.SERPENT_API_KEY }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Serpent API search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.results?.organic || [];
  return results.map(r => ({
    title: r.title, url: r.url, content: r.snippet || "", publishedDate: null
  }));
}

// SearXNG — open-source, SELF-HOSTED metasearch engine. Not a hosted
// service with a key; this only activates if YOU stand up your own
// instance (Docker, a free-tier VPS, etc. — see searxng.org) and point
// SEARXNG_URL at it (e.g. "https://searx.yourdomain.com"). Once running,
// it's genuinely unlimited/free — no per-query cost, no rate-limited
// vendor — same terminal-tier role as DuckDuckGo, just aggregating 70+
// engines instead of scraping one. Needs `?format=json` enabled in your
// instance's settings.yml (search.formats), which is off by default.
export async function searxngSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const base = env.SEARXNG_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ q: query + siteFilter, format: "json" });
  const res = await fetch(`${base}/search?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`SearXNG search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = data.results || [];
  return results.slice(0, maxResults).map(r => ({
    title: r.title, url: r.url, content: r.content || "", publishedDate: r.publishedDate || null
  }));
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
// ---- MONTHLY-RENEWING tiers first (tried in order; roughly biggest/most
// reliable free allotment first) ----
// ---- then ONE-TIME tiers (never reset — bump the *_LIMIT env var if you
// upgrade rather than expecting the counter to clear) ----
// ---- then the always-on TERMINAL tier last ----
const TIER_DEFS = [
  {
    id: "tier1", primaryEngine: "tavily", keyEnv: "TAVILY_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "TAVILY_MONTHLY_LIMIT", defaultCap: 1000, period: "monthly"
  },
  {
    id: "tier2", primaryEngine: "contextwire", keyEnv: "CONTEXTWIRE_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "CONTEXTWIRE_MONTHLY_LIMIT", defaultCap: 1000, period: "monthly"
  },
  {
    id: "tier3", primaryEngine: "firecrawl", keyEnv: "FIRECRAWL_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "FIRECRAWL_MONTHLY_LIMIT", defaultCap: 500, period: "monthly" // 1,000 credits/mo, ~2 credits per search
  },
  {
    id: "tier4", primaryEngine: "exa", keyEnv: "EXA_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "EXA_CALL_LIMIT", defaultCap: 1000, period: "monthly" // $10/mo recurring credit, approximated as a call count — see exaSearch
  },
  {
    id: "tier5", primaryEngine: "linkup", keyEnv: "LINKUP_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "LINKUP_MONTHLY_LIMIT", defaultCap: 1000, period: "monthly" // $5/mo recurring credit, approximated as a call count, same shape as Exa
  },
  {
    id: "tier6", primaryEngine: "zenserp", keyEnv: "ZENSERP_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "ZENSERP_MONTHLY_LIMIT", defaultCap: 50, period: "monthly"
  },
  {
    id: "tier7", primaryEngine: "serper", keyEnv: "SERPER_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "SERPER_TOTAL_LIMIT", defaultCap: 2500, period: "total"
  },
  {
    id: "tier8", primaryEngine: "searlo", keyEnv: "SEARLO_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "SEARLO_TOTAL_LIMIT", defaultCap: 3000, period: "total"
  },
  {
    id: "tier9", primaryEngine: "searchapiio", keyEnv: "SEARCHAPI_IO_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "SEARCHAPI_IO_TOTAL_LIMIT", defaultCap: 100, period: "total"
  },
  {
    id: "tier10", primaryEngine: "valueserp", keyEnv: "VALUESERP_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "VALUESERP_TOTAL_LIMIT", defaultCap: 100, period: "total"
  },
  {
    id: "tier11", primaryEngine: "serpentapi", keyEnv: "SERPENT_API_KEY",
    extraEngines: ["gemini", "openai", "googlecse"],
    capEnv: "SERPENT_API_TOTAL_LIMIT", defaultCap: 10, period: "total"
  },
  {
    id: "tier12", primaryEngine: "duckduckgo", keyEnv: null, // no key — always available, the terminal floor
    extraEngines: ["gemini", "openai", "googlecse", "searxng"],
    capEnv: null, defaultCap: Infinity, period: "total"
  }
];

const ENGINE_FN = {
  tavily: tavilySearch, gemini: geminiGroundedSearch, serper: serperSearch, exa: exaSearch,
  openai: openaiSearch, duckduckgo: duckduckgoSearch, googlecse: googleCseSearch, firecrawl: firecrawlSearch,
  linkup: linkupSearch, contextwire: contextwireSearch, searlo: searloSearch, zenserp: zenserpSearch,
  searchapiio: searchApiIoSearch, valueserp: valueSerpSearch, serpentapi: serpentApiSearch, searxng: searxngSearch
};
const ENGINE_KEY_ENV = {
  tavily: "TAVILY_API_KEY", gemini: "GOOGLE_AI_API_KEY", serper: "SERPER_API_KEY", exa: "EXA_API_KEY",
  openai: "OPENAI_API_KEY", firecrawl: "FIRECRAWL_API_KEY", linkup: "LINKUP_API_KEY",
  contextwire: "CONTEXTWIRE_API_KEY", searlo: "SEARLO_API_KEY", zenserp: "ZENSERP_API_KEY",
  searchapiio: "SEARCHAPI_IO_KEY", valueserp: "VALUESERP_API_KEY", serpentapi: "SERPENT_API_KEY",
  searxng: "SEARXNG_URL" // not a real API key, just an instance URL — see searxngSearch
};

// Google CSE needs TWO env vars (API key + search engine "cx" id), unlike
// every other engine's single key — so this checks it as a special case
// rather than trying to force it through ENGINE_KEY_ENV's one-env-var
// shape. Every other extra engine still just looks up its single key.
function isEngineConfigured(env, name) {
  if (name === "googlecse") return !!(env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_ENGINE_ID);
  const keyEnv = ENGINE_KEY_ENV[name];
  return keyEnv ? !!env[keyEnv] : true;
}

// The frontend's category queries (freebies.js's callers) are written in a
// long, comma-stuffed, natural-language style — e.g. "free toy giveaways
// promotions, free toy drives, kids workshops, LOWES HOMEDEPOT MICHAELS
// LEGO Hasbro toy drives near Nashville within 15 miles". Tavily/Serper/
// Exa and the LLM-grounded Gemini/OpenAI tools all interpret intent behind
// that kind of query fine — they're AI-native. DuckDuckGo/Google CSE/
// Firecrawl are traditional keyword-matching search underneath, though,
// and two things in a query like that actively hurt them:
//   1. "within N miles" is literal text with no real webpage containing
//      that exact phrase — a keyword engine tries to match it verbatim
//      and gets nothing.
//   2. The sheer length/comma-stuffing dilutes keyword overlap toward
//      zero on a traditional AND-style match.
// This strips the distance phrase and trims stacked commas/whitespace so
// these three engines get a query shaped the way they actually search —
// the sorter AIs downstream (llmClassify/llmExtract) still do the real
// qualifying judgment either way, so simplifying the search string here
// costs nothing on the classification side. Serper is deliberately left
// out — it's Tier 2's primary only (never rides along in Tier 4), and
// it's working fine on the original rich query as-is.
const KEYWORD_ENGINES = new Set(["duckduckgo", "googlecse", "firecrawl", "searxng"]);
function simplifyQueryForKeywordEngines(query) {
  return query
    .replace(/\bwithin\s+\d+\s*(miles|mi)\b/gi, "")
    .replace(/\s*,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*,\s*$/, "")
    .trim();
}
function queryForEngine(name, query) {
  return KEYWORD_ENGINES.has(name) ? simplifyQueryForKeywordEngines(query) : query;
}

// This tier's primary engine, plus whichever of its extraEngines are
// actually keyed — duckduckgo needs no key so it's always included when
// it's the primary.
function configuredEngines(env, tier) {
  const engines = [];
  if (tier.primaryEngine === "duckduckgo" || env[tier.keyEnv]) engines.push(tier.primaryEngine);
  for (const name of tier.extraEngines) {
    if (isEngineConfigured(env, name)) engines.push(name);
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
  const settled = await Promise.allSettled(engines.map(name => ENGINE_FN[name](env, queryForEngine(name, query), includeDomains, options)));

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
      const results = await ENGINE_FN[name](env, queryForEngine(name, query), includeDomains, options);
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
