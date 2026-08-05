// functions/_shared/search-providers.js
//
// Shared search-provider chain, tried in this order until one succeeds:
//   1. Tavily      (env.TAVILY_API_KEY)
//   2. Serper.dev  (env.SERPER_API_KEY)  — 2,500 queries, one-time free tier
//   3. Exa         (env.EXA_API_KEY)     — $10 credit, one-time free tier
//   4. DuckDuckGo HTML scrape           — no key, no signup, unlimited
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
//   - days: Tavily-only — restrict to results from the last N days

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

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

// Serper.dev — a Google SERP proxy. The free tier is 2,500 queries
// *total*, not monthly, so it's positioned as a third-string fallback
// rather than something to lean on daily.
export async function serperSearch(env, query, includeDomains, options = {}) {
  const { maxResults = 10 } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query + siteFilter, num: maxResults })
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
  const { maxResults = 10 } = options;
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: "auto",
      contents: { text: { maxCharacters: 1000 } },
      ...(includeDomains && includeDomains.length ? { includeDomains } : {})
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
  const { maxResults = 10 } = options;
  const siteFilter = includeDomains && includeDomains.length
    ? ` (${includeDomains.map(d => `site:${d}`).join(" OR ")})` : "";
  const res = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query + siteFilter)}`, {
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
    { name: "serper", key: env.SERPER_API_KEY, fn: serperSearch },
    { name: "exa", key: env.EXA_API_KEY, fn: exaSearch }
  ].filter(p => p.key);

  const failures = [];
  for (const p of providers) {
    try {
      const results = await p.fn(env, query, includeDomains, options);
      return { results, provider: p.name };
    } catch (err) {
      failures.push(`${p.name}: ${err.message}`);
    }
  }

  // Nothing keyed worked (or nothing keyed was configured at all) — fall
  // back to the no-key DuckDuckGo scrape as the last resort.
  try {
    const results = await duckduckgoSearch(env, query, includeDomains, options);
    return { results, provider: "duckduckgo" };
  } catch (ddgErr) {
    failures.push(`duckduckgo: ${ddgErr.message}`);
    const err = new Error(`All search providers failed — ${failures.join(" | ")}`);
    err.publicMessage = "Search is temporarily unavailable. Please try again in a few minutes.";
    throw err;
  }
}
