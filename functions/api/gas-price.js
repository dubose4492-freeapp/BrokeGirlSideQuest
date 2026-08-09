// GET /api/gas-price?zip=37083&location=Lafayette%2C%20TN&radius=100
//
// Same shape/contract as grocery-price.js's response — { price, store, url,
// productUrl, blogUrl, provider, usedEnsemble } — but for regular unleaded
// gas instead of a grocery item. There's no Kroger-style official-API side
// here (no free, keyless fuel-price API exists the way Kroger's product API
// does for groceries), so this is just the web-search tier: known gas
// station chain sites + GasBuddy/AAA (both are trusted, frequently-updated
// price aggregators, not stores themselves — kept in the domain list so the
// search can find a current, sourced number even when no chain site itself
// has posted today's price) first, then falls back to the open web exactly
// like grocery-price.js's tier 2.
//
// Client never sees any search/LLM keys — same trust boundary as every
// other endpoint here.
import { searchWithFallback as sharedSearchWithFallback } from "../_shared/search-providers.js";
import { chatWithFallback, chatWithEnsemble, anyLLMConfigured, multipleLLMsConfigured } from "../_shared/llm-providers.js";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.js";

// Real gas station chains, mapped to their own domain so results can be
// restricted to a station's actual site — plus GasBuddy and AAA, which
// aren't stores but are the two most commonly-cited, frequently-refreshed
// crowd-sourced price trackers, so including them in the domain-restricted
// tier 1 pass (instead of only in the open-web tier 2 fallback) gets a
// sourced, current price far more often than chain sites alone, which
// rarely publish per-station pricing on their own domains.
const GAS_STATION_DOMAINS = {
  "Shell": "shell.com", "Chevron": "chevron.com", "ExxonMobil": "exxon.com",
  "BP": "bp.com", "Marathon": "marathon.com", "Circle K": "circlek.com",
  "Speedway": "speedway.com", "QuikTrip": "quiktrip.com", "RaceTrac": "racetrac.com",
  "Murphy USA": "murphyusa.com", "Love's": "loves.com", "Pilot Flying J": "pilotflyingj.com",
  "Wawa": "wawa.com", "Sheetz": "sheetz.com", "Costco Gas": "costco.com",
  "Sam's Club Gas": "samsclub.com", "Kroger Fuel": "kroger.com", "Casey's": "caseys.com",
  "Valero": "valero.com", "Sunoco": "sunoco.com", "Citgo": "citgo.com",
  "GasBuddy": "gasbuddy.com", "AAA": "gasprices.aaa.com"
};
const GAS_CHAINS = Object.keys(GAS_STATION_DOMAINS);
const GAS_DOMAIN_LIST = Object.values(GAS_STATION_DOMAINS);
const DOMAIN_TO_CHAIN = Object.fromEntries(Object.entries(GAS_STATION_DOMAINS).map(([chain, domain]) => [domain, chain]));
// GasBuddy/AAA are aggregators, not the actual station — never label a
// card with them as the "store", even when the domain matched them
// directly (see the two spots below that check this before trusting
// domainChain as the display store name).
const AGGREGATOR_CHAINS = new Set(["GasBuddy", "AAA"]);

function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }

// ---------- Location relevance filter ----------
// The bug this fixes: GAS_STATION_DOMAINS are national chain homepages
// (shell.com, gasbuddy.com, etc.) — restricting a search to those domains
// does NOT restrict it geographically, and the search engines used here
// are keyword-matchers, not geocoders. A query stuffed with 22 chain names
// plus "near Lafayette, TN" can easily come back with a real, current gas
// price... for a station in Ohio, because the page matched on chain name
// and the word "gas" and nothing enforced that Lafayette/TN actually
// appears anywhere in the result. This filter rejects any result that
// doesn't actually mention the target location before a price is ever
// extracted from it, so "cheapest near you" can't silently resolve to
// "cheapest anywhere Google could find."
const STATE_ABBR = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy"
};
// Words too generic to prove a result is actually about the target place
// (a page can say "county" or "near" without being anywhere close).
const LOCATION_STOPWORDS = new Set(["near", "county", "area", "city", "town", "usa", "us"]);

