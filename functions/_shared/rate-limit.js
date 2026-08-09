// functions/_shared/rate-limit.js
//
// Simple per-IP rate limiter for the API endpoints that spend real money/
// quota (freebies, restaurant-deals, grocery-price). Goal is narrow and
// deliberate: stop a SCRIPT from hammering an endpoint hundreds of times a
// minute to drain search/LLM/Kroger quota, without ever getting in the way
// of a real person using the app a lot through the browser.
//
// This is a FIXED-WINDOW counter stored in a Cloudflare KV namespace bound
// as RATE_LIMIT_KV (see wrangler.toml). This is a dedicated binding, not
// shared with anything else in the app — nothing else depends on it, so
// turning this on or off never affects search results themselves.
//
// Deliberately NOT trying to be a perfect/atomic distributed rate limiter —
// KV reads/writes aren't atomic, so under truly simultaneous requests a
// determined attacker could squeeze a few extra calls past the limit. For
// what this app actually needs (stop casual/scripted quota drain, not
// defend a bank), a best-effort counter is the right amount of complexity.
//
// FAIL OPEN: if the KV binding isn't configured, or KV itself errors, every
// request is allowed through. An optional protection layer breaking should
// never mean the app stops working for real users — same philosophy as the
// search cache and the provider fallback chains elsewhere in this codebase.

// Generous on purpose. A real person running a full "scan all tabs" pass,
// re-scanning a few times, and browsing for a while does NOT come close to
// these numbers — this is sized to catch sustained scripted hammering, not
// enthusiastic normal use.
const DEFAULT_LIMIT = 60;          // max requests...
const DEFAULT_WINDOW_SECONDS = 300; // ...per 5-minute window, per IP, per endpoint

function clientIp(request) {
  // Cloudflare sets this on every request; it's the real connecting IP and
  // can't be spoofed by the client the way a plain X-Forwarded-For could.
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// Returns { allowed, remaining, limit }. `bucket` should be a short string
// identifying which endpoint this is for (e.g. "freebies") so limits on
// different endpoints don't share one counter.
export async function checkRateLimit(env, request, bucket, options = {}) {
  const { limit = DEFAULT_LIMIT, windowSeconds = DEFAULT_WINDOW_SECONDS } = options;

  if (!env.RATE_LIMIT_KV) {
    // No KV bound — can't count anything, so don't pretend to protect
    // anything. See DEPLOY_INSTRUCTIONS.md for the one-time setup.
    return { allowed: true, remaining: limit, limit, enforced: false };
  }

  const ip = clientIp(request);
  const windowBucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `ratelimit:${bucket}:${ip}:${windowBucket}`;

  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= limit) {
      return { allowed: false, remaining: 0, limit, enforced: true };
    }
    // TTL a bit longer than the window so a request right at the edge of a
    // window still expires cleanly rather than lingering forever.
    await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
    return { allowed: true, remaining: limit - (count + 1), limit, enforced: true };
  } catch (err) {
    // KV outage or similar — fail open rather than blocking real users
    // because an optional safety layer had a bad moment.
    console.warn(`[rate-limit] check failed, allowing request — ${err.message}`);
    return { allowed: true, remaining: limit, limit, enforced: false };
  }
}

// Standard 429 response shape, matching the { error } pattern every
// endpoint already uses for its other error responses.
export function rateLimitResponse() {
  return new Response(
    JSON.stringify({ error: "You're scanning a bit fast — give it a few minutes and try again." }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}
