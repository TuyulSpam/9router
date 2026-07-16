// Pure helpers for Grok Build CLI-tool setup (P1):
// smart default model, model validation, provider-path guidance,
// idempotent TOML apply/reset, and post-apply smoke test.
// Keep side-effect free so unit tests can exercise without touching ~/.grok.

export const PROVIDER_NAME = "9router";
export const MODEL_SLOT = "9router";
export const BUILTIN_DEFAULT = "grok-build";

// [model.9router] ... until next [section] header or EOF
export const MODEL_SECTION_RE = new RegExp(
  `^\\[model\\.${MODEL_SLOT}\\][ \\t]*\\r?\\n(?:(?!\\[)[^\\r\\n]*\\r?\\n?)*`,
  "m"
);

export const MODELS_SECTION_RE = /^\[models\][ \t]*\r?\n((?:(?!\[)[^\r\n]*\r?\n?)*)/m;

// Marker written on Apply so Reset can restore the previous [models].default
export const PREV_DEFAULT_RE = /^# 9router-prev-default = "([^"]*)"[ \t]*\r?\n?/m;

// Prefer gcli/* (Grok CLI OAuth) over direct xai/* for grok-4.5 family.
const RISKY_XAI_GROK_RE = /^(?:xai|x-ai)\/grok-4\.5(?:-|$)/i;
const GCLI_GROK_RE = /^(?:gcli|gb|grok-cli|grok-build)\//i;

// Match TOML basic strings, including escaped quotes/backslashes.
const TOML_BASIC_STRING_RE = '"((?:\\\\.|[^"\\\\])*)"';

const unescapeTomlBasicString = (value) => {
  let out = "";
  const s = String(value || "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\" || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const next = s[i + 1];
    if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "b") out += "\b";
    else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "f") out += "\f";
    else if (next === "r") out += "\r";
    else out += next;
    i += 1;
  }
  return out;
};

