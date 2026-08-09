// functions/_shared/search-providers.js
//
// Shared search-provider chain, tried in this order until one succeeds:
//   1. Tavily      (env.TAVILY_API_KEY)
//   2. Gemini       (env.GOOGLE_AI_API_KEY) — Google Search grounding tool.
//                    5,000 free grounded prompts/MONTH on Gemini 3.x
//                    (renews monthly), then $14/1,000. Placed ahead of
//                    Serper/Exa on purpose: those two are one-time,
//                    never-refilling free pools (2,500 total / $10 credit
//                    total), so it's worth spending Gemini's renewing
//                    monthly allotment first and saving the one-time pools
//                    for when Tavily AND Gemini are both out.
//   3. Serper.dev  (env.SERPER_API_KEY)  — 2,500 queries, one-time free tier
//   4. Exa         (env.EXA_API_KEY)     — $10 credit, one-time free tier
//   5. DuckDuckGo HTML scrape           — no key, no signup, unlimited
//
// Every provider function returns the same normalized shape:
//   [{ title, url, content, publishedDate }]
//
// searchWithFallback() walks the list above, skipping any provider whose
// key isn't set in env, and returns the first one that succeeds along with
// which provider answered (used for logging / debugging quota issues).
// DuckDuckGo has no key requirement at all, so it's always tried last as
// the true floor — even on a fresh deploy with zero secrets configured,
// search still works, just without the better relevance of the paid tiers.
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

// Walks the provider chain in order, skipping unconfigured ones, and
// returns { results, provider } from the first one that succeeds.
// DuckDuckGo is always attempted last regardless of what's configured —
// it's the one provider with zero setup cost, so it's the app's real
// floor rather than an opt-in extra.
//
// If every provider fails, the thrown Error carries two things instead of
// just one provider's raw message:
//   - err.message        — a short summary of ALL providers tried and why
//                           each failed (for server-side logs only, via
//                           `wrangler pages deployment tail` — never send
//                           this to the browser, it can contain account/
//                           billing details from the upstream provider)
//   - err.publicMessage  — a generic, safe-to-display sentence for the
//                           end user, with no provider names or raw
//                           upstream text in it
// Callers in onRequestPost handlers should log err.message server-side and
// respond to the client with err.publicMessage.
export async function searchWithFallback(env, query, includeDomains, options = {}) {
  const providers = [
    { name: "tavily", key: env.TAVILY_API_KEY, fn: tavilySearch },
    { name: "gemini", key: env.GOOGLE_AI_API_KEY, fn: geminiGroundedSearch },
    { name: "serper", key: env.SERPER_API_KEY, fn: serperSearch },
    { name: "exa", key: env.EXA_API_KEY, fn: exaSearch }
  ].filter(p => p.key);

  const failures = [];
  console.log(`[search] "${query}" — trying: ${providers.map(p => p.name).join(", ") || "(none keyed)"}, then duckduckgo`);
  for (const p of providers) {
    try {
      const results = await p.fn(env, query, includeDomains, options);
      console.log(`[search] ${p.name} OK — ${results.length} results for "${query}"`);
      return { results, provider: p.name };
    } catch (err) {
      console.warn(`[search] ${p.name} FAILED — ${err.message}`);
      failures.push(`${p.name}: ${err.message}`);
    }
  }

  // Nothing keyed worked (or nothing keyed was configured at all) — fall
  // back to the no-key DuckDuckGo scrape as the last resort.
  try {
    const results = await duckduckgoSearch(env, query, includeDomains, options);
    console.log(`[search] duckduckgo OK — ${results.length} results for "${query}"`);
    return { results, provider: "duckduckgo" };
  } catch (ddgErr) {
    console.warn(`[search] duckduckgo FAILED — ${ddgErr.message}`);
    failures.push(`duckduckgo: ${ddgErr.message}`);
    const err = new Error(`All search providers failed — ${failures.join(" | ")}`);
    err.publicMessage = "Search is temporarily unavailable. Please try again in a few minutes.";
    throw err;
  }
}
