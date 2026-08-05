// POST /api/freebies   body: { category, query, location, radius }
//
// Same pattern as restaurant-deals.js and grocery-price.js, generalized to
// every other tab (clothing, toys, accessories, events, community, mail):
// search the OPEN WEB (no domain whitelist) using the query the client
// already builds per category, classify each result with OpenRouter (regex
// fallback otherwise), then resolve a real "Claim" link — the actual
// company/organization's own site — separate from whichever blog or
// article the offer was found on. The client shows that source article as
// "See Details" and the resolved link as "Claim".

// Time-based freshness ceiling per category, mirroring the old client-side
// timeRange settings. null = don't filter by age (evergreen resources like
// food pantries / community fridges).
const CATEGORY_MAX_AGE_DAYS = {
  clothing: 30,
  toys: 30,
  accessories: 30,
  events: 14,
  community: null,
  mail: 30
};

// events/community search queries are already narrowly scoped to on-topic
// free resources, so anything that comes back is treated as in-scope
// rather than gated behind a literal "must say free" check the way
// clothing/toys/accessories/mail are.
const ALWAYS_QUALIFIES = new Set(["events", "community"]);

const BLOCKED_CLAIM_DOMAINS = [
  "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com", "reddit.com",
  "yelp.com", "tripadvisor.com", "wikipedia.org", "pinterest.com", "youtube.com", "linkedin.com"
];

function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }
function looksFree(text) { return /\bfree\b/i.test(text || ""); }

function extractRequirementType(text) {
  const t = (text || "").toLowerCase();
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

function isStale(dateVal, maxDays) {
  if (maxDays == null || !dateVal) return false;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) / 86400000 > maxDays;
}
// Reads a date straight out of the page text ("Posted July 2, 2026",
// "Updated: 8/1/2026", a leading dateline) when no reliable
// published_date/page_age metadata came back from the search provider.
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
function filterAndSortByFreshness(results, maxDays) {
  if (maxDays == null) return results;
  return results
    .map(r => ({ ...r, effectiveDate: getEffectiveDate(r) }))
    .filter(r => !isStale(r.effectiveDate, maxDays))
    .sort((a, b) => {
      if (!a.effectiveDate) return 1;
      if (!b.effectiveDate) return -1;
      return new Date(b.effectiveDate) - new Date(a.effectiveDate);
    });
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const normTitle = (it.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const key = `${(it.store || "").toLowerCase()}|${normTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------- Regex fallback classification ----------
function regexClassify(results, category) {
  return results
    .map(raw => {
      const combinedText = (raw.content || "") + " " + (raw.title || "");
      if (!ALWAYS_QUALIFIES.has(category) && !looksFree(combinedText)) return null;

      const expires = extractExpiry(raw.content);
      if (isExpired(expires)) return null;

      return {
        id: raw.url,
        title: raw.title || "Untitled offer",
        orgName: raw.title || hostname(raw.url),
        store: hostname(raw.url),
        url: raw.url,
        isFree: true,
        isLocal: /\blocal\b|\bcommunity\b/i.test(combinedText),
        requirementType: extractRequirementType(combinedText),
        expires,
        category
      };
    })
    .filter(Boolean);
}

// ---------- LLM classification ----------
const CATEGORY_HINTS = {
  clothing: "free clothing, shoes, or apparel giveaways/promotions",
  toys: "free toy giveaways or promotions",
  accessories: "free backpacks, water bottles, tote bags, or school-supply giveaways",
  events: "free community events",
  community: "food pantries, community fridges, clothing closets, or other free community resources",
  mail: "free samples available by mail"
};

async function openRouterClassify(env, results, category) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 500)}`)
    .join("\n\n");
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  const today = new Date().toISOString().slice(0, 10);
  const categoryHint = CATEGORY_HINTS[category] || "free offers";

  const prompt = `Today's date is ${today}. You are reviewing search results about ${categoryHint}. For EACH snippet below, decide:
- qualifies: true only if the snippet is genuinely about a real free offer/resource in this category (not a paid product, an unrelated article, or something whose stated end date is before today).
- title: a short clean description of the actual offer/resource.
- orgName: the specific company, brand, or organization behind it (e.g. "Old Navy", "Second Harvest Food Bank"). Use null if unclear.
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "unknown".
- isLocal: true if this is a local/independent org or event, false if it's a well-known national brand/chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "qualifies": true, "title": "...", "orgName": "...", "requirementType": "giveaway", "isLocal": false, "expires": null}, ...]

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
      return {
        id: raw.url,
        title: p.title || raw.title || "Untitled offer",
        orgName: p.orgName || null,
        store: hostname(raw.url),
        url: raw.url,
        isFree: true,
        isLocal: !!p.isLocal,
        requirementType: p.requirementType || "unknown",
        expires: p.expires || null,
        category
      };
    });
}

// ---------- Search providers: Tavily first, Brave as fallback ----------
async function tavilySearch(env, query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY, query, max_results: 10,
      search_depth: "advanced", include_raw_content: true
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
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
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
      return { results: await tavilySearch(env, query), provider: "tavily" };
    } catch (err) {
      if (!env.BRAVE_API_KEY) throw err;
      return { results: await braveSearch(env, query), provider: "brave" };
    }
  }
  return { results: await braveSearch(env, query), provider: "brave" };
}

// Resolves the org's real homepage — separate from whatever blog/article
// the offer was found on — so "Claim" always points somewhere legitimate.
// Kept to the final, deduped list of items so it doesn't multiply into a
// search call per raw result.
async function findOfficialSite(env, name) {
  if (!name) return null;
  try {
    const { results } = await searchWithFallback(env, `${name} official website`);
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
  const { category, query } = body;
  if (!category || !query) return json({ error: "category and query are required." }, 400);

  let results, provider;
  try {
    const search = await searchWithFallback(env, query);
    results = search.results;
    provider = search.provider;
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  if (!results.length) return json({ results: [], provider });

  results = filterAndSortByFreshness(results, CATEGORY_MAX_AGE_DAYS[category] ?? 30);
  if (!results.length) return json({ results: [], provider, note: "All results were too old." });

  let classified = null;
  if (env.OPENROUTER_API_KEY) {
    try {
      classified = await openRouterClassify(env, results, category);
    } catch (err) {
      // fall through to regex below
    }
  }
  if (!classified) classified = regexClassify(results, category);

  let finalResults = dedupeItems(classified);

  finalResults = await Promise.all(finalResults.map(async item => {
    const name = item.orgName || item.title;
    const officialUrl = await findOfficialSite(env, name);
    item.claimUrl = officialUrl || item.url;
    item.blogUrl = officialUrl && officialUrl !== item.url ? item.url : null;
    delete item.orgName;
    return item;
  }));

  return json({ results: finalResults, usedLLM: !!env.OPENROUTER_API_KEY, provider });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
