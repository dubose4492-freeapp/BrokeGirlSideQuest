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
  "See Details" link. Clothing, Toys, Accessories, Events, and Mail also
  accept the same "spend $10 or less, get an item free" / BOGO rule
  restaurant-deals.js already applies to food deals (Grocery and Community
  are excluded — Grocery is priced item-by-item, Community resources are
  already fully free). The Events tab additionally treats "isLocal" as a
  drive-distance signal — only a real, physical, 100%-free event within
  the radius the person set counts, not something nationwide/online with
  no venue nearby.

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

### Search: strict tiers, not "every engine every scan"
All four search-using endpoints (`freebies.js`, `restaurant-deals.js`,
`grocery-price.js`, `gas-price.js`) share one provider layer in
`functions/_shared/search-providers.js`, built around FOURTEEN TIERS instead
of firing every engine on every call — every free-tier, no-credit-card web
search API worth wiring in, stacked so the app burns through generous
renewing tiers first, then one-time allotments, and only falls back to the
always-on (but weaker) scrapers once every paid-adjacent free tier is spent:

| Tier | Primary engine | Free allotment | Advances once... |
|---|---|---|---|
| 1 | **Tavily** | 1,000/mo | quota used up (resets next month) |
| 2 | **ContextWire** | 1,000/mo | quota used up (resets next month) |
| 3 | **Firecrawl** | ~500 searches/mo (1,000 credits) | quota used up (resets next month) |
| 4 | **Exa** | ~1,000 calls/mo ($10 recurring credit, approximated) | quota used up (resets next month) |
| 5 | **Linkup** | ~1,000 calls/mo ($5 recurring credit, approximated) | quota used up (resets next month) |
| 6 | **Zenserp** | 50/mo | quota used up (resets next month) |
| 7 | **Olostep** | 500 credits, ~100 searches assumed (unverified — see below) | quota used up (assumed to reset next month — unconfirmed) |
| 8 | **Serper.dev** | 2,500 total | one-time allotment used up, never resets |
| 9 | **Searlo** | 3,000 total | one-time allotment used up, never resets |
| 10 | **Search1API** | 100 total | one-time allotment used up, never resets |
| 11 | **SearchApi.io** | 100 total | one-time allotment used up, never resets |
| 12 | **Value SERP** | 100 total | one-time allotment used up, never resets |
| 13 | **Serpent API** | 10 total | one-time allotment used up, never resets |
| 14 | **DuckDuckGo** (scrape) | unlimited | never — this is the terminal floor |

Every tier also carries the same parallel "extras" as before — Gemini
(grounded search), OpenAI/ChatGPT (web_search tool), and Google CSE — plus
SearXNG (only if you self-host one, see `SEARXNG_URL` below) riding along
in Tier 14 alongside DuckDuckGo. None of the extras are quota-tracked;
only the bolded primary in each row is.

**On Tier 7 (Olostep):** its request/response shape is confirmed against
live docs, but its free-tier *cadence* is not — Olostep's own site
describes it in one place as a plain "free plan" and in another as "500
free monthly credits," while an independent comparison page calls it "a
500-request one-time trial rather than a recurring monthly allotment."
It's placed in the monthly-renewing group per the "monthly credits"
wording, but if your credits stop resetting, move it to the one-time
group in `TIER_DEFS` (`search-providers.js`) and change its `period` to
`"total"`. Its per-search credit cost is also assumed (5 credits/search,
~100 searches from 500 credits) rather than confirmed — Olostep only
documents a per-request cost for its separate Answers endpoint (20
credits), not for the Search endpoint this app calls. Check your Olostep
dashboard after some real usage and set `OLOSTEP_MONTHLY_LIMIT`
accordingly.

**Not wired in, on purpose:** Parallel Search's free tier is MCP-protocol-
only (no plain REST endpoint a `fetch()` call can hit), and InfoMesh is a
decentralized P2P Python package (libp2p/Kademlia DHT) that needs real TCP
sockets — neither can run inside a Cloudflare Worker. NewsCatcher was
checked and skipped: its real News API (v3) has no free tier at all
($50-500/mo), and the separate old "Free News API" is non-commercial-only
and news-article-specific — a poor fit for giveaway/deal-finding queries.

