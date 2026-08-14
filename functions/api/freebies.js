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
// Search providers: strict sequential TIER system (see
// functions/_shared/search-providers.js) — only the currently-ACTIVE
// tier's engines fire per scan (e.g. just Tavily + its Gemini/OpenAI/
// GoogleCSE ride-alongs), not every configured provider. A later tier is
// only touched once the active tier's primary engine has used up its
// tracked free-tier quota, or as a one-off resilience fallback if the
// active tier's engines all fail outright on a given call.
// searchAllSources: fires the active tier's engines in parallel and merges
// them — used below for the main per-scan result list. searchWithFallback
// (cheaper, stop-at-first-success) is still used for the narrow
// single-answer "find this org's official site" lookup further down.
import { searchWithFallback, searchAllSources } from "../_shared/search-providers.js";
// LLM providers: OpenRouter -> Groq -> Cerebras -> Mistral -> Google AI
// Studio -> Hugging Face -> Cohere (any ONE configured key unlocks the LLM
// classification path instead of falling straight to the regex fallback).
// Shared with restaurant-deals.js and grocery-price.js.
import { chatWithFallback, chatWithEnsemble, anyLLMConfigured, multipleLLMsConfigured } from "../_shared/llm-providers.js";
// Per-IP rate limiting — see functions/_shared/rate-limit.js for why and
// how generous the limits are. Fails open if RATE_LIMIT_KV isn't bound.
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.js";
// Shared location-text check for the regex fallback path — this file uses
// the STRICTER variant (see that file for why): local/independent orgs
// need an affirmative match, not just "doesn't name another state" the
// way restaurant-deals.js's forgiving looksLikeWrongLocation works.
import { looksLocal, extractCityMentions } from "../_shared/location.js";

// Time-based freshness ceiling per category, mirroring the old client-side
// timeRange settings. null = don't filter by age (evergreen resources like
// food pantries / community fridges / standing mail-in sample programs).
const CATEGORY_MAX_AGE_DAYS = {
  clothing: 30,
  toys: 30,
  accessories: 30,
  events: 14,
  community: null,
  // mail was 30 — changed to null (evergreen). The offers this tab wants
  // most (SampleSource, PINCHme, Imagination Library, manufacturer sample
  // request forms) are standing programs, not "this week's" listings —
  // same reasoning as community's null above. A 30-day ceiling was
  // dropping perfectly current, always-on programs just because the page
  // they're described on wasn't recently republished.
  mail: null
};

// events/community search queries are already narrowly scoped to on-topic
// free resources, so anything that comes back is treated as in-scope
// rather than gated behind a literal "must say free" check the way
// clothing/toys/accessories/mail are.
const ALWAYS_QUALIFIES = new Set(["events", "community"]);

// Categories where a "spend $X or less, get an item free" offer (BOGO-style
// promos, "spend $10 get a free gift", etc.) counts as qualifying, same
// rule restaurant-deals.js already applies to food deals. Deliberately
// excludes grocery (its own endpoint, priced item-by-item — a spend
// threshold doesn't apply there) and community (food pantries/fridges/
// closets are already fully free, no spend threshold is relevant).
const SPEND_TO_FREE_CATEGORIES = new Set(["clothing", "toys", "accessories", "events", "mail"]);
const MAX_QUALIFYING_SPEND = 10; // dollars — TOTAL cost cap, tax included (see below)
// The $10 cap is a TOTAL-cost cap, not a pre-tax one — an offer only
// qualifies if the final checkout total (item cost + tax) stays at or
// under $MAX_QUALIFYING_SPEND. Since this app has no ZIP-to-tax-rate
// lookup, it can't compute the real local rate, so it uses a rough
// US-average estimate as a safety buffer: a stated PRE-TAX spend amount
// only qualifies if it would stay under the cap even after adding this
// estimated rate. This intentionally trades away some borderline offers
// in low/no-sales-tax areas (a $9.80 item in Oregon would truly total
// $9.80, but this app can't tell that from the snippet text) in exchange
// for never showing something that turns out to ring up over $10 at
// checkout in a typical-tax area — the app is deliberately conservative
// here since the user set explicitly wants "including tax" enforced, not
// just flagged.
const ESTIMATED_SALES_TAX_RATE = 0.09;
function withinTaxAdjustedCap(spend) {
  return spend != null && spend * (1 + ESTIMATED_SALES_TAX_RATE) <= MAX_QUALIFYING_SPEND;
}

