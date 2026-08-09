// POST /api/freebies   body: { category, query, location, radius }
//
// Same pattern as restaurant-deals.js and grocery-price.js, generalized to
// every other tab (clothing, toys, accessories, events, community, mail):
// search the OPEN WEB (no domain whitelist) using the query the client
// already builds per category, classify each result with an LLM (regex
// fallback otherwise), then resolve a real "Claim" link — the actual
// company/organization's own site — separate from whichever blog or
// article the offer was found on. The client shows that source article as
// "See Details" and the resolved link as "Claim".
//
// Roundup posts ("8 stores giving away free stuff this week") mention
// several different companies/orgs in one page — both classification paths
// below extract one offer PER COMPANY/ORG mentioned in a qualifying
// snippet, not just one card per URL.
//
// Search providers: Tavily -> Serper -> Exa -> DuckDuckGo (no key
// needed, last resort). Shared with restaurant-deals.js and
// grocery-price.js so the provider chain lives in one place.
import { searchWithFallback } from "../_shared/search-providers.js";
// LLM providers: OpenRouter -> Groq -> Cerebras -> Mistral -> Google AI
// Studio -> Hugging Face -> Cohere (any ONE configured key unlocks the LLM
// classification path instead of falling straight to the regex fallback).
// Shared with restaurant-deals.js and grocery-price.js.
import { chatWithFallback, chatWithEnsemble, anyLLMConfigured, multipleLLMsConfigured } from "../_shared/llm-providers.js";
// Per-IP rate limiting — see functions/_shared/rate-limit.js for why and
// how generous the limits are. Fails open if RATE_LIMIT_KV isn't bound.
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.js";

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

// Known-good freebie roundup sites. We still search the OPEN WEB (no
// domain whitelist) — this list doesn't restrict results — it just also
// runs an extra domain-scoped pass against these specific sites so their
// posts don't get lost in the general results, and floats anything that
// comes from them to the top of the list with a "trusted source" tag the
// client can badge.
const PRIORITY_SOURCES = {
  "thefreebieguy.com": "The Freebie Guy",
  "heyitsfree.net": "Hey, It's Free!",
  "freestufftimes.com": "Free Stuff Times"
};
function prioritySourceName(url) {
  const h = hostname(url);
  const domain = Object.keys(PRIORITY_SOURCES).find(d => h === d || h.endsWith("." + d));
  return domain ? PRIORITY_SOURCES[domain] : null;
}

function hostname(url) { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Web"; } }
function looksFree(text) { return /\bfree\b/i.test(text || ""); }
// Regex-fallback-only check for the "By Mail" tab's no-shipping-cost rule
// (the LLM path gets the same rule via CATEGORY_EXTRA_RULES.mail above).
// Deliberately narrow — only trips on an explicit shipping/handling fee
// mentioned near a dollar amount, so it doesn't false-positive on offers
// that just happen to say "free shipping" or "shipping included".
function requiresPaidShipping(text) {
  return /\b(shipping|s\s?&\s?h|handling)\b[^.]{0,25}\$\s?\d/i.test(text || "") &&
    !/\bfree\s+(shipping|s\s?&\s?h|handling)\b/i.test(text || "");
}

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
// No fixed brand list here (unlike restaurant-deals.js's chain map), so
// multi-offer extraction leans on a "Brand Name is/are giving away/
// offering ... free" pattern. If a snippet names more than one org this
// way, emit one card per org; otherwise fall back to a single card the
// same way this endpoint always used to.
function findMultipleOrgMentions(text) {
  const pattern = /\b([A-Z][A-Za-z&'.]*(?:\s+[A-Z][A-Za-z&'.]*){0,3})\s+(?:is|are)\s+(?:giving away|offering|handing out)\b[^.]{0,100}?\bfree\b/g;
  const seen = new Set();
  const found = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); found.push(name); }
  }
  return found;
}

