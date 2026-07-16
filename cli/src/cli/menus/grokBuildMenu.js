const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { selectModelFromList } = require("../utils/modelSelector");
const { showMenuWithBack } = require("../utils/menuHelper");
const { getEndpoint } = require("../utils/endpoint");
const {
  GROK_BUILD_MENU_ACTIONS,
  normalizeGrokBuildBaseUrl,
  resolveGrokBuildQuickModel,
  buildGrokBuildApplyPayload,
  formatGrokBuildHeader,
  formatGrokBuildActionMessage,
} = require("./grokBuildHelpers");

const DEFAULT_DEPS = {
  api,
  prompt,
  confirm,
  pause,
  showStatus,
  print: console.log,
  selectModelFromList,
  showMenuWithBack,
  getEndpoint,
};

function getDeps(overrides) {
  return overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

async function getFirstApiKey(deps) {
  const result = await deps.api.getApiKeys();
  if (!result.success) return null;
  const keys = Array.isArray(result.data?.keys) ? result.data.keys : [];
  return keys.find((key) => typeof key?.key === "string" && key.key)?.key || null;
}

async function loadGrokBuildStatus(deps) {
  const result = await deps.api.getCliToolSettings("grok-build");
  if (!result.success) {
    return { ok: false, error: result.error || "Failed to load Grok Build settings", data: null };
  }
  return { ok: true, error: null, data: result.data || {} };
}

async function displayActionResult(result, options, deps) {
  const message = formatGrokBuildActionMessage(result, options);
  deps.showStatus(message.text, message.type);
  for (const detail of message.details || []) {
    deps.showStatus(detail, "warning");
  }
  await deps.pause();
  return result.success ? (result.data?.health || null) : null;
}

async function grokBuildShowStatus(health = null, dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadGrokBuildStatus(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return null;
  }

  deps.print(`\n${formatGrokBuildHeader(loaded.data, health)}\n`);
  await deps.pause();
  return loaded.data;
}

/**
 * One click: current endpoint + first API key + server-suggested/configured model,
 * then Apply and run the server's chat/tools smoke test.
 */
async function grokBuildQuickSetup(port, dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadGrokBuildStatus(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return null;
  }
  if (!loaded.data.installed) {
    deps.showStatus("Grok Build is not installed. Install it before setup.", "error");
    await deps.pause();
    return null;
  }

  const model = resolveGrokBuildQuickModel(loaded.data);
  if (!model) {
    deps.showStatus("No Grok Build model is available. Add an LLM model or combo first.", "error");
    await deps.pause();
    return null;
  }

  const apiKey = await getFirstApiKey(deps);
  if (!apiKey) {
    deps.showStatus("No API keys found. Create one in API Keys menu first.", "error");
    await deps.pause();
    return null;
  }

  const { endpoint } = await deps.getEndpoint(port);
  const payload = buildGrokBuildApplyPayload({ endpoint, apiKey, model });
  const result = await deps.api.applyCliToolSettings("grok-build", payload);
  return displayActionResult(result, {}, deps);
}

async function grokBuildCustomSetup(port, dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadGrokBuildStatus(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return null;
  }
  if (!loaded.data.installed) {
    deps.showStatus("Grok Build is not installed. Install it before setup.", "error");
    await deps.pause();
    return null;
  }

  const currentConfig = loaded.data.settings?.model || {};
  const currentModel = resolveGrokBuildQuickModel(loaded.data) || "";
  const { endpoint: localEndpoint } = await deps.getEndpoint(port);
  const defaultEndpoint = currentConfig.base_url || localEndpoint;
  const firstApiKey = await getFirstApiKey(deps);

  const endpointInput = await deps.prompt(`Endpoint [${defaultEndpoint}]: `);
  const endpoint = normalizeGrokBuildBaseUrl(endpointInput || defaultEndpoint);
  // Stored key reuse is endpoint-scoped: only offer "configured key" when endpoint is unchanged.
  const sameEndpoint = normalizeGrokBuildBaseUrl(currentConfig.base_url) === endpoint;
  const canReuseStoredKey = sameEndpoint && currentConfig.hasApiKey === true;
  const keyHint = canReuseStoredKey ? "configured key" : firstApiKey ? "first 9Router key" : "sk_9router";
  const apiKeyInput = await deps.prompt(`API key [Enter = ${keyHint}]: `);
  // Empty value tells the server to reuse the stored key for this same endpoint only.
  const apiKey = apiKeyInput || (canReuseStoredKey ? "" : firstApiKey || "sk_9router");
  const model = await deps.selectModelFromList("Select Grok Build Model", currentModel);

  if (!model) {
    deps.showStatus("Custom setup cancelled: no model selected.", "info");
    await deps.pause();
    return null;
  }

  const payload = buildGrokBuildApplyPayload({ endpoint, apiKey, model });
  const result = await deps.api.applyCliToolSettings("grok-build", payload);
  return displayActionResult(result, {}, deps);
}

async function grokBuildTestHealth(dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadGrokBuildStatus(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return null;
  }

  const config = loaded.data.settings?.model || {};
  if (!loaded.data.installed) {
    deps.showStatus("Grok Build is not installed.", "error");
    await deps.pause();
    return null;
  }
  if (!config.base_url || !config.model) {
    deps.showStatus("Configure Grok Build before testing health.", "error");
    await deps.pause();
    return null;
  }

  const payload = buildGrokBuildApplyPayload({
    endpoint: config.base_url,
    // GET intentionally redacts the stored key; POST probeOnly resolves it server-side.
    apiKey: "",
    model: config.model,
    probeOnly: true,
  });
  const result = await deps.api.applyCliToolSettings("grok-build", payload);
  return displayActionResult(result, { probeOnly: true }, deps);
}

async function grokBuildReset(dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const accepted = await deps.confirm(
    "Remove only the 9Router Grok Build model slot and restore the previous default?"
  );
  if (!accepted) {
    deps.showStatus("Reset cancelled; config unchanged.", "info");
    await deps.pause();
    return false;
  }

  const result = await deps.api.resetCliToolSettings("grok-build");
  const message = formatGrokBuildActionMessage(result);
  deps.showStatus(message.text, message.type);
  await deps.pause();
  return result.success === true;
}

async function showGrokBuildMenu(port, breadcrumb = [], dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  let lastHealth = null;

  const getHeader = async () => {
    const loaded = await loadGrokBuildStatus(deps);
    if (!loaded.ok) return `Status: ${loaded.error}`;
    return formatGrokBuildHeader(loaded.data, lastHealth);
  };

  const actions = {
    status: async () => {
      await grokBuildShowStatus(lastHealth, deps);
      return true;
    },
    "quick-setup": async () => {
      const health = await grokBuildQuickSetup(port, deps);
      if (health) lastHealth = health;
      return true;
    },
    "custom-setup": async () => {
      const health = await grokBuildCustomSetup(port, deps);
      if (health) lastHealth = health;
      return true;
    },
    "test-health": async () => {
      const health = await grokBuildTestHealth(deps);
      if (health) lastHealth = health;
      return true;
    },
    reset: async () => {
      const reset = await grokBuildReset(deps);
      if (reset) lastHealth = null;
      return true;
    },
  };

  await deps.showMenuWithBack({
    title: "🚀 Grok Build Settings",
    breadcrumb,
    headerContent: getHeader,
    refresh: async () => ({}),
    items: GROK_BUILD_MENU_ACTIONS.map((item) => ({
      label: item.label,
      action: actions[item.id],
    })),
  });
}

module.exports = {
  showGrokBuildMenu,
  grokBuildShowStatus,
  grokBuildQuickSetup,
  grokBuildCustomSetup,
  grokBuildTestHealth,
  grokBuildReset,
};
