// GET /api/grocery-price?item=Eggs&zip=37083&radius=100
// Does the full Kroger flow server-side: OAuth token -> nearest store -> product price.
// Client never sees the Kroger Client ID/Secret or the raw access token.
//
// Token and per-ZIP location ID are cached in module-level variables, which
// persist across requests on a warm edge isolate (best-effort — not
// guaranteed durable, but cuts down on repeat token/location calls in practice).
let cachedToken = null;
let cachedTokenExpiry = 0;
const locationCache = new Map(); // "zip:radius" -> locationId

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

export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);
  const item = searchParams.get("item");
  const zip = searchParams.get("zip");
  const radius = Math.min(100, Math.max(1, parseInt(searchParams.get("radius") || "100", 10)));

  if (!item || !zip) return json({ error: "item and zip query params are required." }, 400);
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) {
    return json({ error: "Kroger isn't configured on the server yet (missing KROGER_CLIENT_ID/SECRET secrets)." }, 500);
  }

  try {
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
    return json({ price: best || null });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
