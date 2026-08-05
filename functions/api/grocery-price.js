// GET /api/grocery-price?item=Eggs&zip=37083&location=Lafayette%2C%20TN&radius=100
//
// Runs two lookups in parallel and returns whichever price is actually lower:
//   1. Kroger's official price (OAuth token -> nearest store -> product price)
//   2. A web search across every major grocery chain (Tavily first, Brave as
//      fallback if Tavily errors/hits its cap) + OpenRouter extraction, or
//      regex extraction if OpenRouter isn't configured
//
// The response is always { price, store, url } so the client can label the
// card with wherever the winning price actually came from. Client never sees
// the Kroger Client ID/Secret, the raw access token, or any search/LLM keys.
//
// Token and per-ZIP location ID are cached in module-level variables, which
// persist across requests on a warm edge isolate (best-effort — not
// guaranteed durable, but cuts down on repeat token/location calls in practice).
let cachedToken = null;
let cachedTokenExpiry = 0;
const locationCache = new Map(); // "zip:radius" -> locationId

// Chains explicitly named in the search query, mapped to their real domain
// so results are restricted to the stores' own websites — not blogs or
// deal-tracker sites that merely mention a price.
const GROCERY_CHAIN_DOMAINS = {
  "Walmart": "walmart.com", "Kroger": "kroger.com", "Publix": "publix.com",
  "Aldi": "aldi.us", "Food Lion": "foodlion.com", "Save A Lot": "save-a-lot.com",
  "Target": "target.com", "Costco": "costco.com", "Sam's Club": "samsclub.com",
  "Winn-Dixie": "winndixie.com", "Meijer": "meijer.com", "Trader Joe's": "traderjoes.com",
  "Whole Foods": "wholefoodsmarket.com", "IGA": "iga.com", "Piggly Wiggly": "pigglywiggly.com",
  "H-E-B": "heb.com", "Safeway": "safeway.com", "Giant Eagle": "gianteagle.com",
  "Harris Teeter": "harristeeter.com", "Sprouts": "sprouts.com", "Ingles": "ingles-markets.com",
  "Food City": "foodcity.com", "Dollar General Market": "dollargeneral.com"
};
const GROCERY_CHAINS = Object.keys(GROCERY_CHAIN_DOMAINS);
const GROCERY_DOMAIN_LIST = Object.values(GROCERY_CHAIN_DOMAINS);
const DOMAIN_TO_CHAIN = Object.fromEntries(Object.entries(GROCERY_CHAIN_DOMAINS).map(([chain, domain]) => [domain, chain]));

async function getToken(env) {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const creds = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
  const res = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${creds}`
    },
    body: "grant_type=client_credentials&scope=product.compact"
  });
  if (!res.ok) throw new Error(`Kroger auth failed (${res.status}). Check the KROGER_CLIENT_ID/SECRET secrets.`);
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
  return cachedToken;
}

async function getLocationId(env, zip, radius) {
  const cacheKey = `${zip}:${radius}`;
  if (locationCache.has(cacheKey)) return locationCache.get(cacheKey);
  const token = await getToken(env);
  const url = `https://api.kroger.com/v1/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.radiusInMiles=${radius}&filter.limit=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Kroger store lookup failed (${res.status}).`);
  const data = await res.json();
  const loc = (data.data || [])[0];
  if (!loc) throw new Error("No Kroger-family store found near that ZIP within radius.");
  locationCache.set(cacheKey, loc.locationId);
  return loc.locationId;
}

