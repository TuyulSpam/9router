// Pure helpers shared by the Grok Build terminal menu.
// Keep this file free of TTY/API side effects so behavior is unit-testable.

const GROK_BUILD_MENU_ACTIONS = Object.freeze([
  { id: "status", label: "Status" },
  { id: "quick-setup", label: "⚡ Quick Setup (one click)" },
  { id: "custom-setup", label: "Custom setup" },
  { id: "test-health", label: "Test health (config unchanged)" },
  { id: "reset", label: "Reset" },
]);

function normalizeGrokBuildBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function resolveGrokBuildQuickModel(status) {
  const configured = status?.settings?.model?.model;
  if (typeof configured === "string" && configured.trim()) return configured.trim();

  const suggested = status?.suggestedModel;
  if (typeof suggested === "string" && suggested.trim()) return suggested.trim();
  return null;
}

function buildGrokBuildApplyPayload({ endpoint, apiKey, model, probeOnly = false } = {}) {
  const payload = {
    baseUrl: normalizeGrokBuildBaseUrl(endpoint),
    // Empty means "reuse the stored key"; the server resolves it without echoing it via GET.
    apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
    model: typeof model === "string" ? model.trim() : "",
    smoke: true,
    probeTools: true,
  };
  if (probeOnly) payload.probeOnly = true;
  return payload;
}

function summarizeGrokBuildStatus(status, health = null) {
  const installed = status?.installed === true;
  const modelConfig = status?.settings?.model || null;
  const endpoint = modelConfig?.base_url || null;
  const model = modelConfig?.model || null;
  const configured = installed && (status?.has9Router === true || !!endpoint);
  const healthStatus = health?.status || "not_tested";

  let statusLabel = "Grok Build not installed";
  if (installed && configured) statusLabel = "Configured";
  else if (installed) statusLabel = "Not configured";

  let healthLabel = "Not tested";
  if (healthStatus === "healthy") healthLabel = "Healthy";
  if (healthStatus === "unhealthy") {
    healthLabel = health?.error ? `Unhealthy — ${health.error}` : "Unhealthy";
  }

  return {
    installed,
    configured,
    statusLabel,
    model,
    endpoint,
    defaultModel: status?.settings?.default || null,
    suggestedModel: resolveGrokBuildQuickModel({
      settings: { model: null },
      suggestedModel: status?.suggestedModel,
    }),
    healthStatus,
    healthLabel,
    latencyMs: Number.isFinite(health?.latencyMs) ? health.latencyMs : null,
  };
}

function formatGrokBuildHeader(status, health = null) {
  const summary = summarizeGrokBuildStatus(status, health);
  const lines = [
    `Status:    ${summary.statusLabel}`,
    `Installed: ${summary.installed ? "Yes" : "No"}`,
    `Configured:${summary.configured ? " Yes" : " No"}`,
  ];

  if (summary.model) lines.push(`Model:     ${summary.model}`);
  else if (summary.suggestedModel) lines.push(`Suggested: ${summary.suggestedModel}`);
  if (summary.endpoint) lines.push(`Endpoint:  ${summary.endpoint}`);

  let healthText = summary.healthLabel;
  if (summary.latencyMs !== null) healthText += ` (${summary.latencyMs}ms)`;
  lines.push(`Health:    ${healthText}`);
  return lines.join("\n");
}

function formatGrokBuildActionMessage(response, { probeOnly = false } = {}) {
  const body = response?.data && typeof response.data === "object" ? response.data : response;
  if (!response?.success || body?.error) {
    return {
      type: "error",
      text: body?.error || response?.error || "Grok Build request failed",
      details: [],
    };
  }

  const health = body?.health || null;
  const warnings = Array.isArray(body?.validation?.warnings)
    ? body.validation.warnings.filter(Boolean)
    : [];
  const isProbe = probeOnly || body?.probeOnly === true;

  if (health?.status === "unhealthy") {
    const reason = health.error || "unknown error";
    return {
      type: "warning",
      text: `Smoke test unhealthy: ${reason}${isProbe ? " — config unchanged" : ""}`,
      details: warnings,
    };
  }

  if (health?.status === "healthy") {
    const latency = Number.isFinite(health.latencyMs) ? ` (${health.latencyMs}ms)` : "";
    return {
      type: warnings.length > 0 ? "warning" : "success",
      text: `${body?.message || "Smoke test healthy"}${latency}${isProbe ? " — config unchanged" : ""}`,
      details: warnings,
    };
  }

  return {
    type: warnings.length > 0 ? "warning" : "success",
    text: body?.message || "Grok Build request completed",
    details: warnings,
  };
}

module.exports = {
  GROK_BUILD_MENU_ACTIONS,
  normalizeGrokBuildBaseUrl,
  resolveGrokBuildQuickModel,
  buildGrokBuildApplyPayload,
  summarizeGrokBuildStatus,
  formatGrokBuildHeader,
  formatGrokBuildActionMessage,
};