// Pulls out the meaningful place-name tokens from whatever the client sent
// as `location` (a city/state string, or just a raw ZIP) — e.g.
// "Lafayette, TN" -> ["lafayette", "tn", "tennessee"]. Both the abbreviation
// and full state name are included since either could show up in a result.
function locationKeywords(location, zip) {
  const tokens = new Set();
  if (zip) tokens.add(zip.toLowerCase());
  const parts = (location || "").split(/[,\n]/).map(p => p.trim().toLowerCase()).filter(Boolean);
  for (const part of parts) {
    for (const word of part.split(/\s+/)) {
      const clean = word.replace(/[^a-z0-9]/g, "");
      if (clean.length >= 2 && !LOCATION_STOPWORDS.has(clean)) tokens.add(clean);
    }
    if (STATE_ABBR[part]) tokens.add(STATE_ABBR[part]);
    for (const [full, abbr] of Object.entries(STATE_ABBR)) {
      if (abbr === part) tokens.add(full.replace(/\s+/g, ""));
    }
  }
  return [...tokens];
}

function resultMentionsLocation(r, keywords) {
  if (!keywords.length) return true; // nothing usable to match against — don't over-filter
  const text = ((r.title || "") + " " + (r.content || "") + " " + (r.url || "")).toLowerCase();
  return keywords.some(kw => kw.length >= 3 && text.includes(kw));
}

// Keeps only results that actually mention the target location, so a
// price can never be extracted from a page about some other state/city
// just because it matched on chain name or the word "gas". Falls back to
// the unfiltered list only when filtering would wipe out everything AND
// the caller has no further tier to fall back to — callers here always
// have tier 2, so in practice an empty filtered set just means "try the
// open web next" rather than "trust an unrelated result."
function filterByLocation(results, location, zip) {
  const keywords = locationKeywords(location, zip);
  return results.filter(r => resultMentionsLocation(r, keywords));
}

// Gas prices are commonly quoted to a third decimal (e.g. $3.199), unlike
// grocery prices — the regex allows 2 or 3 decimal places accordingly.
function extractLowestPriceRegex(results) {
  let best = null;
  for (const r of results) {
    const combinedText = (r.content || "") + " " + (r.title || "");
    const matches = combinedText.match(/\$\s?\d\.\d{2,3}/g) || [];
    for (const m of matches) {
      const val = parseFloat(m.replace(/[$\s]/g, ""));
      // Sanity-bound to a plausible per-gallon range so an unrelated price
      // mentioned on the same page (a snack, a car wash) can't win.
      if (!isNaN(val) && val >= 1.5 && val <= 8 && (!best || val < best.price)) {
        const domainChain = DOMAIN_TO_CHAIN[hostname(r.url)];
        const chain = (domainChain && !AGGREGATOR_CHAINS.has(domainChain)) ? domainChain : findChainName(combinedText);
        best = { price: val, store: chain || hostname(r.url), chain, url: r.url };
      }
    }
  }
  return best;
}

function findChainName(text) {
  const t = (text || "").toLowerCase();
  for (const chain of GAS_CHAINS) {
    if (AGGREGATOR_CHAINS.has(chain)) continue; // never report the aggregator itself as "the store"
    if (t.includes(chain.toLowerCase())) return chain;
  }
  return null;
}

