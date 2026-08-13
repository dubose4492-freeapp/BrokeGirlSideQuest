// Shared location-text helpers for the REGEX FALLBACK classifiers (used
// only when no LLM provider is configured — see restaurant-deals.js and
// freebies.js). Both files' LLM prompts already do this judgment call in
// natural language; this module gives the regex path the same two rules
// in code, since the two prompts intentionally use OPPOSITE defaults for
// "no location detail in the snippet at all":
//   - restaurant-deals.js: forgiving default -> assume local unless the
//     snippet explicitly says otherwise. Use looksLikeWrongLocation().
//   - freebies.js: strict default -> a local/independent org needs an
//     affirmative location match, no detail at all does NOT qualify.
//     Use looksLocal().
// Neither does real geocoding/distance math (no lat/lng lookup here) —
// both are best-effort TEXTUAL checks against whatever the caller passed
// as `location`, same caveat as the LLM prompts' own location rule.

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
const ABBR_TO_STATE = {};
for (const [full, abbr] of Object.entries(STATE_ABBR)) ABBR_TO_STATE[abbr] = full;

// Word-boundary regex per state, matching either the full name or the
// 2-letter abbreviation (abbreviation only matched when it stands alone,
// e.g. surrounded by non-letters, so it doesn't fire inside an unrelated
// word). Built once at module load.
const STATE_PATTERNS = Object.entries(STATE_ABBR).map(([full, abbr]) => ({
  full,
  abbr,
  re: new RegExp(`\\b(${full}|${abbr})\\b`, "i")
}));

const LOCATION_STOPWORDS = new Set(["near", "county", "area", "city", "town", "usa", "us"]);

// Splits whatever the client sent as `location` ("City, ST", a bare ZIP,
// or something in between) into the pieces useful for matching: the raw
// state name/abbr if present, and generic place-name tokens (city words,
// zip digits) for the affirmative-match check.
function parseLocation(location) {
  const raw = (location || "").trim();
  let stateFull = null;
  let stateAbbr = null;
  for (const { full, abbr, re } of STATE_PATTERNS) {
    if (re.test(raw)) { stateFull = full; stateAbbr = abbr; break; }
  }
  const placeTokens = new Set();
  for (const part of raw.split(/[,\n]/).map(p => p.trim().toLowerCase()).filter(Boolean)) {
    for (const word of part.split(/\s+/)) {
      const clean = word.replace(/[^a-z0-9]/g, "");
      if (clean.length >= 2 && !LOCATION_STOPWORDS.has(clean) && !STATE_ABBR[clean] && !ABBR_TO_STATE[clean]) {
        placeTokens.add(clean);
      }
    }
  }
  return { raw, stateFull, stateAbbr, placeTokens: [...placeTokens] };
}

// ---------- Forgiving check (restaurant-deals.js) ----------
// Returns true ONLY when the snippet explicitly names a state that is NOT
// the target state, AND doesn't also mention the target city/state
// somewhere else (e.g. a roundup post that mentions several regions).
// Silent (returns false = "not wrong") on ambiguous or no-location text,
// matching the LLM prompt's "no location detail should NOT be
// disqualified" default.
function looksLikeWrongLocation(text, location) {
  const { stateFull, stateAbbr, placeTokens } = parseLocation(location);
  if (!stateFull && placeTokens.length === 0) return false; // nothing usable to compare against
  const t = (text || "").toLowerCase();

  // Does the text also affirmatively mention the target area? If so,
  // never flag it as wrong-location even if another state name appears
  // (e.g. "originally from Ohio, now serving the Portland, TN area").
  const mentionsTarget =
    (stateFull && new RegExp(`\\b(${stateFull}|${stateAbbr})\\b`, "i").test(t)) ||
    placeTokens.some(tok => tok.length >= 3 && t.includes(tok));
  if (mentionsTarget) return false;

  for (const { full, abbr } of STATE_PATTERNS) {
    if (full === stateFull) continue; // that's the target state itself
    if (new RegExp(`\\b(${full}|${abbr})\\b`, "i").test(t)) return true; // names a different state
  }
  return false;
}

// ---------- Strict check (freebies.js) ----------
// Returns true only on an AFFIRMATIVE match: the text names the target
// state (full or abbr) or a target place-name token (city word, zip).
// No match at all -> false, matching the LLM prompt's "no location detail
// at all -> qualifies is false" default for local/independent results.
function looksLocal(text, location) {
  const { stateFull, stateAbbr, placeTokens } = parseLocation(location);
  if (!stateFull && placeTokens.length === 0) return false; // nothing usable to match — can't affirm
  const t = (text || "").toLowerCase();
  if (stateFull && new RegExp(`\\b(${stateFull}|${stateAbbr})\\b`, "i").test(t)) return true;
  return placeTokens.some(tok => tok.length >= 3 && t.includes(tok));
}

// ---------- City mention extraction (freebies.js display label) ----------
// Pulls "City, ST" style mentions out of free text (e.g. a giveaway
// snippet mentioning "our new store in Portland, TN opens Saturday") for
// giveawayLocationLabel()'s "Near <city>" display. Best-effort regex, not
// geocoding, same caveat as the rest of this module — requires a
// capitalized place name immediately followed by a comma and a real
// 2-letter state abbreviation, which keeps false positives low but will
// miss phrasings that don't include the state abbr right next to the city.
const STATE_ABBR_SET = new Set(Object.values(STATE_ABBR).map(a => a.toUpperCase()));
function extractCityMentions(text) {
  const t = text || "";
  const re = /\b([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+){0,2}),\s*([A-Z]{2})\b/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const abbr = m[2].toUpperCase();
    if (!STATE_ABBR_SET.has(abbr)) continue; // "Thanks, OK" etc. aren't states
    const label = `${m[1]}, ${abbr}`;
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

export { looksLikeWrongLocation, looksLocal, parseLocation, extractCityMentions };
