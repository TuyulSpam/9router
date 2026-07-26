// Pure helpers for Claude Code CLI-tool setup: resolve per-tier default models
// from the live catalog instead of hardcoded (and quickly-stale) version strings.
// Side-effect free so unit tests need no filesystem.

export const CLAUDE_TIER_ENV_KEYS = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};

// First id whose model name contains the tier keyword wins.
const TIER_KEYWORDS = { opus: "opus", sonnet: "sonnet", haiku: "haiku" };

/**
 * Resolve a default model id for each Claude tier from the current catalog.
 *
 * @param {{ models?: string[], currentEnv?: object }} opts
 *   models: flat list of Claude-capable model ids (e.g. "cc/claude-opus-4-8").
 *   currentEnv: existing claude settings.env — a still-valid value is preserved.
 * @returns {{opus: string|null, sonnet: string|null, haiku: string|null}}
 */
export function resolveClaudeSuggestedModels({ models = [], currentEnv = {} } = {}) {
  const ids = Array.isArray(models) ? models.filter(Boolean) : [];
  const idSet = new Set(ids);
  const out = { opus: null, sonnet: null, haiku: null };

  for (const tier of Object.keys(TIER_KEYWORDS)) {
    // 1) keep the currently-configured model if it is still in the catalog
    const cur = currentEnv?.[CLAUDE_TIER_ENV_KEYS[tier]];
    if (cur && idSet.has(cur)) {
      out[tier] = cur;
      continue;
    }

    // 2) first id whose tail (model name) contains the tier keyword
    const kw = TIER_KEYWORDS[tier];
    const byName = ids.find((id) => {
      const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
      return tail.toLowerCase().includes(kw);
    });

    // 3) fall back to the first available model so a tier is never empty
    out[tier] = byName || ids[0] || null;
  }

  return out;
}

// Anthropic requires a version header; this is a widely-supported stable value.
export const ANTHROPIC_VERSION = "2023-06-01";

/** Canonical OpenAI/Anthropic base URL: trim, drop trailing slashes, ensure one /v1. */
function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  const trimmed = String(baseUrl).trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function safeErrText(res) {
  try {
    const body = await res.json();
    return body?.error?.message || body?.message || "";
  } catch {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
}

/**
 * Native-Anthropic smoke test against POST /v1/messages — the endpoint Claude
 * Code actually uses. Unlike an OpenAI /chat/completions probe, this exercises
 * the Claude request format end-to-end (translator included), so a green result
 * reflects the path Claude Code will take.
 *
 * Never throws — always returns a structured result.
 *
 * @param {{ baseUrl: string, apiKey?: string, model: string,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function smokeTestClaudeMessages({
  baseUrl,
  apiKey = "",
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
} = {}) {
  const started = Date.now();
  const root = normalizeBaseUrl(baseUrl);
  const result = {
    ok: false,
    chat: "skipped",
    latencyMs: 0,
    error: null,
    model,
    endpoint: root,
  };

  if (!root || !model) {
    result.error = "baseUrl and model are required for smoke test";
    result.latencyMs = Date.now() - started;
    return result;
  }
  if (typeof fetchImpl !== "function") {
    result.error = "fetch is not available";
    result.latencyMs = Date.now() - started;
    return result;
  }

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  // Claude Code authenticates with x-api-key; keep Bearer too for gateways that
  // only read Authorization. extractApiKey() on the server accepts either.
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const withTimeout = async (promise) => {
    if (!timeoutMs) return promise;
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`smoke test timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const res = await withTimeout(
      fetchImpl(`${root}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      })
    );

    if (res?.ok) {
      result.chat = "ok";
      result.ok = true;
    } else {
      result.chat = "error";
      const text = await safeErrText(res);
      result.error = text
        ? `messages ${res?.status || "?"}: ${String(text).slice(0, 240)}`
        : `messages failed with status ${res?.status || "unknown"}`;
    }
  } catch (err) {
    result.chat = "error";
    result.error = err?.message || String(err);
  }

  result.latencyMs = Date.now() - started;
  return result;
}
