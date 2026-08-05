# Deploying Daily Free Finder to Cloudflare Pages (with a real backend)

## What changed
Your Tavily and Kroger credentials no longer live in the HTML file at all —
they never reach the browser. Two Cloudflare Pages Functions hold them as
encrypted secrets and proxy the requests server-side:

- `functions/api/search.js`         → proxies to Tavily
- `functions/api/grocery-price.js`  → does the whole Kroger OAuth + store
  lookup + product price flow, and just returns a price to the browser

## Files in this package
```
wrangler.toml
dist/
  index.html          ← your app (unchanged UI/logic otherwise)
functions/
  api/
    search.js
    grocery-price.js
```
`functions/` must sit at the ROOT of your repo, as a sibling of `dist/` —
not inside it. Wrangler looks for it there automatically.

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
- **"Search isn't configured on the server yet"** — `TAVILY_API_KEY` isn't
  set. Nothing will load until you set it.
- **CORS errors are gone** — that's the whole point of this setup. All
  outbound calls to Tavily/Kroger now happen server-side in the Function,
  so the browser never talks to those domains directly.
- **Functions not picked up on deploy** — double check `functions/` is a
  sibling of `dist/` (same folder as `wrangler.toml`), not nested inside
  `dist/`.