// Rough keyword gate used ONLY by the regex fallback (no LLM configured).
// llmClassify already does real category judgment via its prompt
// ("qualifies: true only if genuinely about this category") — this is a
// cheaper stand-in for when no LLM provider is configured, so a roundup
// post surfaced by e.g. the Clothing tab's query doesn't get every
// company in it (Starbucks, Sephora, ...) blindly tagged "clothing" just
// because that's the query that found it.
const CATEGORY_KEYWORDS = {
  clothing: /\b(cloth(?:ing|es)?|apparel|shoes?|sneakers?|jacket|jeans|shirt|dress(?:es)?|outfit|footwear)\b/i,
  // Includes "toy drive"/"kids workshop"/named hardware-store workshop
  // programs alongside plain "toy" mentions — a Lowe's Build and Grow or
  // Home Depot Kids Workshop post often never uses the word "toy" at all
  // (it's a free build-a-craft-kit clinic), so the old toy-word-only regex
  // missed those even though they're exactly what the Toys tab is after.
  toys: /\b(toys?|games?|action figures?|dolls?|lego|playset|toy drive|kids? workshop|build and grow|craft kit)\b/i,
  accessories: /\b(backpacks?|tote bags?|water bottles?|school suppl(?:y|ies)|accessor(?:y|ies)|bags?|sunglasses|jewelry|hat|scarf|glove|mitten|hair clip)\b/i,
  mail: /\b(sample|by mail|mail-?in|free sample)\b/i
};
function matchesCategory(text, category) {
  if (ALWAYS_QUALIFIES.has(category)) return true; // events/community already scoped by their query
  const re = CATEGORY_KEYWORDS[category];
  return re ? re.test(text) : true; // no keyword list defined — don't gate it
}

function regexClassify(results, category) {
  const items = [];
  for (const raw of results) {
    const combinedText = (raw.content || "") + " " + (raw.title || "");
    if (!ALWAYS_QUALIFIES.has(category) && !looksFree(combinedText)) continue;
    if (!matchesCategory(combinedText, category)) continue;
    if (category === "mail" && requiresPaidShipping(combinedText)) continue;

    const expires = extractExpiry(raw.content);
    if (isExpired(expires)) continue;

    const requirementType = extractRequirementType(combinedText);
    const isLocal = /\blocal\b|\bcommunity\b/i.test(combinedText);
    const orgMentions = findMultipleOrgMentions(combinedText);

    if (orgMentions.length > 1) {
      for (const orgName of orgMentions) {
        items.push({
          id: `${raw.url}#${orgName.toLowerCase().replace(/\s+/g, "-")}`,
          title: `Free offer from ${orgName}`,
          orgName,
          store: orgName,
          url: raw.url,
          isFree: true,
          isLocal,
          requirementType,
          expires,
          trustedSource: prioritySourceName(raw.url),
          category
        });
      }
    } else {
      const orgName = orgMentions[0] || raw.title || hostname(raw.url);
      items.push({
        id: raw.url,
        title: raw.title || "Untitled offer",
        orgName,
        store: orgName,
        url: raw.url,
        isFree: true,
        isLocal,
        requirementType,
        expires,
        trustedSource: prioritySourceName(raw.url),
        category
      });
    }
  }
  return items;
}

// ---------- LLM classification ----------
const CATEGORY_HINTS = {
  clothing: "free clothing, shoes, or apparel giveaways/promotions",
  toys: "free toy giveaways, toy drives, kids' craft/build workshops (e.g. Lowe's Build and Grow, Home Depot Kids Workshop, Michaels Make Break), or other free toy promotions",
  accessories: "free backpacks, water bottles, tote bags, school supplies, or any other item that counts as a free accessory (jewelry, sunglasses, hats, hair accessories, etc.)",
  events: "free community events",
  community: "food pantries, community fridges, clothing closets, or other free community resources",
  mail: "free items (not just samples) available by mail"
};
// An extra qualifying rule appended only for categories where "free" alone
// isn't the whole bar — right now just "By Mail", where the app is
// specifically supposed to skip anything that's free-but-you-pay-shipping.
const CATEGORY_EXTRA_RULES = {
  mail: ` A "by mail" offer only counts as qualifying if there's no shipping/handling fee charged to get it — if the item itself is free but the offer requires paying for shipping, set qualifies to false.`
};

