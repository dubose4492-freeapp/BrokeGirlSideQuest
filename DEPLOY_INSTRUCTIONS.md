# Deploying Daily Free Finder to Cloudflare Pages (with a real backend)

## What changed
Your Tavily and Kroger credentials no longer live in the HTML file at all —
they never reach the browser. Cloudflare Pages Functions hold them as
encrypted secrets and proxy the requests server-side:

- `functions/api/search.js`         → generic proxy to Tavily (kept for
  compatibility; no tab calls this directly anymore)
- `functions/api/grocery-price.js`  → does the whole Kroger OAuth + store
  lookup + product price flow, and just returns a price to the browser
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

### Search now has a 4-deep fallback chain
All three search-using endpoints (`freebies.js`, `restaurant-deals.js`,
`grocery-price.js`) now share one provider chain:

1. **Tavily** (`TAVILY_API_KEY`)
2. **Serper.dev** (`SERPER_API_KEY`) — 2,500 queries, one-time free tier
3. **Exa** (`EXA_API_KEY`) — $10 credit, one-time free tier
4. **DuckDuckGo** — no key, no signup, effectively unlimited

Brave was left out of the chain on purpose. Each remaining provider is
only tried if every provider before it is either unconfigured (no secret
set) or actually fails (errors, hits its cap, etc.) — this isn't
round-robin, it always prefers Tavily first when available. Steps 1–3
need a secret each; step 4 needs nothing and always runs as the final
safety net, so **search now works even on a brand-new deploy with zero
search secrets configured** — it just uses DuckDuckGo's HTML results
until you add better-quality keys. That chain lives in one shared file,
`functions/_shared/search-providers.js`, imported by all three endpoints
so there's only one place to tune it.

One caveat: DuckDuckGo has no official free web-search API, so that last
step works by fetching and parsing DDG's plain HTML results page. It's
the most fragile link in the chain — if DuckDuckGo changes their page
markup, that step will start quietly returning fewer or zero results
instead of erroring. It's meant as a "search still basically works"
floor, not a long-term primary provider.

### Optional: caching search results
`searchWithFallback()` (in `functions/_shared/search-providers.js`) can now
cache results in a Cloudflare KV namespace for 20 minutes. This is **fully
optional and fails open** — nothing else changed, no call site was touched,
and if you never set up the KV namespace below, the app behaves exactly as
it did before: a live provider call on every search, same as always.

Why bother: a single "run quest" scan already fires several searches
(general pass + priority-source pass per tab, plus one more per offer to
resolve its real "Claim" link) — caching means near-duplicate queries fired
seconds apart share one result instead of separately burning your Tavily/
Serper/Exa quota, which is the scarce resource in this app's whole
fallback-chain design.

To turn it on:
1. `wrangler kv:namespace create SEARCH_CACHE`
2. Copy the `id` it prints into `wrangler.toml`, uncommenting the
   `[[kv_namespaces]]` block and filling in `id = "..."`
3. Redeploy

To turn it off again, just remove/comment that block — no code change
needed, `search-providers.js` checks for the binding and skips caching
entirely if it isn't there.

Note the cache is intentionally short-lived (20 minutes) and separate from
the category freshness windows in `freebies.js`/`restaurant-deals.js`
(14–30 days, which filter *how old the underlying offer is allowed to be*)
— the cache just avoids re-fetching the *same* search twice in a short
window, it doesn't change what counts as a stale offer.

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

   Optional — additional search fallbacks, only needed once Tavily
   quota is a problem (DuckDuckGo already works with none of these set):
   ```bash
   npx wrangler pages secret put SERPER_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put EXA_API_KEY --project-name=brokegirlsidequest
   ```

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