// Looks for "spend/with a purchase of/minimum purchase of $X" style phrasing
// and returns the dollar amount, or null if no spend requirement is stated.
// Same pattern restaurant-deals.js uses for its own $10 rule.
function extractMinSpend(text) {
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
function looksBogo(text) { return /\bbogo\b|buy\s*one[,]?\s*get\s*one/i.test(text || ""); }

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

function extractRequirementType(text) {
  const t = (text || "").toLowerCase();
  if (looksBogo(t)) return "bogo";
  // Formal aid programs (SNAP/WIC, food banks/pantries, utility/rental
  // assistance, emergency funds) — checked before the more generic
  // "no_purchase"/signup patterns below since a food bank's own page often
  // also says something like "no purchase necessary," but "apply for
  // assistance" is a meaningfully different thing to show someone than a
  // simple free-item offer: it's an eligibility/application process, not
  // a $0 checkout. See requirementType "assistance" in dist/index.html's
  // REQ_TYPES/priceTierBadge for how this renders (🔵 ASSISTANCE badge).
  if (/\bsnap\b|\bwic\b|food (bank|pantry|pantries)|rental assistance|utility assistance|emergency (assistance|funds?|financial)|government assistance|eviction (prevention|assistance)|energy assistance|liheap|income[\s-]?qualified|eligibility (requirements?|guidelines?)/.test(t)) return "assistance";
  if (/no purchase (necessary|required)/.test(t)) return "no_purchase";
  if (extractMinSpend(t) != null) return "min_purchase";
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
  // Only trust a direct Date parse when the text actually names a year —
  // otherwise `new Date("August 15")` silently defaults to the year 2001
  // (a JS Date quirk, not "no year given = invalid"), which then reads as
  // long-expired and wrongly filters out perfectly current offers like
  // "register through August 15" or "class ends Aug 9". Bare month/day
  // text always goes through the guess-the-year logic below instead.
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
  toys: /\b(toys?|games?|action figures?|dolls?|lego|playset|toy drives?|kids?\s+workshops?|build and grow|craft kits?)\b/i,
  accessories: /\b(backpacks?|tote bags?|water bottles?|school suppl(?:y|ies)|accessor(?:y|ies)|bags?|sunglasses|jewelry|hat|scarf|glove|mitten|hair clip)\b/i,
  mail: /\b(sample|by mail|mail-?in|free sample)\b/i
};
function matchesCategory(text, category) {
  if (ALWAYS_QUALIFIES.has(category)) return true; // events/community already scoped by their query
  const re = CATEGORY_KEYWORDS[category];
  return re ? re.test(text) : true; // no keyword list defined — don't gate it
}

// Builds the "where/how to get this" label shown on giveaway cards. Used
// by BOTH the regex fallback and the LLM path so behavior is consistent
// regardless of which classifier ran — derived from text + the isLocal
// flag rather than a separate LLM-extracted field, since isLocal already
// carries the judgment call (chain/national vs local/independent) and
// this just phrases it for display:
//   - not local (national/chain-wide entry): mail if the snippet actually
//     says so, otherwise online — either way "no local visit required".
//   - local: pull an actual "City, ST" mention out of the snippet text if
//     one's there (the real event city, which may be a nearby town within
//     the radius rather than the exact city the person searched), else
//     fall back to "Near <searched location> (within N mi)".
function giveawayLocationLabel(text, isLocal, location, radius) {
  if (!isLocal) {
    const byMail = /\bby mail\b|\bmail-?in\b|\bmail entry\b/i.test(text || "");
    return byMail ? "Enter by mail — no local visit required" : "Enter online — no local visit required";
  }
  const cities = extractCityMentions(text);
  if (cities.length) return `Near ${cities.slice(0, 3).join(" / ")}`;
  return location ? `Near ${location} (within ${radius} mi)` : `Within ${radius} mi of your area`;
}

// `location` (added for the local/independent check below) mirrors the
// LLM prompt's locationRule: mail stays unfiltered (ships anywhere, same
// as the LLM path), and only items flagged isLocal via the local/
// community regex below are checked — a plain company/chain mention with
// no "local"/"community" language is treated as chain-wide, exempt, same
// as the LLM prompt's national-brand exemption. For an isLocal item,
// require an AFFIRMATIVE location match (looksLocal) — no location detail
// at all does NOT qualify, matching the LLM prompt's strict default here
// (the opposite of restaurant-deals.js's forgiving default).
function regexClassify(results, category, location, radius) {
  const items = [];
  const spendEligible = SPEND_TO_FREE_CATEGORIES.has(category);
  for (const raw of results) {
    const combinedText = (raw.content || "") + " " + (raw.title || "");
    const isBogo = spendEligible && looksBogo(combinedText);
    const minSpend = spendEligible ? extractMinSpend(combinedText) : null;
    // A spend requirement only qualifies alongside "free" language in the
    // same snippet (a plain "$8 tote bag" isn't a freebie just because it
    // happens to be under $10) — mirrors restaurant-deals.js's rule.
    const qualifiesMinSpend = minSpend != null && withinTaxAdjustedCap(minSpend) && looksFree(combinedText);
    // A dollar amount anywhere in the text disqualifies the plain-free
    // bucket for spend-eligible categories — "free scarf when you spend
    // $45" should NOT slip through just because the word "free" appears;
    // it only qualifies via the BOGO/qualifiesMinSpend checks above, and
    // $45 fails those. Mirrors restaurant-deals.js's same guard. Doesn't
    // apply to events/community (ALWAYS_QUALIFIES) — those are already
    // narrowly scoped by their own search query.
    const hasDollarAmount = /\$\s?\d+(\.\d{2})?/.test(combinedText.replace(/free/gi, ""));
    const qualifiesPlainFree = ALWAYS_QUALIFIES.has(category)
      ? true
      : looksFree(combinedText) && (!spendEligible || !hasDollarAmount);
    if (!isBogo && !qualifiesMinSpend && !qualifiesPlainFree) continue;
    if (!matchesCategory(combinedText, category)) continue;

    const expires = extractExpiry(raw.content);
    if (isExpired(expires)) continue;

    const requirementType = extractRequirementType(combinedText);
    const isLocal = /\blocal\b|\bcommunity\b/i.test(combinedText);
    // Mail ships anywhere — no location rule applies (matches the LLM
    // prompt's locationRule, which is "" for category === "mail"). For
    // every other category, an item flagged local/independent needs an
    // affirmative match to the target area or it's rejected outright.
    if (isLocal && category !== "mail" && !looksLocal(combinedText, location)) continue;
    const orgMentions = findMultipleOrgMentions(combinedText);

    let price = null;
    let spendRequired = null;
    let taxNote = null;
    if (isBogo) {
      price = "BOGO Free";
    } else if (qualifiesMinSpend) {
      price = `Free w/ $${minSpend.toFixed(2)} purchase`;
      spendRequired = minSpend;
      // qualifiesMinSpend above already required this to clear the cap
      // WITH estimated tax included — this note just makes that visible
      // to the client rather than implying it might not hold.
      taxNote = `Estimated total with tax stays at or under $${MAX_QUALIFYING_SPEND} — actual local tax rate may vary slightly.`;
    }

    // Giveaway/contest offers need to show where they're claimable — the
    // person's city/surrounding area within radius for a local one, or an
    // explicit mail/online note for a national one. See
    // giveawayLocationLabel's header comment above.
    const giveawayLocation = requirementType === "giveaway"
      ? giveawayLocationLabel(combinedText, isLocal, location, radius)
      : null;

    const baseItem = {
      url: raw.url,
      isFree: true,
      isLocal,
      requirementType,
      expires,
      price,
      spendRequired,
      taxNote,
      giveawayLocation,
      trustedSource: prioritySourceName(raw.url),
      category
    };

    if (orgMentions.length > 1) {
      for (const orgName of orgMentions) {
        items.push({
          id: `${raw.url}#${orgName.toLowerCase().replace(/\s+/g, "-")}`,
          title: `Free offer from ${orgName}`,
          orgName,
          store: orgName,
          ...baseItem
        });
      }
    } else {
      const orgName = orgMentions[0] || raw.title || hostname(raw.url);
      items.push({
        id: raw.url,
        title: raw.title || "Untitled offer",
        orgName,
        store: orgName,
        ...baseItem
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
  // isLocal here doubles as the radius/drive-distance signal — the search
  // query already scopes to "within N miles of <location>", so treat an
  // event as isLocal:true only if it's actually happening at a physical
  // place near that location (charity events, giveaways, community
  // festivals, a store's in-person promotion), not something purely
  // online/nationwide with no venue near the person, and not a mail-in
  // program (that belongs on the Mail tab, not Events).
  events: "100% free events happening at a real physical location — charity events, giveaways, festivals, concerts, community gatherings, or a business/venue's free promotions — near the person and within the distance they said they're willing to drive",
  community: "food pantries, food banks, food drives, clothing drives, clothing closets, community fridges, soup kitchens, shelters, or other completely free charitable resources for people in need — no purchase or spend threshold applies to this category at all. ALSO include formal government/nonprofit assistance programs: SNAP, WIC, utility assistance (LIHEAP etc.), rental/eviction-prevention assistance, and other emergency financial support — these qualify as \"assistance\" resources even though they involve an application/eligibility process rather than simply picking up a free item.",
  mail: "free items (not just samples) available by mail — no local/radius matching applies here since these ship anywhere"
};
// Extra qualifying rules appended per-category, for categories where "free"
// alone isn't the whole bar. Every SPEND_TO_FREE_CATEGORIES category also
// accepts a BOGO or "spend $X or less, get an item free" offer — same rule
// restaurant-deals.js applies to food deals. The $10 cap is tax-INCLUSIVE:
// the model is told to treat it as the final checkout total, not a
// pre-tax figure, and to disqualify (not just flag) anything that would
// likely exceed it once typical sales tax is added.
const SPEND_RULE_TEXT = ` A BOGO ("buy one get one") free offer also qualifies. So does an item that's free/added at no extra cost when you spend $${MAX_QUALIFYING_SPEND} or less TOTAL, TAX INCLUDED (e.g. "free tote bag with any $10 purchase") — if the snippet's stated spend amount is pre-tax and is close enough to $${MAX_QUALIFYING_SPEND} that adding a typical ~9% sales tax would push the real checkout total over it, it does NOT qualify (treat roughly $${MAX_QUALIFYING_SPEND} minus that ~9% buffer as the real usable pre-tax ceiling). An offer requiring MORE than that does not qualify on that basis alone.`;
const MAIL_SPEND_RULE_TEXT = SPEND_RULE_TEXT + ` This also applies to SHIPPING: if the free item requires paying for shipping/handling, that shipping cost counts toward the same $${MAX_QUALIFYING_SPEND} tax-inclusive total — e.g. "free" item + $6 shipping is fine, but "free" item + $12 shipping does not qualify. A snippet that doesn't mention a purchase price or shipping cost at all (a plain free-by-mail offer) still qualifies normally.`;
const TOYS_WORKSHOP_RULE_TEXT = ` Recurring in-store kids' craft/build workshops from these specific known programs ALWAYS qualify as free toys whenever a snippet mentions them, even if the snippet doesn't explicitly restate "free" or a purchase requirement — treat these as free, no-purchase, recurring events by default: Lowe's Build and Grow, Home Depot Kids Workshop, Michaels Make Break (Make Break Take), JCPenney/Kohl's kids' events, and Barnes & Noble kids' story/craft events. Still disqualify one of these ONLY if the snippet explicitly says it's been discontinued/ended or requires a purchase.`;
const CATEGORY_EXTRA_RULES = {
  clothing: SPEND_RULE_TEXT,
  toys: SPEND_RULE_TEXT + TOYS_WORKSHOP_RULE_TEXT,
  accessories: SPEND_RULE_TEXT,
  events: SPEND_RULE_TEXT,
  mail: MAIL_SPEND_RULE_TEXT
};

// Asks the model to return an "offers" array PER SNIPPET rather than one
// object per snippet, so a roundup post naming several companies/orgs
// yields one qualifying offer object per company/org instead of collapsing
// the whole post into a single card. Also passes location/radius (mail is
// the one category where these don't apply — see CATEGORY_HINTS.mail —
// but harmless to pass along regardless) so the model can flag
// local/independent results that are clearly outside the requested area.
// NOTE: this is a best-effort TEXTUAL check based on whatever the snippet
// happens to say, not real geocoding/distance math — this app has no
// lat/lng lookup or address parser. The primary radius signal is still
// the "within N miles" phrase already baked into `query` before search —
// which, per search-providers.js's simplifyQueryForKeywordEngines, is
// stripped before reaching DuckDuckGo/Google CSE/SearXNG, so results from
// those specific engines get no radius hint at either the search OR
// classification step; this snippet-text check is the only backstop for
// that gap, and it only catches cases where the snippet mentions a
// location at all.
async function llmClassify(env, results, category, location, radius, { ensemble = false } = {}) {
  const snippetText = results
    .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 700)}`)
    .join("\n\n");
  const today = new Date().toISOString().slice(0, 10);
  const categoryHint = CATEGORY_HINTS[category] || "free offers";
  const extraRule = CATEGORY_EXTRA_RULES[category] || "";
  const locationRule = (category === "mail")
    ? "" // ships anywhere — no location/radius disqualification applies
    : ` The person is near ${location || "their stated area"} and wants results within ${radius} miles — treat this as a hard requirement, not a soft preference; a result outside this radius is worse than no result at all. For a NATIONAL BRAND/CHAIN (present at locations nationwide) offering something chain-wide, don't reject it on location grounds. BUT if the snippet ties the offer to one specific store, city, grand-opening, or one-time event — even for a brand that's national elsewhere — treat that the same as a local/independent org and check its location. For any LOCAL/INDEPENDENT org, single-location event, or brand offer tied to one specific place: qualifies is false unless the snippet states a location that is genuinely in or within a ${radius}-mile drive of ${location || "the search area"}. If the snippet gives NO location detail at all for one of these, qualifies is false — do not assume it's local by default just because no location was mentioned.`;

  const prompt = `Today's date is ${today}. You are reviewing search results about ${categoryHint}. Some snippets describe just one offer/resource; others are "roundup" posts listing several from different companies/organizations — extract EACH qualifying offer separately in that case, one per company/org.

For EACH snippet below, return an "offers" array (empty if nothing in it qualifies). For every offer/resource found in that snippet, include:
- orgName: the specific company, brand, or organization behind it (e.g. "Old Navy", "Second Harvest Food Bank"). Always fill this in if the snippet names one.
- qualifies: true only if it's genuinely about a real free offer/resource in this category (not a paid product, an unrelated article, or something whose stated end date is before today).${extraRule}${locationRule}
- title: a short clean description of that specific offer/resource.
- requirementType: one of "no_purchase", "signup", "loyalty", "rebate", "giveaway", "bogo", "min_purchase", "assistance", "unknown". Use "assistance" for a formal aid program (SNAP/WIC, a food bank/pantry, utility/rental assistance, an emergency fund) that involves an application or eligibility check rather than simply claiming a free item.
- minSpend: the dollar amount required to spend if requirementType is "min_purchase", else null.
- isLocal: true if this is a local/independent org or event, false if it's a well-known national brand/chain.
- expires: a short date string if an end date is mentioned, else null.

Return ONLY a strict JSON array, one object per snippet, in the same order, with this shape:
[{"index": 0, "offers": [{"orgName": "...", "qualifies": true, "title": "...", "requirementType": "giveaway", "minSpend": null, "isLocal": false, "expires": null}]}, ...]
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
    const parsedLists = chatResults.map(r => parseClassifyResponse(r.text, results, category, location, radius)).filter(Boolean);
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
  return parseClassifyResponse(text, results, category, location, radius);
}

// Parses one model's raw JSON response into the same item shape used
// everywhere else in this file. Pulled out of llmClassify so ensemble mode
// can run it against several models' responses independently, then compare
// the results — a parse failure from one model just drops that model's
// vote rather than failing classification entirely.
function parseClassifyResponse(text, results, category, location, radius) {
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
      const minSpend = o.requirementType === "min_purchase" && o.minSpend != null ? Number(o.minSpend) : null;
      // Hard gate, not just a note: the prompt already tells the model to
      // only mark qualifies:true when the spend clears $MAX_QUALIFYING_SPEND
      // WITH tax — but this used to just attach a "may exceed" warning and
      // still include the item when the model didn't follow that (e.g. a
      // $150 minimum spend slipping through as "free item"). Drop it here
      // instead of trusting the model's qualifies flag on its own.
      if (minSpend != null && !withinTaxAdjustedCap(minSpend)) return;
      let price = null;
      if (o.requirementType === "bogo") price = "BOGO Free";
      else if (minSpend != null) price = `Free w/ $${minSpend.toFixed(2)} purchase`;
      // Same giveawayLocationLabel helper the regex fallback uses (see its
      // header comment) — derived from the raw snippet text + the model's
      // isLocal call rather than a separate LLM-extracted field, so a
      // giveaway/contest offer always shows where it's claimable: the
      // person's city/surrounding area within radius, or an explicit
      // mail/online note for a national one.
      const giveawayLocation = o.requirementType === "giveaway"
        ? giveawayLocationLabel(`${raw.content || ""} ${raw.title || ""}`, !!o.isLocal, location, radius)
        : null;
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
        price,
        spendRequired: minSpend,
        // Anything with a minSpend that reaches this point already passed
        // the withinTaxAdjustedCap gate above, so this is just a
        // confirming note for the client — not a warning path anymore.
        taxNote: minSpend == null ? null
          : `Estimated total with tax stays at or under $${MAX_QUALIFYING_SPEND} — actual local tax rate may vary slightly.`,
        giveawayLocation,
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
  const { category, query, location } = body;
  if (!category || !query) return json({ error: "category and query are required." }, 400);
  // A real query typed/built by the app is always well under this — this
  // just caps how much text one request can force through search + LLM
  // classification, so it's not a free lever for wasting quota.
  if (typeof query !== "string" || query.length > 300) {
    return json({ error: "query is invalid or too long." }, 400);
  }
  // The client (index.html) already sends location/radius alongside query
  // — they were previously destructured out here and silently dropped, so
  // the sorter AI below never saw them even though the query text itself
  // has "within N miles" baked in. Clamped 1-100 server-side, same as
  // grocery-price.js/gas-price.js/restaurant-deals.js.
  const rawRadius = Number(body.radius);
  const radius = Number.isFinite(rawRadius) ? Math.min(100, Math.max(1, Math.round(rawRadius))) : 100;

  let results, providers;
  try {
    const general = await searchAllSources(env, query);
    results = general.results;
    providers = general.providers; // e.g. ["tavily","gemini","openai","duckduckgo"]
  } catch (err) {
    // Log the real, detailed reason server-side (visible via `wrangler
    // pages deployment tail`) — never forward raw provider error text
    // (rate limits, account/billing messages, etc.) to the browser.
    console.error("freebies search failed:", err.message);
    return json({ error: err.publicMessage || "Search is temporarily unavailable. Please try again in a few minutes." }, 502);
  }

  // Best-effort extra pass scoped to the known-good freebie sites, merged
  // into the general pool — if it fails or turns up nothing, the general
  // whole-web results still stand on their own. Also run across every
  // engine (not just the cheap fallback chain) so a source that only one
  // engine happens to index still gets caught.
  try {
    const priority = await searchAllSources(env, query, Object.keys(PRIORITY_SOURCES));
    const seen = new Set(results.map(r => r.url));
    for (const r of priority.results) {
      if (!seen.has(r.url)) { seen.add(r.url); results.push(r); }
    }
  } catch { /* ignore — priority pass is a bonus, not a requirement */ }

  const provider = providers.join("+"); // kept in the response for debugging/visibility
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
  // Unlike search (which only fires ONE tier's engines per scan — see the
  // header comment above), the sorter step below still runs every
  // CONFIGURED classifier model in parallel whenever 2+ are keyed
  // (multipleLLMsConfigured), regardless of which search tier was active.
  // That's a deliberate difference: search cost scales with call volume
  // across many scans, so it's gated behind quota; LLM classification is
  // one call pair per scan regardless, so cross-checking it every time is
  // cheap insurance against a single model's misreads.
  const useEnsemble = multipleLLMsConfigured(env);
  if (anyLLMConfigured(env)) {
    try {
      classified = await llmClassify(env, results, category, location, radius, { ensemble: useEnsemble });
    } catch (err) {
      // fall through to regex below
    }
  }
  if (!classified) classified = regexClassify(results, category, location, radius);

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
