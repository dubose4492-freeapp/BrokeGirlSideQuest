// POST /api/restaurant-deals   body: { location, radius }
//
// Searches the OPEN WEB (no domain whitelist) for restaurant deals that are
// either genuinely free, BOGO, or require a minimum purchase of $10 or less
// to get a free item. Classifies with an LLM when configured (regex
// fallback otherwise), rejects anything already expired, and dedupes
// repeat listings of the same offer before returning.
//
// Roundup posts ("12 restaurants with free food this week") mention several
// different restaurants in one page — both classification paths below
// extract one offer PER RESTAURANT mentioned in a qualifying snippet, not
// just one card per URL.
//
// Search providers: strict sequential TIER system (see
// functions/_shared/search-providers.js) — only the currently-ACTIVE
// tier's engines fire per scan, not every configured provider. A later
// tier is only touched once the active tier's primary engine has used up
// its tracked free-tier quota, or as a one-off resilience fallback if the
// active tier's engines all fail outright on a given call. Shared with
// freebies.js and grocery-price.js so the provider chain lives in one
// place. searchAllSources: fires the active tier's engines in parallel
// and merges them — used below (via the local wrapper further down) for
// the main per-scan result list. sharedSearchWithFallback (cheaper,
// stop-at-first-success) still backs the narrow single-answer "find this
// restaurant's official site" lookup.
import { searchWithFallback as sharedSearchWithFallback, searchAllSources as sharedSearchAllSources } from "../_shared/search-providers.js";
// LLM providers: OpenRouter -> Groq -> Cerebras -> Mistral -> Google AI
// Studio -> Hugging Face -> Cohere (any ONE configured key unlocks the LLM
// classification path instead of falling straight to the regex fallback).
// Shared with freebies.js and grocery-price.js.
import { chatWithFallback, chatWithEnsemble, anyLLMConfigured, multipleLLMsConfigured } from "../_shared/llm-providers.js";
// Per-IP rate limiting — see functions/_shared/rate-limit.js for why and
// how generous the limits are. Fails open if RATE_LIMIT_KV isn't bound.
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.js";
// Shared location-text check for the regex fallback path — see that file
// for why this one uses the forgiving variant. Shared with freebies.js,
// which uses the stricter looksLocal() instead.
import { looksLikeWrongLocation } from "../_shared/location.js";

const MAX_QUALIFYING_PURCHASE = 10; // dollars — TOTAL cost cap, tax included (see below)
// Same tax-inclusive treatment as freebies.js's MAX_QUALIFYING_SPEND: the
// $10 cap is the final checkout total, not a pre-tax figure. No ZIP-to-
// tax-rate lookup exists, so a rough US-average estimate is used as a
// safety buffer — a stated pre-tax purchase amount only qualifies if it
// would still clear the cap after adding this estimated rate.
const ESTIMATED_SALES_TAX_RATE = 0.09;
function withinTaxAdjustedCap(spend) {
  return spend != null && spend * (1 + ESTIMATED_SALES_TAX_RATE) <= MAX_QUALIFYING_PURCHASE;
}

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

// Known-good freebie roundup sites (The Freebie Guy specifically tracks
// restaurant app rewards). Still searches the OPEN WEB — this doesn't
// restrict results — it just also runs an extra domain-scoped pass against
// these sites so their posts don't get lost in the general results, and
// floats anything that comes from them to the top with a "trusted source"
// tag the client can badge.
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
function looksBogo(text) { return /\bbogo\b|buy\s*one[,]?\s*get\s*one/i.test(text || ""); }

// Finds a single known chain key mentioned in a piece of text (used for
// the LLM path's clean restaurantName string, or as a fallback name hint).
function matchChainKey(text) {
  const t = (text || "").toLowerCase();
  for (const key of Object.keys(CHAIN_DOMAINS)) {
    if (t.includes(key)) return key;
  }
  return null;
}
// Finds EVERY distinct known chain mentioned in a longer blob of text —
// this is what lets a roundup snippet ("Free stuff at McDonald's, Wendy's,
// and Taco Bell this week") turn into three separate cards instead of one.
// Dedupes by resolved domain so aliases like "chilis"/"chili's" don't
// produce the same chain twice.
function findAllChainKeys(text) {
  const t = (text || "").toLowerCase();
  const seenDomains = new Set();
  const found = [];
  for (const key of Object.keys(CHAIN_DOMAINS)) {
    if (t.includes(key)) {
      const domain = CHAIN_DOMAINS[key];
      if (!seenDomains.has(domain)) { seenDomains.add(domain); found.push(key); }
    }
  }
  return found;
}

