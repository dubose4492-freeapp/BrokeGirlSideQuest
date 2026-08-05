// POST /api/restaurant-deals   body: { location, radius }
//
// Searches the OPEN WEB (no domain whitelist) for restaurant deals that are
// either genuinely free, BOGO, or require a minimum purchase of $10 or less
// to get a free item. Classifies with OpenRouter when configured (regex
// fallback otherwise), rejects anything already expired, and dedupes
// repeat listings of the same offer before returning.
//
// Search provider: tries Tavily first, and automatically falls back to
// Brave Search if Tavily errors out or you've hit your Tavily cap.

const MAX_QUALIFYING_PURCHASE = 10; // dollars — "$10 minimum purchase at most"

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

// Chain name -> official domain, so a known chain's "Claim" link always
// goes straight to their real site instead of whatever blog/article the
// offer was found on. Independent/local spots don't have a fixed entry
// here — those get resolved with a quick search instead (see
// findOfficialSite below).
const CHAIN_DOMAINS = {
  "mcdonald": "mcdonalds.com", "chick-fil-a": "chick-fil-a.com", "chickfila": "chick-fil-a.com",
  "wendy": "wendys.com", "taco bell": "tacobell.com", "chipotle": "chipotle.com",
  "starbucks": "starbucks.com", "dunkin": "dunkindonuts.com", "popeyes": "popeyes.com",
  "subway": "subway.com", "panera": "panerabread.com", "sonic": "sonicdrivein.com",
  "arby": "arbys.com", "burger king": "bk.com", "kfc": "kfc.com",
  "panda express": "pandaexpress.com", "wingstop": "wingstop.com", "culver": "culvers.com",
  "dairy queen": "dairyqueen.com", "domino": "dominos.com", "pizza hut": "pizzahut.com",
  "papa john": "papajohns.com", "little caesars": "littlecaesars.com", "zaxby": "zaxbys.com",
  "bojangles": "bojangles.com", "ihop": "ihop.com", "denny": "dennys.com",
  "cracker barrel": "crackerbarrel.com", "applebee": "applebees.com", "chili's": "chilis.com",
  "chilis": "chilis.com", "olive garden": "olivegarden.com", "outback": "outback.com",
  "buffalo wild wings": "buffalowildwings.com", "five guys": "fiveguys.com",
  "in-n-out": "in-n-out.com", "in n out": "in-n-out.com", "whataburger": "whataburger.com",
  "jack in the box": "jackinthebox.com", "del taco": "deltaco.com", "qdoba": "qdoba.com",
  "jimmy john": "jimmyjohns.com", "firehouse subs": "firehousesubs.com",
  "jersey mike": "jerseymikes.com", "raising cane": "raisingcanes.com",
  "shake shack": "shakeshack.com", "carl's jr": "carlsjr.com", "carls jr": "carlsjr.com",
  "hardee": "hardees.com", "krystal": "krystal.com", "checkers": "checkers.com",
  "rally's": "rallys.com", "rallys": "rallys.com", "long john silver": "ljsilvers.com",
  "captain d": "captainds.com", "boston market": "bostonmarket.com",
  "moe's": "moes.com", "moes southwest": "moes.com", "el pollo loco": "elpolloloco.com",
  "church's chicken": "churchschicken.com", "churchs chicken": "churchschicken.com",
  "wingstreet": "pizzahut.com", "einstein bros": "einsteinbros.com",
  "smoothie king": "smoothieking.com", "jamba juice": "jamba.com",
  "auntie anne": "auntieannes.com", "cinnabon": "cinnabon.com",
  "baskin robbins": "baskinrobbins.com", "cold stone": "coldstonecreamery.com"
};
const CHAIN_DOMAIN_LIST = Object.values(CHAIN_DOMAINS);

