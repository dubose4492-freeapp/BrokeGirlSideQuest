# Location accuracy fix — patch package

Fixes the "results 500 miles away" issue by resolving each ZIP to a real
"City, ST" before it's sent to search/classification, and by giving the
regex fallback classifiers (used when no LLM provider is configured) the
same location logic their LLM prompts already promise.

## Option A — apply the git patch (recommended)

From the root of your repo (same folder as `wrangler.toml`):

```
git apply location-accuracy-fix.patch
```

If that fails due to unrelated local changes, try:

```
git apply --3way location-accuracy-fix.patch
```

Verified: this patch applies cleanly against a fresh copy of the
BrokeGirlSideQuest.zip you uploaded, and all changed/added JS files pass
`node --check`.

## Option B — copy the files directly

If you'd rather not use `git apply`, just copy these over your existing
files (same relative paths):

- `changed-files/dist/index.html` (replaces yours)
- `changed-files/functions/api/restaurant-deals.js` (replaces yours)
- `changed-files/functions/api/freebies.js` (replaces yours)
- `changed-files/functions/_shared/location.js` (**new** file — doesn't exist yet)

## What changed

**dist/index.html**
- New `state.locationLabel`, cached per-ZIP (invalidated the moment the ZIP changes).
- Geolocation auto-fill now also grabs city/state from the BigDataCloud response it already fetches — no extra network call.
- Manually typing a ZIP now triggers a free, no-key lookup (`api.zippopotam.us`) to resolve city/state.
- New `searchLocation()` — returns the resolved "City, ST" label, silently falling back to the raw ZIP if nothing's resolved yet.
- All 4 fetch call sites (freebies, restaurant-deals, grocery-price, gas-price) and `buildAiPrompt()` now send `searchLocation()` as `location` instead of the raw ZIP. Kroger/gas still get the raw `zip` param separately, unchanged.

**functions/_shared/location.js** (new)
- `looksLikeWrongLocation(text, location)` — forgiving check. Rejects only if text names a *different* state and doesn't also mention the target area.
- `looksLocal(text, location)` — strict check. Requires an affirmative match to the target state/city.

**functions/api/restaurant-deals.js**
- `regexClassify` now takes `location`; the independent/local branch (no known national chain matched) uses `looksLikeWrongLocation` — matches that file's LLM prompt's forgiving default.

**functions/api/freebies.js**
- `regexClassify` now takes `location`; any item flagged `isLocal` (via the local/community regex) is rejected unless `looksLocal` affirms it — except category `mail`, which stays unfiltered (ships anywhere), matching that file's LLM prompt's stricter default.

## Not done / worth testing after deploy

- No live test against real Tavily/OpenRouter calls — this was a static edit + syntax check only.
- The "Copy Prompt" box updates asynchronously after a manual ZIP entry (brief moment showing the raw ZIP until the zippopotam.us lookup resolves).