// Resolves display name + Claim/See-Details links for an offer where we
// have a clean, already-extracted restaurant name (from the LLM path).
function resolveStoreAndClaim(raw, restaurantName) {
  const sourceDomain = hostname(raw.url);
  const domainChainKey = DOMAIN_TO_CHAIN_KEY[sourceDomain];
  if (domainChainKey) {
    return { store: CHAIN_DISPLAY_NAMES[domainChainKey], claimUrl: raw.url, blogUrl: null };
  }
  const chainKey = matchChainKey(restaurantName);
  if (chainKey) {
    return { store: CHAIN_DISPLAY_NAMES[chainKey], claimUrl: `https://www.${CHAIN_DOMAINS[chainKey]}`, blogUrl: raw.url };
  }
  const store = (restaurantName || "").trim() || sourceDomain;
  return { store, claimUrl: null, blogUrl: raw.url }; // claimUrl resolved later via findOfficialSite
}
// Same, but for the regex fallback path where there's no clean per-offer
// name — chain matching scans the raw snippet text instead.
function resolveStoreAndClaimFromText(raw, combinedText) {
  const sourceDomain = hostname(raw.url);
  const domainChainKey = DOMAIN_TO_CHAIN_KEY[sourceDomain];
  if (domainChainKey) {
    return { store: CHAIN_DISPLAY_NAMES[domainChainKey], claimUrl: raw.url, blogUrl: null };
  }
  return { store: sourceDomain, claimUrl: null, blogUrl: raw.url };
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
  // Only trust a direct Date parse when the text actually names a year —
  // otherwise `new Date("August 15")` silently defaults to the year 2001
  // (a JS Date quirk, not "no year given = invalid"), which then reads as
  // long-expired and wrongly filters out perfectly current offers like
  // "register through August 15" or "deal ends Aug 9". Bare month/day
  // text always goes through the guess-the-year logic below instead.
  // (Same fix as freebies.js's copy of this function — this file keeps
  // its own separate copy rather than sharing one.)
  const hasExplicitYear = /\b\d{4}\b/.test(cleaned);
  if (hasExplicitYear) {
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  const md = cleaned.match(/([A-Za-z]{3,9})\s+(\d{1,2})/);
  if (md) {
    const now = new Date();
    // Stay in the scan's own year — do NOT roll a past-seeming date
    // forward to next year. A bare "expires August 15" almost always
    // means the year the offer/article was actually posted in (i.e. this
    // scan's year), so if that date has already passed, the offer really
    // is expired and isExpired() below should catch it. Bumping to next
    // year here used to un-expire genuinely stale deals (an "expires
    // August 15" snippet scraped in October would silently become "valid
    // until next August"), which is how expired listings were slipping
    // through to the results.
    // (Same fix as freebies.js's copy of this function.)
    const guess = new Date(`${md[1]} ${md[2]}, ${now.getFullYear()}`);
    if (!isNaN(guess.getTime())) return guess;
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
// the search providers' own recency params, because Tavily's `days` filter
// only actually applies when topic="news" — without it, "days" is silently
// ignored, which is why old posts (e.g. a July 2nd listing) were slipping
// through even with days:7 set.
//
// Widened from 7 to 21. A hard 7-day window treats every deal like a
// one-off "this week only" news item, but most of what this tab actually
// wants — a chain's standing app/rewards perk (McDonald's Friday free
// fries, Taco Bell's new-account welcome reward, Subway's BOGO promo
// code) — is a durable, ongoing offer, not something re-published every
// week. A 7-day cutoff was silently dropping those before they ever
// reached classification just because the page hadn't been freshly
// re-crawled. 21 days gives standing offers room to breathe while still
// keeping genuinely stale, months-old roundup posts out.
const MAX_RESULT_AGE_DAYS = 21;

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
//
// A result hosted directly on a known chain's own official domain (e.g.
// mcdonalds.com, sonicdrivein.com) is exempt from the age check entirely —
// a chain's own deals/rewards page IS the current offer by definition,
// the same way food pantries/community fridges are exempt from freebies.js's
// freshness filter. Only third-party blog/roundup posts, which really can
// go stale, get checked against maxDays.
function filterAndSortByFreshness(results, maxDays) {
  return results
    .map(r => ({ ...r, effectiveDate: getEffectiveDate(r) }))
    .filter(r => DOMAIN_TO_CHAIN_KEY[hostname(r.url)] || !isStale(r.effectiveDate, maxDays))
    .sort((a, b) => {
      if (!a.effectiveDate) return 1;
      if (!b.effectiveDate) return -1;
      return new Date(b.effectiveDate) - new Date(a.effectiveDate);
    });
}

// Dedupe repeat listings of the same offer (same store + same offer text
// showing up from multiple URLs/search hits, or the same chain mentioned
// in two different roundup posts).
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
// Extracts one item per DISTINCT known chain mentioned in a qualifying
// snippet (so a roundup post naming several chains yields several cards),
// falling back to a single generic "[LOCAL]" card keyed off the source
// domain when no known chain name is detected in the text at all.
// Also takes `location` so the independent/local branch (no known chain
// matched) can reject a result that explicitly names a different state —
// mirroring the LLM path's own forgiving rule (see looksLikeWrongLocation
// in functions/_shared/location.js): national chain matches stay exempt
// from this check just like the LLM prompt exempts them.
function regexClassify(results, location) {
  const items = [];
  for (const raw of results) {
    const combinedText = (raw.content || "") + " " + (raw.title || "");
    const isBogo = looksBogo(combinedText);
    const minPurchase = extractMinPurchase(combinedText);
    const qualifiesFree = looksFree(combinedText) && !/\$\s?\d+(\.\d{2})?/.test(combinedText.replace(/free/gi, ""));
    const qualifiesMinPurchase = minPurchase != null && withinTaxAdjustedCap(minPurchase) && looksFree(combinedText);
    if (!isBogo && !qualifiesFree && !qualifiesMinPurchase) continue;

    const expires = extractExpiry(raw.content);
    if (isExpired(expires)) continue;

    let price = null;
    if (isBogo) price = "BOGO Free";
    else if (qualifiesMinPurchase) price = `Free w/ $${minPurchase.toFixed(2)} purchase`;

    const matchedChains = findAllChainKeys(combinedText);
    if (matchedChains.length === 0) {
      // No known national chain matched -> this is the independent/local
      // branch, so apply the same forgiving location check the LLM prompt
      // uses: reject only if the snippet explicitly names a different
      // state and doesn't also mention the target area.
      if (looksLikeWrongLocation(combinedText, location)) continue;
      const { store, claimUrl, blogUrl } = resolveStoreAndClaimFromText(raw, combinedText);
      items.push({
        id: raw.url,
        title: "[LOCAL] " + (raw.title || "Untitled offer"),
        store,
        url: raw.url,
        price,
        isFree: true,
        isLocal: true,
        requirementType: extractRequirementType(combinedText),
        expires,
        claimUrl,
        blogUrl,
        trustedSource: prioritySourceName(raw.url),
        category: "restaurant"
      });
    } else {
      for (const chainKey of matchedChains) {
        items.push({
          id: `${raw.url}#${chainKey}`,
          title: raw.title || "Untitled offer",
          store: CHAIN_DISPLAY_NAMES[chainKey],
          url: raw.url,
          price,
          isFree: true,
          isLocal: false,
          requirementType: extractRequirementType(combinedText),
          expires,
          claimUrl: `https://www.${CHAIN_DOMAINS[chainKey]}`,
          blogUrl: raw.url,
          trustedSource: prioritySourceName(raw.url),
          category: "restaurant"
        });
      }
    }
  }
  return items;
}

// ---------- LLM classification ----------
// Asks the model to return an "offers" array PER SNIPPET rather than one
// object per snippet, so a roundup post naming several restaurants yields
// one qualifying offer object per restaurant instead of collapsing the
// whole post into a single card.
// Asks the model to return an "offers" array per snippet (see freebies.js
// for why), now also passing location/radius so the model can flag
// independent/local spots that are clearly outside the requested area.
// NOTE: this is a best-effort TEXTUAL check based on whatever the snippet
// says, not real geocoding/distance math — this app has no lat/lng lookup
// or address parser. It catches the obvious case ("this pizzeria is in
// Portland, Oregon" when the user searched Nashville), not a precise
// radius cutoff. The primary radius signal is still the "within N miles"
// phrase in the search query itself — which, per search-providers.js's
// simplifyQueryForKeywordEngines, is stripped before reaching DuckDuckGo/
// Google CSE/SearXNG, so results from those specific engines get no
// radius hint at either the search OR classification step; this
// snippet-text check is the only backstop for that gap, and it only
// catches cases where the snippet happens to mention a location at all.
async function llmClassify(env, results, location, radius, { ensemble = false } = {}) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 700)}`)
    .join("\n\n");
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today's date is ${today}. You are reviewing restaurant/food deal search results pulled from the open web, for someone near ${location} who wants results within ${radius} miles. Some snippets describe just one deal; others are "roundup" posts listing deals at several different restaurants — extract EACH qualifying deal separately in that case, one per restaurant.

For EACH snippet below, return an "offers" array (empty if nothing in it qualifies). For every deal found in that snippet, include:
- restaurantName: the specific restaurant/chain the deal is at (e.g. "McDonald's", "Antonio's Pizza"). Always fill this in if the snippet names a restaurant.
- qualifies: true ONLY if the offer is one of:
  (a) a genuinely FREE item with no purchase required,
  (b) a BOGO ("buy one get one") free offer, or
  (c) an item that's free/added at no extra cost when you spend $${MAX_QUALIFYING_PURCHASE} or less TOTAL, TAX INCLUDED (e.g. "free dessert with any $10 purchase") — if the snippet's stated spend amount is pre-tax and is close enough to $${MAX_QUALIFYING_PURCHASE} that adding a typical ~9% sales tax would push the real checkout total over it, it does NOT qualify (treat roughly $${MAX_QUALIFYING_PURCHASE} minus that ~9% buffer as the real usable pre-tax ceiling).
  A plain discount, a percentage off, a priced combo, a regular menu mention, an offer requiring MORE than that, or an offer whose stated end date is before today does NOT qualify.
  For a NATIONAL CHAIN (present at locations nationwide), don't reject it on location grounds — it's reasonable to assume they have or will have a nearby location. For an INDEPENDENT/LOCAL restaurant, qualifies is also false if the snippet states or clearly implies it's in a different city, region, or state than ${location} and outside a ${radius}-mile drive — a snippet with no location detail at all should NOT be disqualified on that basis alone (assume it's local to the search area unless it says otherwise).
- title: a short clean description of that specific offer.
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "bogo", "min_purchase", "unknown".
- minPurchase: the dollar amount required to spend if requirementType is "min_purchase", else null.
- isLocal: true if this is an independent/local restaurant, false if it's a well-known national/regional chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "offers": [{"restaurantName": "McDonald's", "qualifies": true, "title": "...", "requirementType": "bogo", "minPurchase": null, "isLocal": false, "expires": null}]}, ...]
If a snippet is a roundup mentioning several restaurants' deals, include one object per restaurant inside that snippet's "offers" array. If nothing in a snippet qualifies, use an empty array for "offers".

Snippets:
${snippetText}`;

  // Ensemble mode (used when the search step fell back to DuckDuckGo's
  // thinner snippets): run every configured model in parallel and only
  // keep a deal that at least 2 of them independently extracted — a single
  // model misreading a short, low-context snippet gets caught when nothing
  // else corroborates it.
  if (ensemble) {
    let chatResults;
    try {
      chatResults = await chatWithEnsemble(env, prompt, { temperature: 0, maxTokens: 2000 });
    } catch (err) {
      throw new Error(`LLM classification failed: ${err.message}`);
    }
    const parsedLists = chatResults.map(r => parseClassifyResponse(r.text, results)).filter(Boolean);
    if (!parsedLists.length) return null;
    if (parsedLists.length === 1) return parsedLists[0]; // only one model actually succeeded — nothing to corroborate against
    console.log(`[restaurant-deals] ensemble: cross-checking ${parsedLists.length} model outputs`);
    return mergeCorroborated(parsedLists);
  }

  let text;
  try {
    ({ text } = await chatWithFallback(env, prompt, { temperature: 0, maxTokens: 2000 }));
  } catch (err) {
    throw new Error(`LLM classification failed: ${err.message}`);
  }
  return parseClassifyResponse(text, results);
}