export const escapeTomlBasicString = (value) => String(value ?? "")
  .replace(/\\/g, "\\\\")
  .replace(/"/g, '\\"')
  .replace(/\u0008/g, "\\b")
  .replace(/\t/g, "\\t")
  .replace(/\n/g, "\\n")
  .replace(/\f/g, "\\f")
  .replace(/\r/g, "\\r");

const getTomlField = (body, key) => {
  const m = body.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*${TOML_BASIC_STRING_RE}`, "m"));
  return m ? unescapeTomlBasicString(m[1]) : null;
};

export const parseModelSection = (toml) => {
  if (!toml) return null;
  const match = toml.match(MODEL_SECTION_RE);
  if (!match) return null;
  const body = match[0].replace(/^\[model\.[^\]]+\][ \t]*\r?\n/, "");
  return {
    model: getTomlField(body, "model"),
    base_url: getTomlField(body, "base_url"),
    name: getTomlField(body, "name"),
    api_key: getTomlField(body, "api_key"),
    api_backend: getTomlField(body, "api_backend"),
  };
};

/**
 * Public/client-safe view of a parsed [model.9router] section.
 * Never returns the live api_key — only a boolean presence flag.
 */
export const redactModelSettingsForClient = (modelCfg) => {
  if (!modelCfg || typeof modelCfg !== "object") return null;
  const { api_key: apiKey, ...rest } = modelCfg;
  return {
    ...rest,
    hasApiKey: typeof apiKey === "string" && apiKey.trim().length > 0,
  };
};

export const parseModelsDefault = (toml) => {
  if (!toml) return null;
  const match = toml.match(MODELS_SECTION_RE);
  if (!match) return null;
  return getTomlField(match[1] || "", "default");
};

export const buildModelSection = (model, baseUrl, apiKey) => {
  const lines = [
    `[model.${MODEL_SLOT}]`,
    `model = "${escapeTomlBasicString(model)}"`,
    `base_url = "${escapeTomlBasicString(baseUrl)}"`,
    `name = "9Router"`,
    `description = "Routed via 9Router gateway"`,
    `api_backend = "chat_completions"`,
  ];
  if (apiKey) lines.push(`api_key = "${escapeTomlBasicString(apiKey)}"`);
  return `${lines.join("\n")}\n`;
};

/**
 * Manual Config snippet for copy/paste. Always uses a placeholder key so a
 * live dashboard key is never rendered in the browser UI.
 */
export function buildGrokBuildManualConfig({
  model = "provider/model-id",
  baseUrl = "http://127.0.0.1:20128/v1",
  apiKeyPlaceholder = "<API_KEY_FROM_DASHBOARD>",
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl) || "http://127.0.0.1:20128/v1";
  const modelId = typeof model === "string" && model.trim() ? model.trim() : "provider/model-id";
  return `[models]
default = "${MODEL_SLOT}"

${buildModelSection(modelId, normalized, apiKeyPlaceholder)}`;
}

export const upsertModelSection = (toml, section) => {
  if (MODEL_SECTION_RE.test(toml)) return toml.replace(MODEL_SECTION_RE, section);
  const needsNl = toml.length > 0 && !toml.endsWith("\n");
  return `${toml}${needsNl ? "\n" : ""}\n${section}`;
};

export const removeModelSection = (toml) =>
  toml.replace(MODEL_SECTION_RE, "").replace(/\n{3,}/g, "\n\n");

// Set or insert default = "..." inside existing [models], or create the section
export const setModelsDefault = (toml, value) => {
  const match = toml.match(MODELS_SECTION_RE);
  if (match) {
    const body = match[1] || "";
    let newBody;
    if (/^[ \t]*default[ \t]*=/m.test(body)) {
      newBody = body.replace(/^[ \t]*default[ \t]*=[ \t]*"[^"]*"/m, `default = "${value}"`);
    } else {
      newBody = `default = "${value}"\n${body}`;
    }
    return toml.replace(match[0], `[models]\n${newBody}`);
  }
  const block = `[models]\ndefault = "${value}"\n\n`;
  return toml.length > 0 ? block + toml : block;
};

// Remember the previous default once (so re-Apply does not overwrite it with "9router")
export const rememberPrevDefault = (toml) => {
  if (PREV_DEFAULT_RE.test(toml)) return toml;
  const current = parseModelsDefault(toml);
  if (!current || current === MODEL_SLOT) return toml;
  const marker = `# 9router-prev-default = "${current}"\n`;
  // Prefer placing the marker just above [model.9router] if present, else at EOF
  if (MODEL_SECTION_RE.test(toml)) {
    return toml.replace(MODEL_SECTION_RE, (section) => marker + section);
  }
  const needsNl = toml.length > 0 && !toml.endsWith("\n");
  return `${toml}${needsNl ? "\n" : ""}${marker}`;
};

// If default points at our slot, restore previous (or built-in) default and drop marker
export const clearModelsDefaultIfOurs = (toml) => {
  const prevMatch = toml.match(PREV_DEFAULT_RE);
  const restoreTo = prevMatch?.[1] || BUILTIN_DEFAULT;
  let next = toml.replace(PREV_DEFAULT_RE, "");
  const current = parseModelsDefault(next);
  if (current === MODEL_SLOT) {
    next = setModelsDefault(next, restoreTo);
  }
  return next;
};

export const has9RouterConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return true;
};

/** Combos without kind (or kind=llm) are chat/LLM. Media kinds are not valid Grok defaults. */
function isLlmCombo(combo) {
  if (!combo) return false;
  const kind = combo.kind || "llm";
  return kind === "llm";
}

/**
 * Prefer:
 * 1) currently configured model (if still listed)
 * 2) first LLM combo name (combos ordered by createdAt ASC in DB)
 * 3) first gcli/* model id
 * 4) first remaining model id
 */