Only the ACTIVE tier's engines get called — a later tier is never touched
while an earlier one still has quota left. The bolded engine in each row is
that tier's *primary*; quota is tracked only against it (via
`functions/_shared/quota.js`, KV-backed — see setup below). Gemini and
OpenAI ride along inside whichever tier is active as cross-checking
extras and aren't quota-tracked themselves.

Within one tier, the main per-scan result list (`searchAllSources()`)
fires that tier's engines in parallel and merges/de-dupes them by URL, a
listing found by more than one engine gets tagged with all of them, same
as before. If a whole tier's engines all fail outright on one call, it
falls through to the next tier down as a one-off resilience measure —
that never changes which tier is considered "active" for future calls,
only quota usage does that.

Narrower, single-answer lookups (e.g. "find this one company's official
site" so the Claim button points somewhere real) use `searchWithFallback()`
— tries the active tier's engines one at a time (primary first) instead of
firing all of them, since a lookup with only one right answer doesn't need
parallel cross-checking.

The classification/"sorter AI" step right after search is unchanged:
`chatWithEnsemble()` in `llm-providers.js` runs every configured LLM
provider in parallel (OpenRouter, Groq, Cerebras, Mistral, Google AI
Studio, Hugging Face, Cohere, OpenAI), so with two or more keyed, several
models independently classify/sort the same raw search results and get
cross-checked against each other before anything reaches the app.

**Cost note:** because only one tier is ever active at a time, this
spends noticeably less quota per scan than the old "fire every engine"
design did — Tier 1 alone runs Tavily+Gemini+OpenAI, not all six engines.
OpenAI's `web_search` tool rides along in every tier though, and OpenAI
has no free tier at all, so once `OPENAI_API_KEY` is set it spends real
money on every scan regardless of which tier is active. Worth watching
your provider dashboards once this is live.

One caveat: DuckDuckGo (Tier 14) has no official free web-search API, so
that step works by fetching and parsing DDG's plain HTML results page.
It's the most fragile engine in the whole chain — if DuckDuckGo changes
their page markup, it'll start quietly returning fewer or zero results
instead of erroring. It's meant as a "search still basically works"
floor once every paid/free-credit tier above it is exhausted, not a
long-term primary provider.

#### Setting up quota tracking (so tiers actually advance)
Without a bound `QUOTA_KV` namespace, usage always reads as 0 used, so the
app stays on Tier 1 forever (as long as `TAVILY_API_KEY` is set) instead
of ever rotating to Serper/Exa/DuckDuckGo — same fail-open philosophy as
rate limiting below, just means the tiers don't actually rotate until you
set this up:

1. `wrangler kv:namespace create QUOTA_KV` (use a namespace separate from
   `RATE_LIMIT_KV` — they should never share keys)
2. Copy the `id` it prints into `wrangler.toml`, uncommenting the second
   `[[kv_namespaces]]` block and filling in `id = "..."`
3. (Optional) Uncomment the `[vars]` block below it to override any tier's
   default quota cap (`TAVILY_MONTHLY_LIMIT`, `SERPER_TOTAL_LIMIT`,
   `EXA_CALL_LIMIT`) if your actual plan differs from the built-in defaults
4. Redeploy

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
   none of these set, and every key below UNLOCKS ONE MORE TIER — it never
   fires on every scan, only once every tier above it in the table has run
   out (see the 14-tier table above). Set as many or as few as you want;
   any tier whose key is missing is just skipped over.
   ```bash
   npx wrangler pages secret put CONTEXTWIRE_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put FIRECRAWL_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put EXA_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put LINKUP_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put ZENSERP_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put OLOSTEP_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put SERPER_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put SEARLO_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put SEARCH1API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put SEARCHAPI_IO_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put VALUESERP_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put SERPENT_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put GOOGLE_AI_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put OPENAI_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put GOOGLE_CSE_API_KEY --project-name=brokegirlsidequest
   npx wrangler pages secret put GOOGLE_CSE_ENGINE_ID --project-name=brokegirlsidequest
   ```
   Where to sign up for each (all no-credit-card free tiers, verified
   against live docs as of this writing):
   - ContextWire — https://contextwire.dev
   - Firecrawl — https://firecrawl.dev (key starts with `fc-`)
   - Exa — https://exa.ai
   - Linkup — https://linkup.so
   - Zenserp — https://zenserp.com
   - Olostep — https://www.olostep.com (500 free credits — see
     search-providers.js's header comment for an unresolved conflict in
     Olostep's own docs over whether these renew monthly or are a
     one-time trial; worth checking your dashboard before relying on it)
   - Serper.dev — https://serper.dev
   - Searlo — https://searlo.tech
   - Search1API — https://www.search1api.com (100 free credits, one-time)
   - SearchApi.io — https://searchapi.io
   - Value SERP — https://valueserp.com
   - Serpent API — https://apiserpent.com
   `GOOGLE_AI_API_KEY` is the one key that does double duty: it powers
   Gemini's grounded web search tier above AND lets Gemini act as a
   classifier/"sorter AI" alongside whatever else is configured.
   `OPENAI_API_KEY` does the same on the ChatGPT side — a real
   platform.openai.com key with billing enabled, not a ChatGPT.com login —
   powering both ChatGPT's web search tier and a second sorter AI. Set
   both and every scan gets cross-checked by Gemini AND ChatGPT together,
   on both the search side and the classification side.

   `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ENGINE_ID` together add Google's own
   Custom Search JSON API as a fourth ride-along search engine (alongside
   Gemini/OpenAI) in every tier — a different, ToS-compliant path to real
   Google search results than Serper.dev's proxy above. You need BOTH
   values, from two different places:
   - `GOOGLE_CSE_API_KEY`: a Custom Search API key from Google Cloud Console
   - `GOOGLE_CSE_ENGINE_ID`: the "Search engine ID" (cx) from a search
     engine you configure at https://programmablesearchengine.google.com —
     set it to search the entire web, not a specific site
   Free tier is 100 queries/day (separate from Serper's one-time 2,500 and
   Tavily's monthly allotment); past that it's billed per Google's pricing.
   It's an unmetered extra like OpenAI, not one of the quota-tracked
   primaries, so this app doesn't try to track that daily cap itself.

   `FIRECRAWL_API_KEY` is its own quota-tracked TIER now (Tier 3), not just
   a ride-along extra — Firecrawl's real 1,000-credit/month cap (2 credits
   per 10-result search, ~500 searches/mo) is tracked the same way Tavily's
   is, so it advances to the next tier once it's actually used up instead
   of silently over-running its free allowance.

   `SEARXNG_URL` is different from every other key above: it's not a hosted
   API you sign up for, it's the URL of a SearXNG instance YOU run yourself
   (Docker, a free-tier VPS, etc. — see https://docs.searxng.org). If set,
   it rides along as an extra in Tier 14 next to DuckDuckGo — genuinely
   unlimited once it's running, since there's no vendor rate limit on your
   own server. Your instance needs `json` enabled under `search.formats` in
   its `settings.yml` (off by default) for this app to parse its results.
   ```bash
   npx wrangler pages secret put SEARXNG_URL --project-name=brokegirlsidequest
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

## "Add to Home Screen"
`dist/` now includes a `manifest.webmanifest` and an `icons/` folder (the
same pixel-controller mark as the browser-tab favicon, rendered as opaque
PNGs at 32/192/512px plus a 180px `apple-touch-icon.png` for iOS). No setup
needed — these are static files and deploy automatically with the rest of
`dist/`.

A banner also appears at the top of the screen the first time someone taps
Scan (on phone-width screens only — it's hidden above 720px), showing
platform-appropriate steps: an "Install" button that triggers Chrome/
Android's native install prompt where supported, or manual Share-menu
steps on iOS Safari (which has no programmatic install trigger). Dismissing
it (✕) sets a `localStorage` flag so it never shows again for that visitor.
No code changes needed to adjust it — it's plain HTML/CSS/JS in `dist/index.html`
(search for `a2hsBanner`).

## Checking your KV setup
Both `RATE_LIMIT_KV` and `QUOTA_KV` fail open on purpose if you forget to
bind them — the app keeps working either way, it just silently loses that
one protection (see the comments in `functions/_shared/rate-limit.js` and
`functions/_shared/quota.js`). Instead of digging through `wrangler.toml`
to check, hit:
```
https://brokegirlsidequest.pages.dev/api/status
```
It reports whether each namespace is actually bound and calls out exactly
what's missing — no secrets or counts, just binding presence.

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