// Chain key -> proper display name, so the "store" shown on the card is the
// actual restaurant name ("McDonald's") instead of whatever domain the
// deal happened to be posted on ("somefoodblog.com").
const CHAIN_DISPLAY_NAMES = {
  "mcdonald": "McDonald's", "chick-fil-a": "Chick-fil-A", "chickfila": "Chick-fil-A",
  "wendy": "Wendy's", "taco bell": "Taco Bell", "chipotle": "Chipotle",
  "starbucks": "Starbucks", "dunkin": "Dunkin'", "popeyes": "Popeyes",
  "subway": "Subway", "panera": "Panera Bread", "sonic": "Sonic Drive-In",
  "arby": "Arby's", "burger king": "Burger King", "kfc": "KFC",
  "panda express": "Panda Express", "wingstop": "Wingstop", "culver": "Culver's",
  "dairy queen": "Dairy Queen", "domino": "Domino's", "pizza hut": "Pizza Hut",
  "papa john": "Papa John's", "little caesars": "Little Caesars", "zaxby": "Zaxby's",
  "bojangles": "Bojangles", "ihop": "IHOP", "denny": "Denny's",
  "cracker barrel": "Cracker Barrel", "applebee": "Applebee's", "chili's": "Chili's",
  "chilis": "Chili's", "olive garden": "Olive Garden", "outback": "Outback Steakhouse",
  "buffalo wild wings": "Buffalo Wild Wings", "five guys": "Five Guys",
  "in-n-out": "In-N-Out Burger", "in n out": "In-N-Out Burger", "whataburger": "Whataburger",
  "jack in the box": "Jack in the Box", "del taco": "Del Taco", "qdoba": "Qdoba",
  "jimmy john": "Jimmy John's", "firehouse subs": "Firehouse Subs",
  "jersey mike": "Jersey Mike's", "raising cane": "Raising Cane's",
  "shake shack": "Shake Shack", "carl's jr": "Carl's Jr.", "carls jr": "Carl's Jr.",
  "hardee": "Hardee's", "krystal": "Krystal", "checkers": "Checkers",
  "rally's": "Rally's", "rallys": "Rally's", "long john silver": "Long John Silver's",
  "captain d": "Captain D's", "boston market": "Boston Market",
  "moe's": "Moe's Southwest Grill", "moes southwest": "Moe's Southwest Grill",
  "el pollo loco": "El Pollo Loco", "church's chicken": "Church's Chicken",
  "churchs chicken": "Church's Chicken", "wingstreet": "WingStreet",
  "einstein bros": "Einstein Bros. Bagels", "smoothie king": "Smoothie King",
  "jamba juice": "Jamba", "auntie anne": "Auntie Anne's", "cinnabon": "Cinnabon",
  "baskin robbins": "Baskin-Robbins", "cold stone": "Cold Stone Creamery"
};
// Reverse map (domain -> chain key) so a result already hosted on the
// chain's own site (e.g. an official mcdonalds.com press page) resolves to
// the display name too, not just results found on third-party blogs.
const DOMAIN_TO_CHAIN_KEY = Object.fromEntries(
  Object.entries(CHAIN_DOMAINS).map(([key, domain]) => [domain, key])
);
const BLOCKED_CLAIM_DOMAINS = [
  "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com", "reddit.com",
  "yelp.com", "tripadvisor.com", "wikipedia.org", "pinterest.com", "youtube.com",
  "linkedin.com", "doordash.com", "grubhub.com", "ubereats.com"
];

function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }
function looksFree(text) { return /\bfree\b/i.test(text || ""); }
function looksBogo(text) { return /\bbogo\b|buy\s*one[,]?\s*get\s*one/i.test(text || ""); }
function isKnownChain(text) { const t = (text || "").toLowerCase(); return KNOWN_CHAINS.some(c => t.includes(c)); }
// Finds a known chain's official domain mentioned in the page text (not
// just the KNOWN_CHAINS name match used for the [LOCAL] tag).
function findChainDomain(text) {
  const t = (text || "").toLowerCase();
  for (const [name, domain] of Object.entries(CHAIN_DOMAINS)) {
    if (t.includes(name)) return domain;
  }
  return null;
}

