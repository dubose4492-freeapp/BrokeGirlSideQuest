# Deploying Daily Free Finder to Cloudflare Pages (with a real backend)

## What changed
Your Tavily and Kroger credentials no longer live in the HTML file at all —
they never reach the browser. Cloudflare Pages Functions hold them as
encrypted secrets and proxy the requests server-side:

- `functions/api/search.js`         → generic proxy to Tavily (kept for
  compatibility; no tab calls this directly anymore)
- `functions/api/grocery-price.js`  → does the whole Kroger OAuth + store
  lookup + product price flow, and just returns a price to the browser
- `functions/api/gas-price.js`      → same response shape as
  grocery-price.js, but for regular unleaded gas. No Kroger-style official
  API for fuel exists, so this is web-search only: known gas station chain
  sites + GasBuddy/AAA first, then the open web. Always the first card on
  the Grocery tab, styled distinctly from the 11 grocery-staple cards
- `functions/api/restaurant-deals.js` → searches the open web for
  free/BOGO restaurant deals, classifies them, and resolves a real
  "Claim" link (the chain's own site, or a found official site for
  independent spots) separate from the source article
- `functions/api/freebies.js`       → the same open-web-search + classify
  + resolve-a-real-claim-link pipeline as restaurant-deals.js, generalized
  to every other tab: clothing, toys, accessories, events, community, and
  by-mail. Every tab now works exactly like grocery: "Claim" always points
  at the actual company/org's own page, and if the offer was found on a
  third-party blog or news article, that source shows up as a separate
  "See Details" link.