// Asks the model to return an "offers" array PER SNIPPET rather than one
// object per snippet, so a roundup post naming several companies/orgs
// yields one qualifying offer object per company/org instead of collapsing
// the whole post into a single card.
async function llmClassify(env, results, category, { ensemble = false } = {}) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 700)}`)
    .join("\n\n");
  const today = new Date().toISOString().slice(0, 10);
  const categoryHint = CATEGORY_HINTS[category] || "free offers";
  const extraRule = CATEGORY_EXTRA_RULES[category] || "";

  const prompt = `Today's date is ${today}. You are reviewing search results about ${categoryHint}. Some snippets describe just one offer/resource; others are "roundup" posts listing several from different companies/organizations — extract EACH qualifying offer separately in that case, one per company/org.

For EACH snippet below, return an "offers" array (empty if nothing in it qualifies). For every offer/resource found in that snippet, include:
- orgName: the specific company, brand, or organization behind it (e.g. "Old Navy", "Second Harvest Food Bank"). Always fill this in if the snippet names one.
- qualifies: true only if it's genuinely about a real free offer/resource in this category (not a paid product, an unrelated article, or something whose stated end date is before today).${extraRule}
- title: a short clean description of that specific offer/resource.
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "unknown".
- isLocal: true if this is a local/independent org or event, false if it's a well-known national brand/chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "offers": [{"orgName": "...", "qualifies": true, "title": "...", "requirementType": "giveaway", "isLocal": false, "expires": null}]}, ...]
If a snippet is a roundup mentioning several companies/orgs, include one object per company/org inside that snippet's "offers" array. If nothing in a snippet qualifies, use an empty array for "offers".

Snippets:
${snippetText}`;

  // Ensemble mode (used when the search step fell back to DuckDuckGo's
  // thinner snippets): run every configured model in parallel and only
  // keep an offer that at least 2 of them independently extracted — a
  // single model misreading a short, low-context snippet gets caught
  // when nothing else corroborates it.
  if (ensemble) {
    let chatResults;
    try {
      chatResults = await chatWithEnsemble(env, prompt, { temperature: 0, maxTokens: 2000 });
    } catch (err) {
      throw new Error(`LLM classification failed: ${err.message}`);
    }
    const parsedLists = chatResults.map(r => parseClassifyResponse(r.text, results, category)).filter(Boolean);
    if (!parsedLists.length) return null;
    if (parsedLists.length === 1) return parsedLists[0]; // only one model actually succeeded — nothing to corroborate against, trust it alone same as non-ensemble mode
    console.log(`[freebies] ensemble: cross-checking ${parsedLists.length} model outputs for ${category}`);
    return mergeCorroborated(parsedLists);
  }

  let text;
  try {
    ({ text } = await chatWithFallback(env, prompt, { temperature: 0, maxTokens: 2000 }));
  } catch (err) {
    throw new Error(`LLM classification failed: ${err.message}`);
  }
  return parseClassifyResponse(text, results, category);
}

// Parses one model's raw JSON response into the same item shape used
// everywhere else in this file. Pulled out of llmClassify so ensemble mode
// can run it against several models' responses independently, then compare
// the results — a parse failure from one model just drops that model's
// vote rather than failing classification entirely.
function parseClassifyResponse(text, results, category) {
  const cleaned = text.replace(/^```json\s*|```$/g, "");
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  const items = [];
  for (const entry of parsed) {
    if (!entry || !results[entry.index]) continue;
    const raw = results[entry.index];
    const offers = Array.isArray(entry.offers) ? entry.offers : [];
    offers.forEach((o, oi) => {
      if (!o || !o.qualifies) return;
      const orgName = o.orgName || raw.title || hostname(raw.url);
      items.push({
        id: `${raw.url}#${oi}`,
        title: o.title || raw.title || "Untitled offer",
        orgName,
        store: orgName,
        url: raw.url,
        isFree: true,
        isLocal: !!o.isLocal,
        requirementType: o.requirementType || "unknown",
        expires: o.expires || null,
        trustedSource: prioritySourceName(raw.url),
        category
      });
    });
  }
  return items;
}

