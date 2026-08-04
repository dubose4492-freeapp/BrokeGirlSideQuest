# Deploying Daily Free Finder to Cloudflare Pages

## Files in this package
- `dist/index.html`   ← your app, renamed to index.html (required for it to load at the root URL)
- `wrangler.toml`      ← tells Wrangler this is a static Pages site

## One-time setup (if you haven't already)
```bash
npm install -g wrangler
wrangler login
```
This opens a browser window to authorize Wrangler with your Cloudflare account.

## Steps to add this to your existing repo

1. Copy `wrangler.toml` into the ROOT of your repo (same level as your .git folder).
2. Create a `dist` folder in your repo root if it doesn't exist, and put your HTML file
   inside it renamed to `index.html`:
   ```bash
   mkdir -p dist
   cp daily-free-finder-standalone_7.html dist/index.html
   ```
   (Adjust the filename to whatever your current HTML file is called.)

3. Commit and push:
   ```bash
   git add wrangler.toml dist/index.html
   git commit -m "Add Cloudflare Pages config for static deploy"
   git push
   ```

4. Deploy:
   ```bash
   npx wrangler pages deploy dist --project-name=daily-free-finder
   ```
   First time you run this, Wrangler will ask you to confirm creating a new Pages
   project called `daily-free-finder`. Say yes.

5. Wrangler will print a live URL like:
   ```
   https://daily-free-finder.pages.dev
   ```
   That's the URL you can give to Kroger's developer portal for the Redirect URI field,
   and the one you can share with others.

## Re-deploying after future edits
Anytime you update the HTML file, just:
```bash
cp your-updated-file.html dist/index.html
npx wrangler pages deploy dist --project-name=daily-free-finder
```
No need to touch wrangler.toml again — it stays the same.

## Troubleshooting
- **"Could not detect a directory containing static files"** — you're missing the
  `[assets]` block in wrangler.toml, or you ran `wrangler deploy` instead of
  `wrangler pages deploy dist`. Static single-file sites should always use the
  `pages deploy` command shown above.
- **Wrangler asks about Workers vs Pages** — always choose Pages for this project;
  Workers is for server-side code, which this app doesn't need since it calls the
  Tavily/Kroger APIs directly from the browser.
- **CORS errors calling Kroger's API from the live site** — this is a separate issue
  from deployment; the site itself will still load fine even if that API call fails,
  it just falls back to search results (as designed).
