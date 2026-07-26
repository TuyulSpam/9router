const api = require("../api/client");
const { pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { selectModelFromList } = require("../utils/modelSelector");
const { showMenuWithBack } = require("../utils/menuHelper");
const { getEndpoint } = require("../utils/endpoint");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

// Tier → env key. Default VALUES come from the server (suggestedModels),
// not hardcoded version strings that go stale on every model release.
const TIERS = [
  { id: "opus", name: "Opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { id: "sonnet", name: "Sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { id: "haiku", name: "Haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
];

const DEFAULT_DEPS = {
  api,
  pause,
  showStatus,
  selectModelFromList,
  showMenuWithBack,
  getEndpoint,
  print: console.log,
};

function getDeps(overrides) {
  return overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

async function getFirstApiKey(deps) {
  const result = await deps.api.getApiKeys();
  const keys = result.success ? (result.data.keys || []) : [];
  return keys.length > 0 ? keys[0].key : null;
}

async function loadClaude(deps) {
  const result = await deps.api.getCliToolSettings("claude");
  if (!result.success) {
    return { ok: false, error: result.error || "Failed to load settings", data: null };
  }
  return { ok: true, error: null, data: result.data || {} };
}

/**
 * Header distinguishes three states like the other CLI tools:
 * not installed / installed-but-not-configured / configured.
 */
function buildHeader(data) {
  if (data?.installed === false) {
    return `Status:   ${COLORS.red}✗ Claude Code not installed${COLORS.reset}`;
  }
  const env = data?.settings?.env || {};
  if (!env.ANTHROPIC_BASE_URL) {
    return [
      `Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`,
      `${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`,
    ].join("\n");
  }
  const lines = [
    `Status:   ${COLORS.green}✓ Configured${COLORS.reset}`,
    `Endpoint: ${COLORS.cyan}${env.ANTHROPIC_BASE_URL}${COLORS.reset}`,
  ];
  if (env.ANTHROPIC_AUTH_TOKEN) {
    lines.push(`API Key:  ${COLORS.dim}${env.ANTHROPIC_AUTH_TOKEN.substring(0, 10)}...${COLORS.reset}`);
  }
  return lines.join("\n");
}

/**
 * Quick Setup — endpoint + first key + server-suggested per-tier models.
 * Local mode (cloud disabled) falls back to sk_9router so setup is zero-friction.
 */
async function quickSetup(port, dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadClaude(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return;
  }
  if (loaded.data.installed === false) {
    deps.showStatus("Claude Code is not installed. Install it before setup.", "error");
    await deps.pause();
    return;
  }

  const suggested = loaded.data.suggestedModels || {};
  if (!suggested.opus && !suggested.sonnet && !suggested.haiku) {
    deps.showStatus("No Claude-capable model available. Connect a provider or add a combo first.", "error");
    await deps.pause();
    return;
  }

  let apiKey = await getFirstApiKey(deps);
  if (!apiKey) {
    let cloudEnabled = false;
    try {
      const settingsRes = await deps.api.getSettings();
      if (settingsRes?.success) cloudEnabled = settingsRes.data?.cloudEnabled === true;
    } catch {
      // soft — treat as local when settings cannot be loaded
    }
    if (cloudEnabled) {
      deps.showStatus("No API keys found. Create one in API Keys menu first.", "error");
      await deps.pause();
      return;
    }
    apiKey = "sk_9router";
  }

  const { endpoint } = await deps.getEndpoint(port);
  const env = {
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    API_TIMEOUT_MS: "600000",
  };
  for (const tier of TIERS) {
    if (suggested[tier.id]) env[tier.envKey] = suggested[tier.id];
  }

  const result = await deps.api.applyCliToolSettings("claude", { env });
  deps.showStatus(
    result.success ? "Quick Setup completed!" : `Failed: ${result.error}`,
    result.success ? "success" : "error"
  );
  await deps.pause();
}

/**
 * Select a model for one tier. Combos are INCLUDED so the auto-fallback
 * flagship can back any Claude tier.
 */
async function selectTier(tier, port, dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadClaude(deps);
  const currentEnv = loaded.ok ? (loaded.data.settings?.env || {}) : {};
  const current = currentEnv[tier.envKey] || "Not set";

  const selected = await deps.selectModelFromList(`Select ${tier.name} Model`, current);
  if (!selected) return;

  const env = { [tier.envKey]: selected };

  // Also set base URL/key if not configured yet
  if (!currentEnv.ANTHROPIC_BASE_URL) {
    const { endpoint } = await deps.getEndpoint(port);
    const apiKey = await getFirstApiKey(deps);
    env.ANTHROPIC_BASE_URL = endpoint;
    env.API_TIMEOUT_MS = "600000";
    if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }

  const result = await deps.api.applyCliToolSettings("claude", { env });
  deps.showStatus(
    result.success ? `${tier.name} → ${selected} saved!` : `Failed: ${result.error}`,
    result.success ? "success" : "error"
  );
  await deps.pause();
}

/**
 * Test Health — probeOnly smoke test; config unchanged.
 */
async function testHealth(dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const loaded = await loadClaude(deps);
  if (!loaded.ok) {
    deps.showStatus(loaded.error, "error");
    await deps.pause();
    return;
  }
  const env = loaded.data.settings?.env || {};
  const model =
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!env.ANTHROPIC_BASE_URL || !model) {
    deps.showStatus("Configure Claude Code before testing health.", "error");
    await deps.pause();
    return;
  }

  const result = await deps.api.applyCliToolSettings("claude", {
    env: {
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN || "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    },
    probeOnly: true,
  });

  const health = result.success ? result.data?.health : null;
  if (result.success && health?.status === "healthy") {
    deps.showStatus(`Healthy (${health.latencyMs}ms) — config unchanged`, "success");
  } else {
    deps.showStatus(
      `Unhealthy: ${health?.error || result.error || "unknown"} — config unchanged`,
      "error"
    );
  }
  await deps.pause();
}

async function reset(dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);
  const result = await deps.api.resetCliToolSettings("claude");
  deps.showStatus(
    result.success ? "Settings reset successfully!" : `Failed: ${result.error}`,
    result.success ? "success" : "error"
  );
  await deps.pause();
}

async function showClaudeCodeMenu(port, breadcrumb = [], dependencyOverrides = null) {
  const deps = getDeps(dependencyOverrides);

  await deps.showMenuWithBack({
    title: "🔧 Claude Code Settings",
    breadcrumb,
    headerContent: async () => {
      const loaded = await loadClaude(deps);
      return loaded.ok ? buildHeader(loaded.data) : `${COLORS.red}${loaded.error}${COLORS.reset}`;
    },
    refresh: async () => {
      const loaded = await loadClaude(deps);
      const env = loaded.data?.settings?.env || {};
      return {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || "Not set",
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || "Not set",
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "Not set",
      };
    },
    items: [
      { label: "⚡ Quick Setup (recommended)", action: async () => { await quickSetup(port, dependencyOverrides); return true; } },
      { label: (d) => `Sonnet → ${d.sonnet}`, action: async () => { await selectTier(TIERS[1], port, dependencyOverrides); return true; } },
      { label: (d) => `Opus → ${d.opus}`, action: async () => { await selectTier(TIERS[0], port, dependencyOverrides); return true; } },
      { label: (d) => `Haiku → ${d.haiku}`, action: async () => { await selectTier(TIERS[2], port, dependencyOverrides); return true; } },
      { label: "🩺 Test Health", action: async () => { await testHealth(dependencyOverrides); return true; } },
      { label: "Reset to Default", action: async () => { await reset(dependencyOverrides); return true; } },
    ],
  });
}

module.exports = {
  showClaudeCodeMenu,
  quickSetup,
  selectTier,
  testHealth,
  reset,
  buildHeader,
  TIERS,
};