Both endpoints also now pull apart "roundup" posts — a blog listing deals
at several different restaurants/stores in one article — into one card
per restaurant/company instead of a single card for the whole post. With
OpenRouter configured, the model is asked to return every qualifying deal
it finds per snippet; without it, the regex fallback does its own
best-effort version (a known-chain scan for restaurants, a "Brand is
giving away ... free" pattern for the other tabs).

Both endpoints also now run a second, domain-scoped search pass against a
short list of known-good freebie roundup sites (The Freebie Guy, Hey It's
Free!, Free Stuff Times) alongside the normal whole-web search — nothing
is restricted to just these sites, but anything found on them is merged
in, floated to the top of the results, and tagged so the app shows a small
"⭐ Trusted source" badge on those cards.

Because `freebies.js` and `restaurant-deals.js` spend one extra search
call per *offer* resolving a real "Claim" link, plus one more search call
per scan for the priority-source pass, a full "run quest" scan now uses
noticeably more of your search quota than before — and potentially more
still now that a single roundup post can produce several offers instead
of one. Worth keeping an eye on if you're on a free tier.

### Search: every engine, every scan
All four search-using endpoints (`freebies.js`, `restaurant-deals.js`,
`grocery-price.js`, `gas-price.js`) share one provider layer in
`functions/_shared/search-providers.js`, with six possible engines:

1. **Tavily** (`TAVILY_API_KEY`)
2. **Gemini** (`GOOGLE_AI_API_KEY`) — Google Search grounding tool, 5,000
   free grounded prompts/month
3. **Serper.dev** (`SERPER_API_KEY`) — 2,500 queries, one-time free tier
4. **Exa** (`EXA_API_KEY`) — $10 credit, one-time free tier
5. **OpenAI / ChatGPT** (`OPENAI_API_KEY`) — ChatGPT's web_search tool via
   the Responses API. This is a real OpenAI *platform* API key from
   platform.openai.com with billing/credit attached — not a ChatGPT.com
   login. No free tier, billed per call from the first request.
6. **DuckDuckGo** — no key, no signup, effectively unlimited

The **main per-scan result list** on every one of the four endpoints calls
`searchAllSources()` — this fires every one of the engines above that's
configured, IN PARALLEL, on every single scan, instead of stopping at the
first one that answers. Results are merged and de-duplicated by URL; a
listing that shows up in more than one engine's results gets tagged with
every engine that found it. So "run a scan" now means: query Tavily,
Gemini's grounded search, Serper, Exa, OpenAI's web search, and DuckDuckGo
all at once, every time, for the freshest possible combined picture —
matching Gemini AND ChatGPT independently re-searching from scratch on
every button-press rather than reusing anything cached.

The classification/"sorter AI" step right after search does the same
thing on the model side: `chatWithEnsemble()` in `llm-providers.js` runs
every configured LLM provider in parallel too, so with both
`GOOGLE_AI_API_KEY` and `OPENAI_API_KEY` set, Gemini and ChatGPT each
independently classify/sort the same raw search results and get
cross-checked against each other before anything reaches the app.

Narrower, single-answer lookups (e.g. "find this one company's official
site" so the Claim button points somewhere real) still use the cheaper
`searchWithFallback()` — stop at the first engine that answers — since
ensembling six engines for a lookup with only one right answer doesn't buy
anything extra.

**Cost note:** `searchAllSources()` spends every configured engine's quota
on every scan instead of only the cheapest one that works, so it costs
noticeably more than the old stop-at-first-success chain — especially on
`grocery-price.js`, which runs this once per grocery item (~11 items) per
scan. OpenAI has no free tier at all, so once `OPENAI_API_KEY` is set,
every scan spends real money on it immediately. Worth watching your
provider dashboards once this is live, particularly if traffic grows.
Leaving any of the five keyed engines unset just skips that engine —
nothing breaks, `searchAllSources()` still works with as few as zero keys
configured (DuckDuckGo alone).

One caveat: DuckDuckGo has no official free web-search API, so that last
step works by fetching and parsing DDG's plain HTML results page. It's
the most fragile link in the chain — if DuckDuckGo changes their page
markup, that step will start quietly returning fewer or zero results
instead of erroring. It's meant as a "search still basically works"
floor, not a long-term primary provider.

### Security: rate limiting, input limits, and a closed-off dead endpoint
Three changes, all aimed at "real users can hit this as much as they want,
scripts/scrapers can't drain the API quota". No caching layer is included —
search results are always fetched live, same as the app has always done.

- **Per-IP rate limiting** on `freebies.js`, `restaurant-deals.js`,
  `grocery-price.js`, and `gas-price.js` (`functions/_shared/rate-limit.js`).
  Limits are
  deliberately generous — sized so a person clicking through every tab and
  re-scanning repeatedly for a long session never comes close, while a
  script firing hundreds of requests a minute hits a wall fast. It needs
  its own KV namespace (`RATE_LIMIT_KV`, see setup below) — if you never
  bind it, this fails open (every request allowed), so nothing breaks
  either way, you just don't have the protection until the namespace
  exists.
- **Basic input length checks** on `query`/`location`/`item` — rejects
  absurdly long values before they ever reach a search or LLM call, since
  those were previously unbounded.
- **`functions/api/search.js` is now disabled** (returns 410). It was a
  leftover generic proxy straight to Tavily using your key — nothing in
  the current app calls it, but it was still live and would forward any
  caller's arbitrary query using your quota. Since it's unused, disabling
  it was simpler and safer than trying to lock it down.

To turn rate limiting on:
1. `wrangler kv:namespace create RATE_LIMIT_KV`
2. Copy the `id` it prints into `wrangler.toml`, uncommenting the
   `[[kv_namespaces]]` block and filling in `id = "..."`
3. Redeploy

To turn it off again, just remove/comment that block — no code change
needed, `rate-limit.js` checks for the binding and allows every request
through if it isn't there.

None of this requires new dependencies or touches your existing search/
classify/dedupe logic, and none of it changes what search results come
back — it only controls how often one IP can ask for them.

### Errors are no longer shown to users verbatim
Previously, if every provider in the chain failed, the raw upstream error
text (e.g. Tavily's own "This request exceeds your plan's set usage
limit..." message, including their support email) got forwarded straight
into the app's error banner — and since a full scan hits several tabs in
a row, one Tavily outage meant that exact message repeated once per tab,
wall-of-text style.

Two fixes:
- **Server-side**, `searchWithFallback()` now throws an Error with two
  separate fields: `.message` (a full technical summary of every provider
  tried and why each failed — server-side only, visible via `wrangler
  pages deployment tail`) and `.publicMessage` (a generic, safe sentence
  with no provider names or account details). All three `onRequestPost`/
  `onRequestGet` handlers now log `.message` and respond to the browser
  with `.publicMessage` only.
- **Client-side**, `index.html` now dedupes failure messages across tabs
  (a Set, not string concatenation) and tracks which tabs failed in
  `state.failedCategories` instead of guessing from the error text. A
  failed scan now shows one line like "Couldn't load: Restaurant Deals,
  Clothing, Toys. Search is temporarily unavailable. Please try again in
  a few minutes." instead of the same paragraph repeated per tab.

This also means: if you see that generic "Search is temporarily
unavailable" message in the app, the real reason (which provider failed
and why) is in your Cloudflare Pages Function logs, not in what your
users see.

## Files in this package
```
wrangler.toml
dist/
  index.html          ← your app (unchanged UI/logic otherwise)
functions/
  _shared/
    search-providers.js  ← shared Tavily/Serper/Exa/DuckDuckGo chain
  api/
    search.js
    grocery-price.js
    restaurant-deals.js
    freebies.js
```
`functions/` must sit at the ROOT of your repo, as a sibling of `dist/` —
not inside it. Wrangler looks for it there automatically, `_shared/`
included (the leading underscore just keeps Wrangler from treating it as
a route, same trick as `_middleware.js`).

## One-time setup (if you haven't already)
```bash
npm install -g wrangler
wrangler login
```

## Steps

1. Copy `wrangler.toml`, `dist/index.html`, and the whole `functions/`
   folder into your repo, matching the layout above.

2. Commit and push:
   ```bash
   git add wrangler.toml dist/index.html functions
   git commit -m "Move Tavily/Kroger keys server-side via Pages Functions"
   git push
   ```

3. **Set your secrets** (one-time — these are encrypted by Cloudflare and
   never appear in your repo or the deployed HTML):
   ```bash
   npx wrangler pages secret put TAVILY_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put KROGER_CLIENT_ID --project-name=brokegirlsidequest
   npx wrangler pages secret put KROGER_CLIENT_SECRET --project-name=brokegirlsidequest
   ```
   Each command will prompt you to paste the value — paste it and hit enter.
   You can skip the two KROGER_* ones if you're not using that feature yet;
   the grocery tab will just fall back to search-based pricing until they're set.

   Optional — additional search engines. DuckDuckGo already works with
   none of these set, and every one you add here doesn't just backstop
   Tavily anymore — it's an ADDITIONAL engine `searchAllSources()` queries
   in parallel on every scan (see "Search: every engine, every scan"
   above), so each key you add increases both result quality/freshness
   AND per-scan cost:
   ```bash
   npx wrangler pages secret put SERPER_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put EXA_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put GOOGLE_AI_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put OPENAI_API_KEY --project-name=brokegirlsidequest
   ```
   `GOOGLE_AI_API_KEY` is the one key that does double duty: it powers
   Gemini's grounded web search tier above AND lets Gemini act as a
   classifier/"sorter AI" alongside whatever else is configured.
   `OPENAI_API_KEY` does the same on the ChatGPT side — a real
   platform.openai.com key with billing enabled, not a ChatGPT.com login —
   powering both ChatGPT's web search tier and a second sorter AI. Set
   both and every scan gets cross-checked by Gemini AND ChatGPT together,
   on both the search side and the classification side.

4. Deploy:
   ```bash
   npx wrangler pages deploy dist --project-name=brokegirlsidequest
   ```
   Wrangler will auto-detect the `functions/` folder and bundle it in.

5. Your live URL stays the same as before:
   ```
   https://brokegirlsidequest.pages.dev
   ```
   That's still the one to give Kroger's developer portal for the Redirect
   URI field, and the one to share with others — now with zero secrets
   exposed to anyone who views the page source.

## Re-deploying after future edits
```bash
cp your-updated-file.html dist/index.html
npx wrangler pages deploy dist --project-name=brokegirlsidequest
```
Only re-run the `secret put` commands if a key changes — they persist
across deploys otherwise.

## Updating a secret later
```bash
npx wrangler pages secret put TAVILY_API_KEY --project-name=brokegirlsidequest
```
Same command — it overwrites the existing value.

## Troubleshooting
- **Grocery tab shows "Kroger isn't configured on the server yet"** — the
  `KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET` secrets aren't set. It'll keep
  working via search-based pricing until you set them (step 3).
- **Search results seem thin or low-quality with no errors** — if
  `TAVILY_API_KEY` is unset/exhausted and `SERPER_API_KEY`/`EXA_API_KEY`
  aren't set either, requests are quietly falling all the way through to
  the DuckDuckGo HTML scrape — it works, but it's the weakest link in the
  chain. Set one of the paid-tier keys to improve quality.
- **CORS errors are gone** — that's the whole point of this setup. All
  outbound calls to Tavily/Serper/Exa/Kroger now happen server-side
  in the Function, so the browser never talks to those domains directly.
- **Functions not picked up on deploy** — double check `functions/` is a
  sibling of `dist/` (same folder as `wrangler.toml`), not nested inside
  `dist/`, and that `functions/_shared/search-providers.js` came along
  with it — `freebies.js`, `restaurant-deals.js`, and `grocery-price.js`
  all import from it and will fail to build without it.
