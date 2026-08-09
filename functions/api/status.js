// GET /api/status
//
// The one operational gap flagged in the code review: both quota.js and
// rate-limit.js are deliberately FAIL-OPEN when their KV namespace isn't
// bound (see those files' headers) — which is the right default so a
// missing binding never breaks the app for real users, but it also means
// there's no visible signal when that happens. Tier rotation silently
// stays on Tier 1 forever; rate limiting silently allows everything.
//
// This endpoint exists so that's checkable in one request instead of
// having to read wrangler.toml or infer it from behavior:
//   curl https://<your-app>.pages.dev/api/status
//
// It reports binding presence only — never any secret values, key
// contents, or counts (this is a status check, not a diagnostics dump).
export async function onRequestGet({ env }) {
  const rateLimitBound = !!env.RATE_LIMIT_KV;
  const quotaBound = !!env.QUOTA_KV;

  const warnings = [];
  if (!rateLimitBound) {
    warnings.push(
      "RATE_LIMIT_KV is not bound — per-IP rate limiting is OFF (every request is allowed). See DEPLOY_INSTRUCTIONS.md → 'Security: rate limiting'."
    );
  }
  if (!quotaBound) {
    warnings.push(
      "QUOTA_KV is not bound — search-tier usage always reads as 0, so the app stays on Tier 1 (Tavily) forever instead of ever advancing to Serper/Exa/DuckDuckGo. See DEPLOY_INSTRUCTIONS.md → 'Setting up quota tracking'."
    );
  }

  return new Response(
    JSON.stringify({
      ok: warnings.length === 0,
      bindings: {
        RATE_LIMIT_KV: rateLimitBound,
        QUOTA_KV: quotaBound
      },
      warnings
    }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
