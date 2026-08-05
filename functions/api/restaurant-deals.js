// POST /api/restaurant-deals   body: { location, radius }
//
// Runs the restaurant-chain Tavily search, then classifies each result:
//   - With OPENROUTER_API_KEY set: sends all results to an LLM in one batch
//     call to accurately decide which are genuinely free/BOGO offers (vs.
//     regular menu items, unrelated news, etc.), and to tell real chains
//     apart from independent/local spots.
//   - Without it: falls back to the same regex-based detection the client
//     used before, so the feature still works either way.
//
// Either path returns ready-to-render item objects — the client no longer
// does any classification itself for this category.

const RESTAURANT_DOMAINS = [
  "mcdonalds.com", "chick-fil-a.com", "tacobell.com", "chipotle.com", "starbucks.com",
  "dunkindonuts.com", "popeyes.com", "subway.com", "panerabread.com", "sonicdrivein.com",
  "arbys.com", "bk.com", "kfc.com", "pandaexpress.com", "wingstop.com", "culvers.com",
  "dairyqueen.com", "dominos.com", "pizzahut.com", "papajohns.com", "littlecaesars.com",
  "zaxbys.com", "bojangles.com", "ihop.com", "dennys.com", "crackerbarrel.com",
  "applebees.com", "chilis.com", "olivegarden.com", "outback.com", "buffalowildwings.com",
  "fiveguys.com", "in-n-out.com", "whataburger.com", "jackinthebox.com", "deltaco.com",
  "qdoba.com", "jimmyjohns.com", "firehousesubs.com", "jerseymikes.com", "raisingcanes.com"
];
const KNOWN_CHAINS = [
  "mcdonald", "chick-fil-a", "chickfila", "wendy", "taco bell", "chipotle", "starbucks",
  "dunkin", "popeyes", "subway", "panera", "sonic", "arby", "burger king", "kfc",
  "panda express", "wingstop", "culver", "dairy queen", "domino", "pizza hut",
  "papa john", "little caesars", "zaxby", "bojangles", "ihop", "denny", "cracker barrel",
  "applebee", "chili's", "chilis", "olive garden", "outback", "buffalo wild wings",
  "five guys", "in-n-out", "in n out", "whataburger", "jack in the box", "del taco",
  "qdoba", "jimmy john", "firehouse subs", "jersey mike", "raising cane", "shake shack",
  "carl's jr", "carls jr", "hardee", "krystal", "checkers", "rally's", "rallys",
  "long john silver", "captain d", "boston market", "moe's", "moes southwest",
  "el pollo loco", "church's chicken", "churchs chicken", "wingstreet", "einstein bros",
  "smoothie king", "jamba juice", "auntie anne", "cinnabon", "baskin robbins",
  "cold stone", "sonic drive"
];

function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }
function looksFree(text) { return /\bfree\b/i.test(text || ""); }
function looksBogo(text) { return /\bbogo\b|buy\s*one[,]?\s*get\s*one/i.test(text || ""); }
function isKnownChain(text) { const t = (text || "").toLowerCase(); return KNOWN_CHAINS.some(c => t.includes(c)); }
function extractRequirementType(text) {
  const t = (text || "").toLowerCase();
  if (looksBogo(t)) return "bogo";
  if (/no purchase (necessary|required)/.test(t)) return "no_purchase";
  if (/sign[\s-]?up|register|create an account/.test(t)) return "signup";
  if (/loyalty|rewards (app|program|card)/.test(t)) return "loyalty";
  if (/rebate|mail-in|mail in offer/.test(t)) return "rebate";
  if (/giveaway|contest|sweepstakes|enter to win/.test(t)) return "giveaway";
  return "unknown";
}
function extractExpiry(text) {
  const m = (text || "").match(/\b(expires?|through|until|ends?)\b[^.]{0,25}/i);
  return m ? m[0].replace(/^\w+/, w => w[0].toUpperCase() + w.slice(1)) : null;
}
function extractPrice(text) {
  const m = (text || "").match(/\$\s?\d+(\.\d{2})?/);
  return m ? m[0].replace(/\s/, "") : null;
}

