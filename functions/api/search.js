// POST /api/search — DISABLED.
//
// This used to be a generic pass-through proxy to Tavily: it took whatever
// JSON body a caller sent and forwarded it straight to Tavily with your
// server-side API key attached. Nothing in the current app calls this
// endpoint anymore (freebies.js, restaurant-deals.js, and grocery-price.js
// all go through functions/_shared/search-providers.js instead, which adds
// the provider fallback chain, freshness filtering, and rate limiting).
//
// Left live, an open unauthenticated proxy like this is a direct path for
// anyone who finds the URL to spend your Tavily quota with completely
// arbitrary queries — no rate limit could fully close that off since it
// forwarded whatever the caller asked for. Since it's unused, the
// straightforward fix is disabling it rather than hardening something
// nothing needs.
//
// If you ever DO need a generic search proxy again, don't resurrect this —
// build a new endpoint that goes through searchWithFallback() in
// _shared/search-providers.js so it gets the same rate limiting and
// caching every other endpoint has.
export async function onRequestPost() {
  return new Response(
    JSON.stringify({ error: "This endpoint is no longer available." }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
}
