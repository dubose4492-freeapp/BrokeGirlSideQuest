// functions/_shared/llm-providers.js
//
// Shared LLM completion fallback chain, tried in this order until one
// succeeds (roughly most-generous-free-tier first):
//   1. OpenRouter     (env.OPENROUTER_API_KEY)   — gateway to 50+ free models
//   2. Groq            (env.GROQ_API_KEY)         — free, very fast Llama/Mixtral
//   3. Cerebras        (env.CEREBRAS_API_KEY)     — free, up to ~1M tokens/day
//   4. Mistral AI      (env.MISTRAL_API_KEY)      — free "Experiment" tier, ~1B tokens/month
//   5. Google AI Studio (env.GOOGLE_AI_API_KEY)   — free Gemini tier, up to ~1M tokens/day
//   6. Hugging Face    (env.HUGGINGFACE_API_KEY)  — free router across open models
//   7. Cohere          (env.COHERE_API_KEY)       — free trial, ~1,000 calls/month
//   8. OpenAI          (env.OPENAI_API_KEY)       — no free tier, placed last on purpose.
//                       This is what gives freebies.js / restaurant-deals.js their SECOND
//                       "sorter AI" — chatWithEnsemble() below runs every configured
//                       provider in parallel, so with both Google AI Studio and OpenAI
//                       keyed, Gemini AND ChatGPT independently classify/sort the same
//                       listings and get cross-checked against each other.
//
// grocery-price.js, freebies.js, and restaurant-deals.js used to call
// OpenRouter directly and skip straight to their regex fallback if it
// wasn't configured. This module lets ANY ONE of the seven keys above
// unlock the smarter LLM-based extraction/classification path — tried in
// the order listed, skipping whichever aren't configured — so someone who
// only signed up for, say, Groq and Mistral still gets LLM-quality
// results instead of only ever falling back to regex.
//
// Every provider function shares the same (env, prompt, options) ->
// { text, provider } shape. `options` supports { temperature, maxTokens }
// (both optional). Callers are expected to write prompts that instruct
// the model to return ONLY JSON, same convention as before — this module
// doesn't parse that JSON itself, callers still do that with their own
// regex/parsing.
//
// NOTE on Google AI Studio, Hugging Face, and Cohere: these three are NOT
// OpenAI-compatible chat/completions endpoints the way OpenRouter/Groq/
// Cerebras/Mistral are, so they're implemented against each provider's own
// request/response shape below. Any single provider's API surface can
// drift over time — if one of these three starts erroring, check that
// provider's current docs first. Since this is a fallback CHAIN and not an
// all-or-nothing dependency, the other six keep the feature working
// either way.

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0;

// ---------- OpenAI-compatible providers (OpenRouter, Groq, Cerebras, Mistral, Hugging Face) ----------
async function openaiCompatibleChat(url, apiKey, model, prompt, options, providerName) {
  const { temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS } = options;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${providerName} chat failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error(`${providerName} returned an empty response.`);
  return { text, provider: providerName };
}