// Keeps an extracted offer only if at least 2 independently-run models both
// found it (matched on source URL + normalized org name) — corroboration on
// thin/ambiguous DuckDuckGo snippets is worth more than trusting any single
// model's read. Field VALUES (expires, requirementType, etc.) are taken
// from whichever model reported the offer first; only the offer's
// EXISTENCE is what's actually being cross-checked here.
function mergeCorroborated(parsedLists) {
  const byKey = new Map();
  for (const list of parsedLists) {
    const seenInThisList = new Set(); // a model repeating its own item shouldn't inflate its corroboration count
    for (const item of list) {
      const key = `${item.url}|${(item.orgName || item.title || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      if (seenInThisList.has(key)) continue;
      seenInThisList.add(key);
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { item, count: 1 });
    }
  }
  return [...byKey.values()].filter(e => e.count >= 2).map(e => e.item);
}

// Resolves the org's real homepage — separate from whatever blog/article
// the offer was found on — so "Claim" always points somewhere legitimate.
// Kept to the final, deduped list of items so it doesn't multiply into a
// search call per raw result (it's now per distinct offer, since roundup
// posts can yield several from the same source URL).
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
  const rl = await checkRateLimit(env, request, "freebies");
  if (!rl.allowed) return rateLimitResponse();

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { category, query } = body;
  if (!category || !query) return json({ error: "category and query are required." }, 400);
  // A real query typed/built by the app is always well under this — this
  // just caps how much text one request can force through search + LLM
  // classification, so it's not a free lever for wasting quota.
  if (typeof query !== "string" || query.length > 300) {
    return json({ error: "query is invalid or too long." }, 400);
  }

  let results, provider;
  try {
    const general = await searchWithFallback(env, query);
    results = general.results;
    provider = general.provider;
  } catch (err) {
    // Log the real, detailed reason server-side (visible via `wrangler
    // pages deployment tail`) — never forward raw provider error text
    // (rate limits, account/billing messages, etc.) to the browser.
    console.error("freebies search failed:", err.message);
    return json({ error: err.publicMessage || "Search is temporarily unavailable. Please try again in a few minutes." }, 502);
  }

  // Best-effort extra pass scoped to the known-good freebie sites, merged
  // into the general pool — if it fails or turns up nothing, the general
  // whole-web results still stand on their own.
  try {
    const priority = await searchWithFallback(env, query, Object.keys(PRIORITY_SOURCES));
    const seen = new Set(results.map(r => r.url));
    for (const r of priority.results) {
      if (!seen.has(r.url)) { seen.add(r.url); results.push(r); }
    }
  } catch { /* ignore — priority pass is a bonus, not a requirement */ }

  if (!results.length) return json({ results: [], provider });

  // NOTE: must NOT use `??` here — CATEGORY_MAX_AGE_DAYS.community is
  // intentionally `null` (skip the freshness filter), and `??` treats
  // null as nullish too, so `null ?? 30` silently became 30. That capped
  // evergreen community resources (food pantries, fridges, closets) at a
  // 30-day window they were never supposed to have.
  const maxAge = (category in CATEGORY_MAX_AGE_DAYS) ? CATEGORY_MAX_AGE_DAYS[category] : 30;
  results = filterAndSortByFreshness(results, maxAge);
  if (!results.length) return json({ results: [], provider, note: "All results were too old." });

  // Float known-good sources to the top of what's left, freshness order
  // preserved within each group.
  results.sort((a, b) => (prioritySourceName(b.url) ? 1 : 0) - (prioritySourceName(a.url) ? 1 : 0));

  let classified = null;
  // Cross-check with multiple models whenever search fell back off the
  // primary tier (Tavily) — Serper and Exa are decent providers, but
  // they're only reached because Tavily's quota is used up, and Serper's
  // Google-snippet text / Exa's truncated page text both give the
  // classifier less to work with than Tavily's full raw content. DuckDuckGo
  // (the true last resort) is the thinnest of all. Any of the three is
  // "not the tier we designed the prompt against," so any of the three
  // gets the same corroboration treatment rather than reserving it for
  // DuckDuckGo alone.
  const searchDegraded = provider !== "tavily";
  const useEnsemble = searchDegraded && multipleLLMsConfigured(env);
  if (anyLLMConfigured(env)) {
    try {
      classified = await llmClassify(env, results, category, { ensemble: useEnsemble });
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

  return json({ results: finalResults, usedLLM: anyLLMConfigured(env), usedEnsemble: useEnsemble, provider });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