// ---------- Kroger side ----------
async function getKrogerPrice(env, item, zip, radius) {
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) return null; // not configured — skip, don't fail the whole request

  const token = await getToken(env);
  const locationId = await getLocationId(env, zip, radius);
  const url = `https://api.kroger.com/v1/products?filter.term=${encodeURIComponent(item)}&filter.locationId=${locationId}&filter.limit=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Kroger product search failed (${res.status}) for ${item}.`);
  const data = await res.json();

  const priced = (data.data || [])
    .map(p => {
      const priceInfo = p.items && p.items[0] && p.items[0].price;
      if (!priceInfo) return null;
      return (priceInfo.promo && priceInfo.promo > 0) ? priceInfo.promo : priceInfo.regular;
    })
    .filter(Boolean)
    .sort((a, b) => a - b);

  const best = priced[0];
  if (!best) return null;
  return { price: best, store: "Kroger (official price)", url: "https://www.kroger.com", productUrl: "https://www.kroger.com", blogUrl: null };
}

// ---------- Web search side (every major chain) ----------
function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }

function extractLowestPriceRegex(results) {
  let best = null;
  for (const r of results) {
    const combinedText = (r.content || "") + " " + (r.title || "");
    const matches = combinedText.match(/\$\s?\d+(\.\d{2})?/g) || [];
    for (const m of matches) {
      const val = parseFloat(m.replace(/[$\s]/g, ""));
      if (!isNaN(val) && val > 0 && (!best || val < best.price)) {
        const chain = findChainName(combinedText) || DOMAIN_TO_CHAIN[hostname(r.url)] || null;
        best = { price: val, store: chain || hostname(r.url), chain, url: r.url };
      }
    }
  }
  return best;
}

// Looks for any known grocery chain name actually mentioned in the page
// text, so the store label reflects the real store ("Walmart") instead of
// just the hosting domain ("offers.com").
function findChainName(text) {
  const t = (text || "").toLowerCase();
  for (const chain of GROCERY_CHAINS) {
    if (t.includes(chain.toLowerCase())) return chain;
  }
  return null;
}