export async function openrouterChat(env, prompt, options = {}) {
  const model = env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";
  return openaiCompatibleChat("https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_API_KEY, model, prompt, options, "openrouter");
}

export async function groqChat(env, prompt, options = {}) {
  // Groq deprecated llama-3.3-70b-versatile (announced June 17, 2026,
  // shuts down August 16, 2026) in favor of openai/gpt-oss-120b or
  // qwen/qwen3.6-27b. Using gpt-oss-120b as the new default so this
  // doesn't go dark right after the shutdown date.
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  return openaiCompatibleChat("https://api.groq.com/openai/v1/chat/completions", env.GROQ_API_KEY, model, prompt, options, "groq");
}

export async function cerebrasChat(env, prompt, options = {}) {
  // llama3.1-70b was deprecated in favor of llama-3.3-70b, which Cerebras
  // has SINCE also deprecated (in favor of gpt-oss-120b) — so this now
  // points straight at the current recommended model instead of a model
  // that's already been retired twice over.
  const model = env.CEREBRAS_MODEL || "gpt-oss-120b";
  return openaiCompatibleChat("https://api.cerebras.ai/v1/chat/completions", env.CEREBRAS_API_KEY, model, prompt, options, "cerebras");
}

export async function mistralChat(env, prompt, options = {}) {
  const model = env.MISTRAL_MODEL || "mistral-small-latest";
  return openaiCompatibleChat("https://api.mistral.ai/v1/chat/completions", env.MISTRAL_API_KEY, model, prompt, options, "mistral");
}

// Hugging Face's OpenAI-compatible "router" endpoint. Model names need the
// full org/model form (e.g. "meta-llama/Llama-3.3-70B-Instruct"), not a
// bare Groq/Mistral-style slug, since it's routing across several
// different underlying inference providers behind the scenes.
export async function huggingfaceChat(env, prompt, options = {}) {
  const model = env.HUGGINGFACE_MODEL || "meta-llama/Llama-3.3-70B-Instruct";
  return openaiCompatibleChat("https://router.huggingface.co/v1/chat/completions", env.HUGGINGFACE_API_KEY, model, prompt, options, "huggingface");
}

// OpenAI's own chat completions endpoint — this is OpenAI-compatible by
// definition, so it reuses the same helper as OpenRouter/Groq/Cerebras/
// Mistral above. This is a real OpenAI platform API key with billing
// enabled (platform.openai.com), not a ChatGPT.com login — a browser
// session isn't usable here, this is a server-to-server API call.
export async function openaiChat(env, prompt, options = {}) {
  const model = env.OPENAI_CHAT_MODEL || "gpt-5.4";
  return openaiCompatibleChat("https://api.openai.com/v1/chat/completions", env.OPENAI_API_KEY, model, prompt, options, "openai");
}

// ---------- Provider-specific formats ----------

// Google AI Studio / Gemini — REST API, not OpenAI-shaped: the prompt goes
// in contents[].parts[].text, the key is a URL query param (not a Bearer
// header), and token/temperature limits live under generationConfig.
export async function geminiChat(env, prompt, options = {}) {
  const { temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS } = options;
  // gemini-1.5-flash is fully shut down (404s on every request) — all
  // Gemini 1.0/1.5 models were retired. gemini-3.5-flash is GA with no
  // announced shutdown date as of this writing; gemini-2.5-flash also
  // still works today but is already scheduled to retire Oct 16, 2026,
  // so it's not a great long-lived default.
  const model = env.GOOGLE_AI_MODEL || "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_AI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google AI Studio chat failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  if (!text) throw new Error("Google AI Studio returned an empty response.");
  return { text, provider: "google-ai-studio" };
}

// Cohere's Chat v2 API — also not OpenAI-shaped: the reply comes back as
// message.content[0].text rather than choices[0].message.content.
export async function cohereChat(env, prompt, options = {}) {
  const { temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS } = options;
  const model = env.COHERE_MODEL || "command-r";
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.COHERE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Cohere chat failed (${res.status}). ${errBody.slice(0, 150)}`);
  }
  const data = await res.json();
  const text = (data.message?.content?.[0]?.text || "").trim();
  if (!text) throw new Error("Cohere returned an empty response.");
  return { text, provider: "cohere" };
}

// ---------- Fallback chain ----------
const PROVIDERS = [
  { name: "openrouter", key: "OPENROUTER_API_KEY", fn: openrouterChat },
  { name: "groq", key: "GROQ_API_KEY", fn: groqChat },
  { name: "cerebras", key: "CEREBRAS_API_KEY", fn: cerebrasChat },
  { name: "mistral", key: "MISTRAL_API_KEY", fn: mistralChat },
  { name: "google-ai-studio", key: "GOOGLE_AI_API_KEY", fn: geminiChat },
  { name: "huggingface", key: "HUGGINGFACE_API_KEY", fn: huggingfaceChat },
  { name: "cohere", key: "COHERE_API_KEY", fn: cohereChat },
  { name: "openai", key: "OPENAI_API_KEY", fn: openaiChat }
];

// True if at least one LLM provider is configured. Callers use this
// instead of checking env.OPENROUTER_API_KEY directly, so any one of the
// seven keys is enough to unlock the LLM-based extraction/classification
// path instead of falling straight to the regex fallback.
export function anyLLMConfigured(env) {
  return PROVIDERS.some(p => env[p.key]);
}

// True if 2+ LLM providers are configured. Ensembling (chatWithEnsemble
// below) only buys anything when there's a second model to cross-check
// against — with just one key configured it's pure wasted cost, so
// callers should check this before opting into ensemble mode.
export function multipleLLMsConfigured(env) {
  return PROVIDERS.filter(p => env[p.key]).length >= 2;
}

// Walks the provider list in order, skipping any whose key isn't set in
// env, and returns { text, provider } from the first one that succeeds.
// Mirrors searchWithFallback()'s shape/behavior in search-providers.js —
// same idea, applied to chat completions instead of web search.
export async function chatWithFallback(env, prompt, options = {}) {
  const configured = PROVIDERS.filter(p => env[p.key]);
  if (!configured.length) {
    throw new Error("No LLM provider configured (checked OPENROUTER_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, GOOGLE_AI_API_KEY, HUGGINGFACE_API_KEY, COHERE_API_KEY, OPENAI_API_KEY).");
  }
  const failures = [];
  for (const p of configured) {
    try {
      const result = await p.fn(env, prompt, options);
      console.log(`[llm] ${p.name} OK`);
      return result;
    } catch (err) {
      console.warn(`[llm] ${p.name} FAILED — ${err.message}`);
      failures.push(`${p.name}: ${err.message}`);
    }
  }
  throw new Error(`All LLM providers failed — ${failures.join(" | ")}`);
}

// Runs EVERY configured provider IN PARALLEL and returns every successful
// { text, provider } result (not just the first, unlike chatWithFallback).
// Deliberately NOT the default path — it multiplies LLM API calls by
// however many providers are configured, so callers should only reach for
// this in specific situations where that extra cost buys real accuracy
// back: e.g. when the web-search step fell back to DuckDuckGo's thinner
// snippets, cross-checking several models' extractions against each other
// catches a single model's misreads/hallucinations on ambiguous text that
// chatWithFallback's "first success wins" never would.
export async function chatWithEnsemble(env, prompt, options = {}) {
  const configured = PROVIDERS.filter(p => env[p.key]);
  if (!configured.length) {
    throw new Error("No LLM provider configured (checked OPENROUTER_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, GOOGLE_AI_API_KEY, HUGGINGFACE_API_KEY, COHERE_API_KEY, OPENAI_API_KEY).");
  }
  const settled = await Promise.allSettled(configured.map(p => p.fn(env, prompt, options)));
  const results = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      console.log(`[llm] ${configured[i].name} OK (ensemble)`);
      results.push(s.value);
    } else {
      console.warn(`[llm] ${configured[i].name} FAILED (ensemble) — ${s.reason.message}`);
    }
  });
  if (!results.length) throw new Error("All LLM providers failed in ensemble mode.");
  return results;
}