async function extractLowestPriceLLM(env, results, { ensemble = false, location = null } = {}) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const locationGuard = location
    ? ` Every snippet here has already been pre-filtered to mention "${location}" somewhere, but double check: only use a snippet if it's genuinely about a station in or near ${location}, not a different city/state that happens to share a chain name or a word.`
    : "";
  const prompt = `You are finding the lowest real current price per gallon for regular unleaded gasoline, from these search result snippets.${locationGuard} Ignore prices for premium/diesel unless that's all a snippet gives, ignore prices for unrelated products (snacks, car washes, other cities), and ignore vague "prices range from X to Y" statements unless a specific station price is given.

For the winning snippet, identify the actual STATION BRAND the price is from (e.g. "Shell", "QuikTrip", "Costco") — read this out of the text itself, not the website's domain name. GasBuddy and AAA are price-tracking sites, not stations — if the underlying station brand is named in the text, use that instead. If a specific location is mentioned (e.g. a street or city), include it. If no station brand is stated anywhere, set store to null.

Return ONLY strict JSON, no other text, in this shape:
{"found": true, "price": 3.19, "index": 2, "store": "QuikTrip"}
or, if none of the snippets contain a specific usable gas price:
{"found": false}

"index" must be the snippet number the price came from.

Snippets:
${snippetText}`;

  if (ensemble) {
    let chatResults;
    try {
      chatResults = await chatWithEnsemble(env, prompt, { temperature: 0, maxTokens: 200 });
    } catch (err) {
      throw new Error(`LLM gas price extraction failed: ${err.message}`);
    }
    const parsedList = chatResults.map(r => parsePriceResponse(r.text, results)).filter(Boolean);
    if (!parsedList.length) return null;
    if (parsedList.length === 1) return parsedList[0];
    return corroboratePrice(parsedList);
  }


  let text;
  try {
    ({ text } = await chatWithFallback(env, prompt, { temperature: 0, maxTokens: 200 }));
  } catch (err) {
    throw new Error(`LLM gas price extraction failed: ${err.message}`);
  }
  return parsePriceResponse(text, results);
}

function parsePriceResponse(text, results) {
  const cleaned = text.replace(/^```json\s*|```$/g, "");
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!parsed || !parsed.found || typeof parsed.price !== "number" || !results[parsed.index]) return null;

  const raw = results[parsed.index];
  const domainChain = DOMAIN_TO_CHAIN[hostname(raw.url)];
  if (domainChain && !AGGREGATOR_CHAINS.has(domainChain)) {
    return { price: parsed.price, store: domainChain, chain: domainChain, url: raw.url };
  }
  const chain = findChainName((parsed.store || "") + " " + (raw.content || "") + " " + (raw.title || "")) || null;
  const store = (parsed.store && String(parsed.store).trim()) || chain || hostname(raw.url);
  return { price: parsed.price, store, chain, url: raw.url };
}

function corroboratePrice(parsedList) {
  for (let i = 0; i < parsedList.length; i++) {
    for (let j = i + 1; j < parsedList.length; j++) {
      if (parsedList[i].url === parsedList[j].url && Math.abs(parsedList[i].price - parsedList[j].price) < 0.01) {
        return parsedList[i];
      }
    }
  }
  return null;
}

const GAS_SEARCH_OPTS = { maxResults: 8 };
async function searchWithFallback(env, query, domains) {
  return sharedSearchWithFallback(env, query, domains, GAS_SEARCH_OPTS); // { results, provider }
}

async function extractBest(env, results, useEnsemble, location) {
  if (!results.length) return null;
  if (anyLLMConfigured(env)) {
    try {
      const llmBest = await extractLowestPriceLLM(env, results, { ensemble: useEnsemble, location });
      if (llmBest) return llmBest;
    } catch (err) {
      // fall through to regex
    }
  }
  return extractLowestPriceRegex(results);
}

// Mirrors findOfficialProductPage in grocery-price.js — once we know the
// winning chain, try a second targeted search on that chain's own site so
// "Claim" can point at the station brand's page instead of the blog/
// aggregator page where the price was actually found.
async function findOfficialStationPage(env, chain) {
  const domain = GAS_STATION_DOMAINS[chain];
  if (!domain || AGGREGATOR_CHAINS.has(chain)) return null;
  try {
    const { results } = await searchWithFallback(env, `gas prices site:${domain}`, [domain]);
    return results.length ? results[0].url : null;
  } catch (err) {
    return null;
  }
}