// Regex fallback — same logic the client used to run itself.
function regexClassify(results) {
  return results
    .map(raw => {
      const price = extractPrice(raw.content);
      const isBogo = looksBogo(raw.content) || looksBogo(raw.title);
      if (price && !isBogo) return null; // pricing cap: free or BOGO only
      const combined = (raw.title || "") + " " + (raw.content || "");
      const isLocal = !isKnownChain(combined);
      return {
        id: raw.url,
        title: (isLocal ? "[LOCAL] " : "") + (raw.title || "Untitled offer"),
        store: hostname(raw.url),
        url: raw.url,
        price: isBogo ? "BOGO Free" : null,
        isFree: true,
        isLocal,
        requirementType: extractRequirementType(raw.content),
        expires: extractExpiry(raw.content),
        category: "restaurant"
      };
    })
    .filter(Boolean);
}

// LLM classification — one batched call covering all results at once,
// far cheaper and more consistent than one call per result.
async function openRouterClassify(env, results) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  const prompt = `You are reviewing restaurant deal search results. For EACH snippet below, decide:
- qualifies: true only if it is a genuinely FREE item or a BOGO ("buy one get one") free offer. A discount, a percentage off, a priced combo, or a regular menu mention does NOT qualify.
- title: a short clean description of the actual offer (e.g. "Free medium fries with app download").
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "bogo", "unknown".
- isLocal: true if this is an independent/local restaurant, false if it's a well-known national/regional chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "qualifies": true, "title": "...", "requirementType": "bogo", "isLocal": false, "expires": null}, ...]

Snippets:
${snippetText}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 1200 })
  });
  if (!res.ok) throw new Error(`OpenRouter classification failed (${res.status}).`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || "").trim().replace(/^```json\s*|```$/g, "");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; } // caller falls back to regex
  if (!Array.isArray(parsed)) return null;

  return parsed
    .filter(p => p && p.qualifies && results[p.index])
    .map(p => {
      const raw = results[p.index];
      return {
        id: raw.url,
        title: (p.isLocal ? "[LOCAL] " : "") + (p.title || raw.title || "Untitled offer"),
        store: hostname(raw.url),
        url: raw.url,
        price: p.requirementType === "bogo" ? "BOGO Free" : null,
        isFree: true,
        isLocal: !!p.isLocal,
        requirementType: p.requirementType || "unknown",
        expires: p.expires || null,
        category: "restaurant"
      };
    });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { location, radius } = body;
  if (!location) return json({ error: "location is required." }, 400);
  if (!env.TAVILY_API_KEY) return json({ error: "Search isn't configured on the server yet (missing TAVILY_API_KEY)." }, 500);

  const query = `free food OR BOGO "buy one get one free" deal app reward loyalty sign up major fast food chain restaurant near ${location} within ${radius} miles`;
  let tavilyRes;
  try {
    tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY, query, max_results: 8,
        search_depth: "advanced", include_domains: RESTAURANT_DOMAINS, time_range: "week"
      })
    });
  } catch (err) {
    return json({ error: `Could not reach Tavily: ${err.message}` }, 502);
  }
  if (!tavilyRes.ok) {
    const errBody = await tavilyRes.text();
    return json({ error: `Restaurant search failed (${tavilyRes.status}). ${errBody.slice(0, 150)}` }, 502);
  }
  const tavilyData = await tavilyRes.json();
  const results = tavilyData.results || [];
  if (!results.length) return json({ results: [] });

  if (env.OPENROUTER_API_KEY) {
    try {
      const classified = await openRouterClassify(env, results);
      if (classified) return json({ results: classified, usedLLM: true });
    } catch (err) {
      // fall through to regex below rather than failing the whole category
    }
  }
  return json({ results: regexClassify(results), usedLLM: false });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