// Parses one model's raw JSON response into the same item shape used
// everywhere else in this file. Pulled out of llmClassify so ensemble mode
// can run it against several models' responses independently, then compare
// results — a parse failure from one model just drops that model's vote
// rather than failing classification entirely.
function parseClassifyResponse(text, results) {
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
      const minPurchase = o.requirementType === "min_purchase" && o.minPurchase != null ? Number(o.minPurchase) : null;
      // Hard gate: the prompt tells the model to only mark qualifies:true
      // when the purchase clears MAX_QUALIFYING_PURCHASE WITH tax, but
      // nothing here actually re-checked that — a mis-classified high
      // minimum purchase (e.g. "spend $150, get a free item") could reach
      // the results with nothing stopping it. Same fix as freebies.js's
      // copy of this function.
      if (minPurchase != null && !withinTaxAdjustedCap(minPurchase)) return;
      let price = null;
      if (o.requirementType === "bogo") price = "BOGO Free";
      else if (minPurchase != null) price = `Free w/ $${minPurchase.toFixed(2)} purchase`;
      const { store, claimUrl, blogUrl } = resolveStoreAndClaim(raw, o.restaurantName);
      items.push({
        id: `${raw.url}#${oi}`,
        title: (o.isLocal ? "[LOCAL] " : "") + (o.title || raw.title || "Untitled offer"),
        store,
        url: raw.url,
        price,
        isFree: true,
        isLocal: !!o.isLocal,
        requirementType: o.requirementType || "unknown",
        expires: o.expires || null,
        claimUrl,
        blogUrl,
        trustedSource: prioritySourceName(raw.url),
        category: "restaurant"
      });
    });
  }
  return items;
}