// Resolves the display name to show under the deal: a known chain's proper
// name ("McDonald's") when we can detect one — either because the article
// itself is hosted on the chain's own domain, or because the chain is
// named in the offer text — otherwise falls back to the source page's
// hostname (best available signal for an independent/local spot).
function resolveStoreName(raw, combinedText) {
  const sourceDomain = hostname(raw.url);
  const domainChainKey = DOMAIN_TO_CHAIN_KEY[sourceDomain];
  if (domainChainKey) return CHAIN_DISPLAY_NAMES[domainChainKey];

  const t = (combinedText || "").toLowerCase();
  for (const [key, display] of Object.entries(CHAIN_DISPLAY_NAMES)) {
    if (t.includes(key)) return display;
  }
  return sourceDomain;
}

function extractRequirementType(text) {
  const t = (text || "").toLowerCase();
  if (looksBogo(t)) return "bogo";
  if (/no purchase (necessary|required)/.test(t)) return "no_purchase";
  if (extractMinPurchase(t) != null) return "min_purchase";
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
// Looks for "spend/with a purchase of/minimum purchase of $X" style phrasing
// and returns the dollar amount, or null if no purchase requirement is stated.
function extractMinPurchase(text) {
  const t = text || "";
  const patterns = [
    /(?:spend|with (?:a |any )?purchase of|minimum purchase of|purchase of)\s*\$?\s?(\d+(?:\.\d{2})?)/i,
    /\$\s?(\d+(?:\.\d{2})?)\s*(?:minimum|purchase|order)/i
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function parseExpiryDate(text) {
  if (!text) return null;
  const cleaned = text.replace(/^(expires?|through|until|ends?)\b/i, "").trim();
  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) return parsed;
  const md = cleaned.match(/([A-Za-z]{3,9})\s+(\d{1,2})/);
  if (md) {
    const now = new Date();
    const guess = new Date(`${md[1]} ${md[2]}, ${now.getFullYear()}`);
    if (!isNaN(guess.getTime())) {
      if (guess < now) guess.setFullYear(now.getFullYear() + 1);
      return guess;
    }
  }
  return null;
}
function isExpired(expiryText) {
  const d = parseExpiryDate(expiryText);
  if (!d) return false;
  return d.getTime() < Date.now();
}

// Freshness ceiling — anything with a known publish date older than this
// gets dropped before it's even classified. This is enforced by us, not by
// Tavily/Brave's own recency params, because Tavily's `days` filter only
// actually applies when topic="news" — without it, "days" is silently
// ignored, which is why old posts (e.g. a July 2nd listing) were slipping
// through even with days:7 set.
const MAX_RESULT_AGE_DAYS = 5;

function isStale(dateVal, maxDays) {
  if (!dateVal) return false; // no date signal at all — can't verify age, so don't punish it
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return false;
  const ageDays = (Date.now() - d.getTime()) / 86400000;
  return ageDays > maxDays;
}

// When a result has no reliable published_date/page_age metadata, try to
// read a date straight out of the page text — "Posted July 2, 2026",
// "Updated: 8/1/2026", "As of July 2" bylines, or a dateline at the very
// start of the content ("July 2, 2026 — Chick-fil-A is offering..."). This
// deliberately requires an explicit posted/updated/as-of cue (or a leading
// dateline) so it doesn't accidentally grab an offer's EXPIRY date instead.
function extractMentionedDate(text) {
  if (!text) return null;
  const patterns = [
    /\b(?:posted|published|updated|last updated|as of)\b[:\-]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i,
    /\b(?:posted|published|updated|last updated|as of)\b[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }
  // Leading dateline, e.g. "July 2, 2026 — Some blog post text..."
  const dateline = text.slice(0, 60).match(/^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})\s*[-–—:]/);
  if (dateline) {
    const d = new Date(dateline[1]);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function getEffectiveDate(r) {
  return r.publishedDate || extractMentionedDate(r.content) || extractMentionedDate(r.title);
}

// Drop stale results and sort freshest-first, so if the LLM or regex path
// ever has to pick among near-duplicate offers, it favors the newer one.
// Uses real metadata when available, falling back to a date read out of
// the page text itself when it isn't.
function filterAndSortByFreshness(results, maxDays) {
  return results
    .map(r => ({ ...r, effectiveDate: getEffectiveDate(r) }))
    .filter(r => !isStale(r.effectiveDate, maxDays))
    .sort((a, b) => {
      if (!a.effectiveDate) return 1;
      if (!b.effectiveDate) return -1;
      return new Date(b.effectiveDate) - new Date(a.effectiveDate);
    });
}

// Dedupe repeat listings of the same offer (same store + same offer text
// showing up from multiple URLs/search hits).
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const normTitle = (it.title || "").toLowerCase().replace(/^\[local\]\s*/, "").replace(/[^a-z0-9]/g, "");
    const key = `${(it.store || "").toLowerCase()}|${normTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------- Regex fallback classification ----------
function regexClassify(results) {
  return results
    .map(raw => {
      const combinedText = (raw.content || "") + " " + (raw.title || "");
      const isBogo = looksBogo(combinedText);
      const minPurchase = extractMinPurchase(combinedText);
      const qualifiesFree = looksFree(combinedText) && !/\$\s?\d+(\.\d{2})?/.test(combinedText.replace(/free/gi, ""));
      const qualifiesMinPurchase = minPurchase != null && minPurchase <= MAX_QUALIFYING_PURCHASE && looksFree(combinedText);

      if (!isBogo && !qualifiesFree && !qualifiesMinPurchase) return null;

      const expires = extractExpiry(raw.content);
      if (isExpired(expires)) return null;

      const isLocal = !isKnownChain(combinedText);
      let price = null;
      if (isBogo) price = "BOGO Free";
      else if (qualifiesMinPurchase) price = `Free w/ $${minPurchase.toFixed(2)} purchase`;

      const { claimUrl, blogUrl } = resolveClaimFromText(raw, combinedText);

      return {
        id: raw.url,
        title: (isLocal ? "[LOCAL] " : "") + (raw.title || "Untitled offer"),
        store: resolveStoreName(raw, combinedText),
        url: raw.url,
        price,
        isFree: true,
        isLocal,
        requirementType: extractRequirementType(combinedText),
        expires,
        claimUrl,
        blogUrl,
        category: "restaurant"
      };
    })
    .filter(Boolean);
}

// Cheap, no-search-call resolution: is the source page already the chain's
// own official domain, or does the text name a known chain we have a
// domain for? Leaves claimUrl null (to be resolved with a real search in
// onRequestPost) only for independent/local spots we can't map directly.
function resolveClaimFromText(raw, combinedText) {
  const sourceDomain = hostname(raw.url);
  if (CHAIN_DOMAIN_LIST.includes(sourceDomain)) {
    return { claimUrl: raw.url, blogUrl: null };
  }
  const knownDomain = findChainDomain(combinedText);
  if (knownDomain) {
    return { claimUrl: `https://www.${knownDomain}`, blogUrl: raw.url };
  }
  return { claimUrl: null, blogUrl: raw.url };
}

// ---------- LLM classification ----------
async function openRouterClassify(env, results) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today's date is ${today}. You are reviewing restaurant/food deal search results pulled from the open web. For EACH snippet below, decide:
- qualifies: true ONLY if the offer is one of:
  (a) a genuinely FREE item with no purchase required,
  (b) a BOGO ("buy one get one") free offer, or
  (c) an item that's free/added at no extra cost when you spend $${MAX_QUALIFYING_PURCHASE} or less (e.g. "free dessert with any $10 purchase").
  A plain discount, a percentage off, a priced combo, a regular menu mention, an offer requiring MORE than $${MAX_QUALIFYING_PURCHASE} spend, or an offer whose stated end date is before today does NOT qualify.
- title: a short clean description of the actual offer.
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "bogo", "min_purchase", "unknown".
- minPurchase: the dollar amount required to spend if requirementType is "min_purchase", else null.
- isLocal: true if this is an independent/local restaurant, false if it's a well-known national/regional chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "qualifies": true, "title": "...", "requirementType": "bogo", "minPurchase": null, "isLocal": false, "expires": null}, ...]

Snippets:
${snippetText}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 1500 })
  });
  if (!res.ok) throw new Error(`OpenRouter classification failed (${res.status}).`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || "").trim().replace(/^```json\s*|```$/g, "");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  return parsed
    .filter(p => p && p.qualifies && results[p.index])
    .map(p => {
      const raw = results[p.index];
      let price = null;
      if (p.requirementType === "bogo") price = "BOGO Free";
      else if (p.requirementType === "min_purchase" && p.minPurchase != null) price = `Free w/ $${Number(p.minPurchase).toFixed(2)} purchase`;
      const combinedText = (p.title || raw.title || "") + " " + (raw.content || "");
      const { claimUrl, blogUrl } = resolveClaimFromText(raw, combinedText);
      return {
        id: raw.url,
        title: (p.isLocal ? "[LOCAL] " : "") + (p.title || raw.title || "Untitled offer"),
        store: resolveStoreName(raw, combinedText),
        url: raw.url,
        price,
        isFree: true,
        isLocal: !!p.isLocal,
        requirementType: p.requirementType || "unknown",
        expires: p.expires || null,
        claimUrl,
        blogUrl,
        category: "restaurant"
      };
    });
}