async function extractLowestPriceLLM(env, item, results) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  const prompt = `You are finding the lowest real current price for "${item}" at a grocery store, from these search result snippets. Ignore prices for unrelated products, prices from unrelated categories, or vague/aggregated "prices range from X to Y" statements unless a specific store price is given.

For the winning snippet, also identify the actual STORE the price is from — read this out of the text itself (e.g. "Walmart", "Publix", "Aldi"), not the website's domain name. If a specific location is mentioned (e.g. a street or city), include it (e.g. "Kroger - Main Street"). If no store name is clearly stated in the text, set store to null and the domain will be used instead.

Return ONLY strict JSON, no other text, in this shape:
{"found": true, "price": 3.29, "index": 2, "store": "Walmart"}
or, if none of the snippets contain a specific usable price for this item:
{"found": false}

"index" must be the snippet number the price came from.

Snippets:
${snippetText}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 200 })
  });
  if (!res.ok) throw new Error(`OpenRouter extraction failed (${res.status}).`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || "").trim().replace(/^```json\s*|```$/g, "");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || !parsed.found || typeof parsed.price !== "number" || !results[parsed.index]) return null;

  const raw = results[parsed.index];
  const chain = findChainName((parsed.store || "") + " " + (raw.content || "") + " " + (raw.title || ""))
    || DOMAIN_TO_CHAIN[hostname(raw.url)]
    || null;
  const store = (parsed.store && String(parsed.store).trim()) || chain || hostname(raw.url);
  return { price: parsed.price, store, chain, url: raw.url };
}

// ---------- Search providers: Tavily first, Brave as fallback ----------
// `domains` is optional — pass GROCERY_DOMAIN_LIST to restrict to official
// store sites, or omit/null to search the open web.
async function tavilySearch(env, query, domains) {
  const body = { api_key: env.TAVILY_API_KEY, query, max_results: 8, search_depth: "advanced" };
  if (domains && domains.length) body.include_domains = domains;
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
  return data.results || [];
}

async function braveSearch(env, query, domains) {
  // Brave has no include_domains param — restrict via site: operators instead.
  let q = query;
  if (domains && domains.length) {
    const siteFilter = domains.map(d => `site:${d}`).join(" OR ");
    q = `${query} (${siteFilter})`;
  }
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brave search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = (data.web && data.web.results) || [];
  return results.map(r => ({ title: r.title, url: r.url, content: r.description || "" }));
}

async function searchWithFallback(env, query, domains) {
  if (!env.TAVILY_API_KEY && !env.BRAVE_API_KEY) return []; // neither configured — web side just skipped
  if (env.TAVILY_API_KEY) {
    try {
      return await tavilySearch(env, query, domains);
    } catch (tavilyErr) {
      if (!env.BRAVE_API_KEY) throw tavilyErr;
      return await braveSearch(env, query, domains); // let this one throw if it also fails
    }
  }
  return await braveSearch(env, query, domains);
}

// Two-tier search: try the curated official-chain domains first (so the
// link is the actual grocery store's page whenever possible); if that
// comes back empty, fall back to the open web so we still catch stores
// outside our curated list, deal blogs, etc.
async function searchGroceryWeb(env, query) {
  try {
    const restricted = await searchWithFallback(env, query, GROCERY_DOMAIN_LIST);
    if (restricted.length) return restricted;
  } catch (err) {
    // fall through to open web below
  }
  return searchWithFallback(env, query, null);
}

// If the winning result isn't from one of the official chain domains, try
// a second, targeted search restricted to that chain's own site to find
// the actual product page — so we can offer both a blog link (where the
// price was found) and a direct link to the store's page for the item.
async function findOfficialProductPage(env, item, chain) {
  const domain = GROCERY_CHAIN_DOMAINS[chain];
  if (!domain) return null;
  try {
    const results = await searchWithFallback(env, `${item} site:${domain}`, [domain]);
    return results.length ? results[0].url : null;
  } catch (err) {
    return null;
  }
}

async function getWebSearchPrice(env, item, location, radius) {
  const chainList = GROCERY_CHAINS.join(", ");
  const query = `${item} price at ${chainList} grocery store near ${location} within ${radius} miles`;

  const results = await searchGroceryWeb(env, query);
  if (!results.length) return null;

  let best = null;
  if (env.OPENROUTER_API_KEY) {
    try {
      best = await extractLowestPriceLLM(env, item, results);
    } catch (err) {
      // fall through to regex below
    }
  }
  if (!best) best = extractLowestPriceRegex(results);
  if (!best) return null;

  const isOfficial = !!DOMAIN_TO_CHAIN[hostname(best.url)];
  if (isOfficial) {
    return { price: best.price, store: best.store, url: best.url, productUrl: best.url, blogUrl: null };
  }

  // Price came from a third-party page (blog, deal tracker, etc.) — try to
  // resolve an actual product page on the identified chain's own site too.
  const productUrl = best.chain ? await findOfficialProductPage(env, item, best.chain) : null;
  return {
    price: best.price,
    store: best.store,
    url: productUrl || best.url, // primary link — prefer the real store page when we found one
    productUrl,
    blogUrl: best.url
  };
}

// ---------- Entry point ----------
export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);
  const item = searchParams.get("item");
  const zip = searchParams.get("zip");
  const location = searchParams.get("location") || zip;
  const radius = Math.min(100, Math.max(1, parseInt(searchParams.get("radius") || "100", 10)));

  if (!item || !zip) return json({ error: "item and zip query params are required." }, 400);

  const [krogerResult, webResult] = await Promise.allSettled([
    getKrogerPrice(env, item, zip, radius),
    getWebSearchPrice(env, item, location, radius)
  ]);

  const kroger = krogerResult.status === "fulfilled" ? krogerResult.value : null;
  const web = webResult.status === "fulfilled" ? webResult.value : null;

  if (!kroger && !web && krogerResult.status === "rejected" && webResult.status === "rejected") {
    return json({ error: `${krogerResult.reason.message} / ${webResult.reason.message}` }, 502);
  }

  let winner = null;
  if (kroger && web) winner = web.price < kroger.price ? web : kroger;
  else winner = kroger || web || null;

  return json(winner || { price: null, store: null, url: null, productUrl: null, blogUrl: null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
