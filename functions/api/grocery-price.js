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

// Chains explicitly named in the search query so results aren't limited to
// whichever store happens to rank first organically.
const GROCERY_CHAINS = [
  "Walmart", "Kroger", "Publix", "Aldi", "Food Lion", "Save A Lot", "Target",
  "Costco", "Sam's Club", "Winn-Dixie", "Meijer", "Trader Joe's", "Whole Foods",
  "IGA", "Piggly Wiggly", "H-E-B", "Safeway", "Giant Eagle", "Harris Teeter",
  "Sprouts", "Ingles", "Food City", "Dollar General Market"
];

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
  return { price: best, store: "Kroger (official price)", url: "https://www.kroger.com" };
}

// ---------- Web search side (every major chain) ----------
function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }

function extractLowestPriceRegex(results) {
  let best = null;
  for (const r of results) {
    const matches = ((r.content || "") + " " + (r.title || "")).match(/\$\s?\d+(\.\d{2})?/g) || [];
    for (const m of matches) {
      const val = parseFloat(m.replace(/[$\s]/g, ""));
      if (!isNaN(val) && val > 0 && (!best || val < best.price)) {
        best = { price: val, store: hostname(r.url), url: r.url };
      }
    }
  }
  return best;
}

async function extractLowestPriceLLM(env, item, results) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  const prompt = `You are finding the lowest real current price for "${item}" at a grocery store, from these search result snippets. Ignore prices for unrelated products, prices from unrelated categories, or vague/aggregated "prices range from X to Y" statements unless a specific store price is given.

Return ONLY strict JSON, no other text, in this shape:
{"found": true, "price": 3.29, "index": 2}
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
  return { price: parsed.price, store: hostname(raw.url), url: raw.url };
}

// ---------- Search providers: Tavily first, Brave as fallback ----------
async function tavilySearch(env, query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY, query, max_results: 8, search_depth: "advanced"
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Tavily search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  return data.results || [];
}

async function braveSearch(env, query) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
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

async function searchWithFallback(env, query) {
  if (!env.TAVILY_API_KEY && !env.BRAVE_API_KEY) return []; // neither configured — web side just skipped
  if (env.TAVILY_API_KEY) {
    try {
      return await tavilySearch(env, query);
    } catch (tavilyErr) {
      if (!env.BRAVE_API_KEY) throw tavilyErr;
      return await braveSearch(env, query); // let this one throw if it also fails
    }
  }
  return await braveSearch(env, query);
}

async function getWebSearchPrice(env, item, location, radius) {
  const chainList = GROCERY_CHAINS.join(", ");
  const query = `${item} price at ${chainList} grocery store near ${location} within ${radius} miles`;

  const results = await searchWithFallback(env, query);
  if (!results.length) return null;

  if (env.OPENROUTER_API_KEY) {
    try {
      const llmResult = await extractLowestPriceLLM(env, item, results);
      if (llmResult) return llmResult;
    } catch (err) {
      // fall through to regex below
    }
  }
  return extractLowestPriceRegex(results);
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

  return json(winner || { price: null, store: null, url: null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