export function resolveSmartDefaultModel({
  configuredModel = null,
  combos = [],
  modelIds = [],
} = {}) {
  const ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  const idSet = new Set(ids);
  const comboList = Array.isArray(combos) ? combos.filter((c) => c?.name) : [];
  const llmCombos = comboList.filter(isLlmCombo);
  const comboNames = llmCombos.map((c) => c.name);

  if (configuredModel) {
    if (idSet.has(configuredModel) || comboList.some((c) => c.name === configuredModel)) {
      return configuredModel;
    }
  }

  // LLM combos first — prefer ones present in modelIds when the catalog is known
  for (const name of comboNames) {
    if (ids.length === 0 || idSet.has(name)) return name;
  }
  if (comboNames.length > 0 && ids.length === 0) return comboNames[0];

  const gcli = ids.find((id) => GCLI_GROK_RE.test(id));
  if (gcli) return gcli;

  return ids[0] || null;
}


function isRiskyXaiPath(id) {
  return typeof id === "string" && RISKY_XAI_GROK_RE.test(id);
}

/**
 * Provider-path guidance for Grok Build.
 * severity: "info" | "warn"
 */
export function analyzeProviderPath(model, { comboModels = null } = {}) {
  const warnings = [];
  const tips = [];

  const checkOne = (id, label = id) => {
    if (!id || typeof id !== "string") return;
    if (isRiskyXaiPath(id)) {
      warnings.push(
        `${label}: direct xAI path often fails for grok-4.5-high. Prefer gcli/grok-4.5-high (Grok CLI OAuth) in the combo or model picker.`
      );
    } else if (GCLI_GROK_RE.test(id)) {
      tips.push(`${label}: uses Grok CLI (gcli) path — recommended for tool calling.`);
    }
  };

  if (Array.isArray(comboModels) && comboModels.length > 0) {
    for (const m of comboModels) checkOne(m);
  } else {
    checkOne(model);
  }

  return {
    severity: warnings.length > 0 ? "warn" : "info",
    warnings,
    tips,
  };
}

/**
 * Soft validation: empty model is hard error; unknown model is warning only
 * (custom gateway ids / future models should still be applyable).
 *
 * @param {string} model
 * @param {{ modelIds?: string[], combos?: object[], capabilityLookup?: (modelId: string) => ({ tools?: boolean }|null) }} opts
 */
export function validateGrokBuildModel(
  model,
  { modelIds = [], combos = [], capabilityLookup = null } = {}
) {
  const errors = [];
  const warnings = [];
  const trimmed = typeof model === "string" ? model.trim() : "";

  if (!trimmed) {
    return {
      ok: false,
      found: false,
      isCombo: false,
      errors: ["model is required"],
      warnings: [],
      path: null,
    };
  }

  const ids = Array.isArray(modelIds) ? modelIds : [];
  const comboList = Array.isArray(combos) ? combos : [];
  const combo = comboList.find((c) => c?.name === trimmed) || null;
  const isCombo = !!combo;
  const found = isCombo || ids.includes(trimmed);

  if (!found) {
    warnings.push(
      `Model "${trimmed}" is not in the current /v1/models catalog. Apply will still write it — confirm the id is correct.`
    );
  }

  if (isCombo && combo.kind && combo.kind !== "llm") {
    warnings.push(
      `Combo "${trimmed}" has kind "${combo.kind}" — Grok Build expects an LLM/chat model.`
    );
  }

  // Optional tools capability check (injectable for unit tests)
  if (typeof capabilityLookup === "function") {
    try {
      const targets = isCombo && Array.isArray(combo.models) && combo.models.length
        ? combo.models
        : [trimmed];
      for (const id of targets) {
        const caps = capabilityLookup(id);
        if (caps && caps.tools === false) {
          warnings.push(
            `${id}: tools/function-calling capability is false — Grok Build agent mode may not work well.`
          );
        }
      }
    } catch {
      // ignore capability lookup failures
    }
  }

  const path = analyzeProviderPath(trimmed, {
    comboModels: isCombo ? (combo.models || []) : null,
  });
  warnings.push(...path.warnings);

  return {
    ok: errors.length === 0,
    found,
    isCombo,
    errors,
    warnings,
    path,
  };
}