async function getWebSearchGasPrice(env, location, zip, radius) {
  // Kept short and natural rather than stuffed with all 22 chain names —
  // that bloat didn't buy relevance (tier 1 already restricts the domains
  // being searched) and it drowned out the location terms that actually
  // matter for a keyword-matching search engine to key in on ${location}.
  // The ZIP is included explicitly since GasBuddy/AAA-style price pages
  // are usually indexed by ZIP, not by city name alone.
  const query = `cheapest regular unleaded gas price today near ${location}${zip ? ` (ZIP ${zip})` : ""}, within ${radius} miles`;

  // Tier 1 — known gas station chains + GasBuddy/AAA only.
  let officialResults = [], officialProvider = null;
  try {
    ({ results: officialResults, provider: officialProvider } = await searchWithFallback(env, query, GAS_DOMAIN_LIST));
  } catch (err) {
    officialResults = [];
  }
  // Domain-restricted != location-restricted (see filterByLocation above)
  // — every result has to actually mention the target place before a
  // price can be extracted from it, or "cheapest near you" can quietly
  // resolve to "cheapest anywhere in the country."
  officialResults = filterByLocation(officialResults, location, zip);
  const tier1Ensemble = officialProvider && officialProvider !== "tavily" && multipleLLMsConfigured(env);
  let best = await extractBest(env, officialResults, tier1Ensemble, location);
  let usedProvider = best ? officialProvider : null;
  let usedEnsemble = best ? tier1Ensemble : false;

  // Tier 2 — open web fallback, same reasoning as grocery-price.js: tier 1
  // domains often render prices via JS, so a domain-restricted crawl can
  // return real pages with zero extractable price text.
  if (!best) {
    let openResults = [], openProvider = null;
    try {
      ({ results: openResults, provider: openProvider } = await searchWithFallback(env, query, null));
    } catch (err) {
      openResults = [];
    }
    openResults = filterByLocation(openResults, location, zip);
    const tier2Ensemble = openProvider && openProvider !== "tavily" && multipleLLMsConfigured(env);
    best = await extractBest(env, openResults, tier2Ensemble, location);
    usedProvider = best ? openProvider : null;
    usedEnsemble = best ? tier2Ensemble : false;
  }

  if (!best) return null;

  const domainChain = DOMAIN_TO_CHAIN[hostname(best.url)];
  if (domainChain && !AGGREGATOR_CHAINS.has(domainChain)) {
    return { price: best.price, store: domainChain, url: best.url, productUrl: best.url, blogUrl: null, provider: usedProvider, usedEnsemble };
  }

  // Price came from an aggregator (GasBuddy/AAA) or a third-party page —
  // try to resolve an actual station-brand page too, same pattern as
  // grocery-price.js's blog/product-page split.
  const productUrl = best.chain ? await findOfficialStationPage(env, best.chain) : null;
  return {
    price: best.price,
    store: best.store,
    url: productUrl || best.url,
    productUrl,
    blogUrl: best.url,
    provider: usedProvider,
    usedEnsemble
  };
}

// ---------- Entry point ----------
export async function onRequestGet({ request, env }) {
  // Gas is a single lookup per scan (unlike grocery's 11-items-per-scan),
  // so it shares the same lower default limit as freebies/restaurant-deals
  // rather than grocery-price's raised-for-11-calls limit.
  const rl = await checkRateLimit(env, request, "gas-price", { limit: 60 });
  if (!rl.allowed) return rateLimitResponse();

  const { searchParams } = new URL(request.url);
  const zip = searchParams.get("zip");
  const location = searchParams.get("location") || zip;
  const radius = Math.min(100, Math.max(1, parseInt(searchParams.get("radius") || "100", 10)));

  if (!zip) return json({ error: "zip query param is required." }, 400);
  if (zip.length > 20) return json({ error: "zip is invalid or too long." }, 400);

  let result;
  try {
    result = await getWebSearchGasPrice(env, location, zip, radius);
  } catch (err) {
    console.error("gas-price lookup failed:", err.message);
    return json({ error: "Gas price lookup is temporarily unavailable. Please try again in a few minutes." }, 502);
  }

  return json(result || { price: null, store: null, url: null, productUrl: null, blogUrl: null, provider: null, usedEnsemble: false });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
