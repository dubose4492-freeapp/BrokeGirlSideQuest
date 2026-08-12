// functions/_shared/fetch-timeout.js
//
// Drop-in replacement for `fetch()` that always aborts after a fixed
// timeout. Every upstream call in this app (Kroger auth/location/product,
// every search-provider tier, every LLM provider, gas's oilpriceapi call)
// used to be a bare `await fetch(...)` with nothing bounding how long it
// could hang. Cloudflare Pages Functions will eventually kill a stuck
// invocation on its own wall-clock limit, but that's minutes, not seconds —
// and a grocery scan makes 11 sequential /api/grocery-price calls, each of
// which can internally try several search/LLM providers in turn. One
// unresponsive provider on one item was enough to make the whole scan look
// hung, with nothing the client could do about it short of the Stop button
// (which cancels the *client's* fetch, not whatever the server was still
// waiting on).
//
// Behavior:
//  - Aborts and rejects (fetch throws a DOMException named "AbortError")
//    once `timeoutMs` elapses. Every existing call site already treats a
//    thrown/rejected fetch as "this provider/tier failed, fall through" —
//    see the try/catch around each provider in search-providers.js and
//    llm-providers.js, and the null-return-on-throw pattern in
//    grocery-price.js/gas-price.js — so no caller-side logic needs to
//    change, just the import.
//  - If the caller already passed its own `signal` (none currently do,
//    but keeps this safe to reuse later), that signal is chained in too:
//    aborting either one aborts the request.
const DEFAULT_TIMEOUT_MS = 8000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}