/**
 * Canonical Grok Build / OpenAI-compatible base URL:
 * trim, strip trailing slashes, ensure exactly one trailing /v1.
 */
export function normalizeGrokBuildBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  const trimmed = String(baseUrl).trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Back-compat alias for internal callers in this module.
const normalizeBaseUrl = normalizeGrokBuildBaseUrl;

/**
 * Reuse a stored key only for the exact normalized endpoint it belongs to.
 * This prevents an omitted key from being forwarded to a different host.
 */
export function resolveStoredApiKeyForEndpoint({
  requestedBaseUrl = "",
  storedModel = null,
} = {}) {
  const requested = normalizeBaseUrl(requestedBaseUrl);
  const stored = normalizeBaseUrl(storedModel?.base_url);
  if (!requested || !stored || requested !== stored) return "";
  return typeof storedModel?.api_key === "string" ? storedModel.api_key.trim() : "";
}

/**
 * One-click Quick Setup: resolve endpoint + first API key + smart model.
 * Intentionally ignores manual UI Apply selections (selectedModel / selectedApiKey)
 * so the button remains a true one-click path. Custom values use Apply instead.
 *
 * Priority for model:
 *  1) currently configured model
 *  2) server suggestedModel
 *
 * Priority for API key:
 *  1) first apiKeys[].key
 *  2) sk_9router when cloud is disabled
 */
export function prepareGrokBuildQuickSetup({
  status = null,
  baseUrl = "",
  apiKeys = [],
  cloudEnabled = false,
} = {}) {
  if (!status?.installed) {
    return { ok: false, error: "Grok Build is not installed", payload: null, model: null };
  }

  const model = status?.settings?.model?.model || status?.suggestedModel || null;
  if (!model) {
    return {
      ok: false,
      error: "No model available for Quick Setup",
      payload: null,
      model: null,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "Endpoint is required", payload: null, model };
  }

  const firstKey = Array.isArray(apiKeys)
    ? (apiKeys.find((k) => typeof k?.key === "string" && k.key.trim())?.key || "")
    : "";
  const apiKey = firstKey || (!cloudEnabled ? "sk_9router" : "");

  if (!apiKey) {
    return {
      ok: false,
      error: "API key is required for Quick Setup",
      payload: null,
      model,
    };
  }

  return {
    ok: true,
    error: null,
    model,
    payload: {
      baseUrl: normalizedBaseUrl,
      apiKey,
      model,
      smoke: true,
      probeTools: true,
    },
  };
}


/**
 * Dashboard "Test" probes the *configured* installation only.
 * Form selections are ignored so a dirty picker cannot rewrite intent.
 * Empty apiKey lets the server reuse the stored key for the same endpoint.
 */
export function buildGrokBuildDashboardTestPayload({
  status = null,
} = {}) {
  const configured = status?.settings?.model || null;
  const baseUrl = normalizeGrokBuildBaseUrl(configured?.base_url);
  const model = typeof configured?.model === "string" ? configured.model.trim() : "";

  if (!status?.installed || !baseUrl || !model) {
    return {
      ok: false,
      error: "Configure Grok Build before testing health",
      payload: null,
    };
  }

  return {
    ok: true,
    error: null,
    payload: {
      baseUrl,
      apiKey: "",
      model,
      smoke: true,
      probeOnly: true,
      probeTools: true,
    },
  };
}

/**
 * Dashboard Apply payload with safe key semantics:
 * 1) real selected key → send it
 * 2) matching configured endpoint + hasApiKey → empty string (server reuses)
 * 3) local/non-cloud → sk_9router
 * 4) cloud with no key/reuse → abort (never send null)
 */