// ---------- Search providers: Tavily first, Brave as fallback ----------
async function tavilySearch(env, query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY, query, max_results: 12,
      search_depth: "advanced", include_raw_content: true, days: 7
      // no include_domains — searches the whole web now
    })
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

async function braveSearch(env, query) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=12&freshness=pw`, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brave search failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const results = (data.web && data.web.results) || [];
  return results.map(r => ({
    title: r.title, url: r.url, content: r.description || "", publishedDate: r.page_age || null
  }));
}

async function searchWithFallback(env, query) {
  if (!env.TAVILY_API_KEY && !env.BRAVE_API_KEY) {
    throw new Error("Search isn't configured on the server yet (missing TAVILY_API_KEY and BRAVE_API_KEY).");
  }
  if (env.TAVILY_API_KEY) {
    try {
      const results = await tavilySearch(env, query);
      return { results, provider: "tavily" };
    } catch (tavilyErr) {
      if (!env.BRAVE_API_KEY) throw tavilyErr;
      const results = await braveSearch(env, query); // let this one throw if it also fails
      return { results, provider: "brave" };
    }
  }
  const results = await braveSearch(env, query);
  return { results, provider: "brave" };
}

// For independent/local spots we don't have a domain mapped, spend one
// extra search to find their real site — kept to the final, deduped list
// so this doesn't multiply into a search per raw result.
async function findOfficialSite(env, name) {
  if (!name) return null;
  try {
    const { results } = await searchWithFallback(env, `${name} restaurant official website`);
    const hit = (results || []).find(r => {
      const h = hostname(r.url);
      return h !== "Web" && !BLOCKED_CLAIM_DOMAINS.some(b => h.includes(b));
    });
    return hit ? hit.url : null;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { location, radius } = body;
  if (!location) return json({ error: "location is required." }, 400);

  const query = `free food OR BOGO "buy one get one free" OR "free with $${MAX_QUALIFYING_PURCHASE} purchase" OR "free with any purchase" deal app reward loyalty restaurant fast food near ${location} within ${radius} miles`;

  let results, provider;
  try {
    const search = await searchWithFallback(env, query);
    results = search.results;
    provider = search.provider;
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  if (!results.length) return json({ results: [], provider });

  results = filterAndSortByFreshness(results, MAX_RESULT_AGE_DAYS);
  if (!results.length) return json({ results: [], provider, note: `All results were older than ${MAX_RESULT_AGE_DAYS} days.` });

  let classified = null;
  if (env.OPENROUTER_API_KEY) {
    try {
      classified = await openRouterClassify(env, results);
    } catch (err) {
      // fall through to regex below
    }
  }
  if (!classified) classified = regexClassify(results);

  let finalResults = dedupeItems(classified);
  finalResults = await Promise.all(finalResults.map(async item => {
    if (item.claimUrl) return item; // already resolved to a known chain or its own domain
    const name = item.title.replace(/^\[LOCAL\]\s*/, "");
    const officialUrl = await findOfficialSite(env, name);
    item.claimUrl = officialUrl || item.url;
    item.blogUrl = officialUrl ? item.url : null;
    return item;
  }));

  return json({ results: finalResults, usedLLM: !!env.OPENROUTER_API_KEY, provider });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
