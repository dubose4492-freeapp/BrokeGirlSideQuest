// POST /api/search
// Proxies to Tavily so the API key never reaches the browser.
// The client sends the same body it used to send Tavily directly,
// minus api_key — this function adds that from the server secret.
export async function onRequestPost({ request, env }) {
  let clientBody;
  try {
    clientBody = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  if (!env.TAVILY_API_KEY) {
    return json({ error: "Search isn't configured on the server yet (missing TAVILY_API_KEY secret)." }, 500);
  }

  const upstreamBody = { ...clientBody, api_key: env.TAVILY_API_KEY };

  let upstream;
  try {
    upstream = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody)
    });
  } catch (err) {
    return json({ error: `Could not reach Tavily: ${err.message}` }, 502);
  }

  const text = await upstream.text();
  // Pass Tavily's response straight through (status + body) so the
  // front-end's existing error handling keeps working unchanged.
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" }
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