// Keeps a deal only if at least 2 independently-run models both found it
// (matched on resolved store name + source URL) — corroboration on
// thin/ambiguous DuckDuckGo snippets is worth more than trusting any single
// model's read. Field VALUES (price, expires, etc.) come from whichever
// model reported the deal first; only the deal's EXISTENCE is cross-checked.
function mergeCorroborated(parsedLists) {
  const byKey = new Map();
  for (const list of parsedLists) {
    const seenInThisList = new Set(); // a model repeating its own item shouldn't inflate its corroboration count
    for (const item of list) {
      const key = `${item.url}|${(item.store || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      if (seenInThisList.has(key)) continue;
      seenInThisList.add(key);
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { item, count: 1 });
    }
  }
  return [...byKey.values()].filter(e => e.count >= 2).map(e => e.item);
}

// ---------- Search providers ----------
// This endpoint wants a wider net (12 results) and reasonably-recent
// results (last 21 days, matching MAX_RESULT_AGE_DAYS above — Tavily-only,
// the shared function ignores `days` for providers that don't support it)
// — the shared function takes those as options, so wrap it here to keep
// the four call sites below unchanged.
const RESTAURANT_SEARCH_OPTS = { maxResults: 12, days: 21 };
async function searchWithFallback(env, query, includeDomains) {
  return sharedSearchWithFallback(env, query, includeDomains, RESTAURANT_SEARCH_OPTS);
}
async function searchAllSources(env, query, includeDomains) {
  return sharedSearchAllSources(env, query, includeDomains, RESTAURANT_SEARCH_OPTS);
}

// For independent/local spots we don't have a domain mapped, spend one
// extra search to find their real site — kept to the final, deduped list
// so this doesn't multiply into a search per raw result (it's now per
// distinct offer, since roundup posts can yield several).
// ---------- Foursquare Places API (nearby-existence check, UNVERIFIED) ----------
// UNVERIFIED CONTRACT — same caveat treatment as olostepSearch in
// search-providers.js. Foursquare is mid-migration off its legacy V3 API
// (deprecated May 15, 2026) onto a new "FSQ OS Places"-powered Places API,
// and their own docs are inconsistent about the new shape as of this
// writing. The endpoint/headers below are confirmed against one real
// working example (a third-party blog post showing an actual successful
// call), NOT Foursquare's own reference docs directly:
//   GET https://places-api.foursquare.com/places/search?...
//   Authorization: Bearer <key>
//   X-Places-Api-Version: 2025-06-17
// What's NOT confirmed: exact response field names beyond fsq_place_id/
// latitude/longitude (seen in a real sample response), and whether `near`
// (free-text location) is accepted the same way it was on the legacy API
// vs requiring `ll` (lat,lng) instead. This function is written
// defensively — ANY unexpected shape or failure just returns null rather
// than throwing, so a wrong guess here can only mean "no Foursquare
// verification for this item," never a broken request. Confirm the real
// shape against your own Foursquare dashboard/playground once you have a
// key, and tighten this up — the X-Places-Api-Version date in particular
// may need bumping as Foursquare revs it.
//
// Free tier: Foursquare's own pricing pages disagree on the exact number
// (100 free Pro calls/month per one page, 500 free Pro calls/month per
// their "Upcoming Changes" doc effective June 1, 2026, 10,000 as a
// separate "developer sandbox" test allowance per another) — check your
// own dashboard for the real current cap rather than trusting a hardcoded
// number here. FOURSQUARE_API_KEY simply isn't called if unset, so this
// costs nothing extra to leave wired in even before you've confirmed it.
//
// Purpose: your existing chain-matching (CHAIN_DOMAINS above) already
// gives a confident "Claim" link for known chains, and findOfficialSite
// below does a plain web search for independent spots — neither actually
// confirms a branch exists within the user's radius. This adds that one
// missing check: does Foursquare know of a place by this name near this
// location at all? If yes, the real address it returns is far more useful
// to someone deciding whether to drive there than a chain's generic
// homepage link.
async function verifyNearbyWithFoursquare(env, name, location, radius) {
  if (!env.FOURSQUARE_API_KEY || !name || !location) return null;
  try {
    const radiusMeters = Math.min(100000, Math.round(radius * 1609)); // miles -> meters, Foursquare caps around 100km
    const params = new URLSearchParams({ query: name, near: location, radius: String(radiusMeters), limit: "1" });
    const res = await fetch(`https://places-api.foursquare.com/places/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${env.FOURSQUARE_API_KEY}`,
        "X-Places-Api-Version": "2025-06-17",
        accept: "application/json"
      }
    });
    if (!res.ok) return null; // don't throw — see header comment, this is best-effort only
    const data = await res.json();
    const place = data && Array.isArray(data.results) && data.results[0];
    if (!place) return null;
    // Field names beyond fsq_place_id/latitude/longitude are a best guess
    // (formatted_address is the common shape across Foursquare's various
    // APIs, but not directly confirmed for this specific new endpoint).
    const address = place.location && (place.location.formatted_address || place.location.address);
    const mapsUrl = (typeof place.latitude === "number" && typeof place.longitude === "number")
      ? `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`
      : null;
    return { verifiedNearby: true, address: address || null, mapsUrl };
  } catch (err) {
    return null; // never let an unverified integration break a real card
  }
}

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
  const rl = await checkRateLimit(env, request, "restaurant-deals");
  if (!rl.allowed) return rateLimitResponse();

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { location } = body;
  if (!location) return json({ error: "location is required." }, 400);
  if (typeof location !== "string" || location.length > 200) {
    return json({ error: "location is invalid or too long." }, 400);
  }
  // Clamped 1-100 server-side, same as grocery-price.js/gas-price.js —
  // previously this endpoint trusted whatever the client sent verbatim
  // (including "within undefined miles" if the field was omitted), even
  // though the client-side <input max="100"> already caps it in the UI.
  // A UI cap is not a server-side guarantee.
  const rawRadius = Number(body.radius);
  const radius = Number.isFinite(rawRadius) ? Math.min(100, Math.max(1, Math.round(rawRadius))) : 100;

  // Kept deliberately simple/natural rather than a boolean OR/quote
  // expression — that style works great on Tavily's semantic "advanced"
  // search but reads far more literally on Serper/Exa (plain-ish keyword
  // search), where it was over-narrowing results instead of broadening
  // them. The actual qualifying rules (free / BOGO / <= $MAX_QUALIFYING_PURCHASE
  // minimum purchase) are already enforced downstream by the classifier,
  // so the query itself just needs to point search at the right topic.
  // Named a representative sample of chains directly (mixing big national
  // names with regional ones like Whataburger/Bojangles/Zaxby's/Culver's)
  // rather than just "restaurants fast food" — generic phrasing mostly
  // surfaces big national roundup-blog posts ("10 Best Fast Food Deals
  // This Week"), which skew toward McDonald's/Taco Bell/Wendy's and often
  // never mention regional-only chains at all, even when those chains have
  // a real, current, national promotion running. Naming them increases
  // keyword overlap with a chain's own promo page or a smaller local
  // write-up that a generic query wouldn't match as well. This doesn't add
  // a search call — it's the same one query, just phrased to catch more.
  const query = `free food deals BOGO this week at McDonald's, Chick-fil-A, Wendy's, Taco Bell, Whataburger, Bojangles, Culver's, Sonic, Zaxby's, Raising Cane's, Popeyes, Chipotle, and other restaurants/fast food near ${location} within ${radius} miles`;

  let results, providers;
  try {
    const search = await searchAllSources(env, query);
    results = search.results;
    providers = search.providers; // e.g. ["tavily","gemini","openai","duckduckgo"]
  } catch (err) {
    // Log the real, detailed reason server-side (visible via `wrangler
    // pages deployment tail`) — never forward raw provider error text
    // (rate limits, account/billing messages, etc.) to the browser.
    console.error("restaurant-deals search failed:", err.message);
    return json({ error: err.publicMessage || "Search is temporarily unavailable. Please try again in a few minutes." }, 502);
  }

  // Best-effort extra pass scoped to the known-good freebie sites, merged
  // into the general pool — if it fails or turns up nothing, the general
  // whole-web results still stand on their own.
  try {
    const priority = await searchAllSources(env, query, Object.keys(PRIORITY_SOURCES));
    const seen = new Set(results.map(r => r.url));
    for (const r of priority.results) {
      if (!seen.has(r.url)) { seen.add(r.url); results.push(r); }
    }
  } catch { /* ignore — priority pass is a bonus, not a requirement */ }

  const provider = providers.join("+"); // kept in the response for debugging/visibility
  if (!results.length) return json({ results: [], provider });

  results = filterAndSortByFreshness(results, MAX_RESULT_AGE_DAYS);
  if (!results.length) return json({ results: [], provider, note: `All results were older than ${MAX_RESULT_AGE_DAYS} days.` });

  // Float known-good sources to the top of what's left, freshness order
  // preserved within each group.
  results.sort((a, b) => (prioritySourceName(b.url) ? 1 : 0) - (prioritySourceName(a.url) ? 1 : 0));

  let classified = null;
  // Unlike search (which only fires ONE tier's engines per scan — see the
  // header comment above), the sorter step below still runs every
  // CONFIGURED classifier model in parallel whenever 2+ are keyed
  // (multipleLLMsConfigured), regardless of which search tier was active
  // — cheap insurance against a single model's misreads, since LLM
  // classification is one call pair per scan regardless of search volume.
  const useEnsemble = multipleLLMsConfigured(env);
  if (anyLLMConfigured(env)) {
    try {
      classified = await llmClassify(env, results, location, radius, { ensemble: useEnsemble });
    } catch (err) {
      // fall through to regex below
    }
  }
  if (!classified) classified = regexClassify(results, location);

  let finalResults = dedupeItems(classified);
  finalResults = await Promise.all(finalResults.map(async item => {
    if (!item.claimUrl) {
      const officialUrl = await findOfficialSite(env, item.store);
      item.claimUrl = officialUrl || item.url;
      item.blogUrl = officialUrl ? item.url : null;
    }
    // Best-effort, additive only — see verifyNearbyWithFoursquare's header
    // comment on why this never blocks or alters claimUrl/blogUrl above,
    // only adds an address/maps-link when Foursquare confirms a real
    // nearby branch exists (or silently adds nothing if not configured,
    // not found, or the unverified contract doesn't match).
    const nearby = await verifyNearbyWithFoursquare(env, item.store, location, radius);
    if (nearby) {
      item.verifiedNearby = nearby.verifiedNearby;
      item.address = nearby.address;
      item.mapsUrl = nearby.mapsUrl;
    }
    return item;
  }));

  return json({ results: finalResults, usedLLM: anyLLMConfigured(env), usedEnsemble: useEnsemble, provider });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