export function buildGrokBuildDashboardApplyPayload({
  baseUrl = "",
  model = "",
  selectedApiKey = "",
  configuredModel = null,
  cloudEnabled = false,
} = {}) {
  const normalizedBaseUrl = normalizeGrokBuildBaseUrl(baseUrl);
  const modelId = typeof model === "string" ? model.trim() : "";

  if (!normalizedBaseUrl) {
    return { ok: false, error: "Endpoint is required", payload: null };
  }
  if (!modelId) {
    return { ok: false, error: "Select a model first", payload: null };
  }

  const selected = typeof selectedApiKey === "string" ? selectedApiKey.trim() : "";
  if (selected) {
    return {
      ok: true,
      error: null,
      payload: {
        baseUrl: normalizedBaseUrl,
        apiKey: selected,
        model: modelId,
        smoke: true,
      },
    };
  }

  const storedBase = normalizeGrokBuildBaseUrl(configuredModel?.base_url);
  const canReuseStored =
    !!storedBase
    && storedBase === normalizedBaseUrl
    && configuredModel?.hasApiKey === true;

  if (canReuseStored) {
    return {
      ok: true,
      error: null,
      payload: {
        baseUrl: normalizedBaseUrl,
        apiKey: "",
        model: modelId,
        smoke: true,
      },
    };
  }

  if (!cloudEnabled) {
    return {
      ok: true,
      error: null,
      payload: {
        baseUrl: normalizedBaseUrl,
        apiKey: "sk_9router",
        model: modelId,
        smoke: true,
      },
    };
  }

  return {
    ok: false,
    error: "API key is required",
    payload: null,
  };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Post-apply smoke test against the OpenAI-compatible gateway.
 * Does not throw — always returns a structured result.
 *
 * @param {{ baseUrl: string, apiKey?: string, model: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function smokeTestGrokBuild({
  baseUrl,
  apiKey = "sk_9router",
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  probeTools = false,
} = {}) {
  const started = Date.now();
  const root = normalizeBaseUrl(baseUrl);
  const headers = {
    Authorization: `Bearer ${apiKey || "sk_9router"}`,
    "Content-Type": "application/json",
  };

  const result = {
    ok: false,
    models: "skipped",
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

  const withTimeout = async (promise) => {
    if (!timeoutMs) return promise;
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`smoke test timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    // 1) models list (soft — catalog may be huge / auth-gated)
    try {
      const modelsRes = await withTimeout(fetchImpl(`${root}/models`, { headers }));
      if (modelsRes?.ok) {
        result.models = "ok";
      } else {
        result.models = "error";
      }
    } catch {
      result.models = "error";
    }

    // 2) tiny chat completion — the real health signal
    const chatBody = {
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      stream: false,
    };
    if (probeTools) {
      // Advertise a no-op tool so gateways that reject tool schemas fail here,
      // without forcing the model to actually call it.
      chatBody.tools = [
        {
          type: "function",
          function: {
            name: "health_check",
            description: "No-op health probe tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      chatBody.tool_choice = "none";
    }

    const chatRes = await withTimeout(
      fetchImpl(`${root}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(chatBody),
      })
    );

    if (chatRes?.ok) {
      result.chat = "ok";
      result.ok = true;
      result.error = null;
    } else {
      result.chat = "error";
      const body = (await safeJson(chatRes)) || {};
      const text = body?.error?.message || body?.message || (await safeText(chatRes)) || "";
      result.error = text
        ? `chat ${chatRes?.status || "?"}: ${String(text).slice(0, 240)}`
        : `chat failed with status ${chatRes?.status || "unknown"}`;
    }
  } catch (err) {
    result.chat = "error";
    result.error = err?.message || String(err);
  }

  result.latencyMs = Date.now() - started;
  return result;
}
