"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import {
  buildGrokBuildManualConfig,
  prepareGrokBuildQuickSetup,
  normalizeGrokBuildBaseUrl,
  buildGrokBuildDashboardTestPayload,
  buildGrokBuildDashboardApplyPayload,
} from "@/lib/cli-tools/grokBuildSetup";

const ENDPOINT = "/api/cli-tools/grok-build-settings";

// Client-side mirror of risky xai path (server also validates)
const RISKY_XAI_RE = /^(?:xai|x-ai)\/grok-4\.5(?:-|$)/i;

function collectLiveWarnings(model, status, health) {
  const out = [];
  if (!model) return out;

  if (RISKY_XAI_RE.test(model)) {
    out.push(
      "Direct xAI path often fails for grok-4.5-high. Prefer gcli/grok-4.5-high (Grok CLI OAuth) or a combo that uses gcli."
    );
  }

  const serverWarnings = status?.validation?.warnings || status?.pathAnalysis?.warnings || [];
  for (const w of serverWarnings) {
    if (w && !out.includes(w)) out.push(w);
  }

  if (health?.status === "unhealthy" && health?.error) {
    out.push(`Last smoke test failed: ${health.error}`);
  }

  return out;
}

function pickDefaultModel(status, availableModels = []) {
  return (
    status?.settings?.model?.model
    || status?.suggestedModel
    || availableModels?.[0]?.value
    || ""
  );
}

export default function GrokBuildToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  availableModels = [],
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [grokStatus, setGrokStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [quickSetting, setQuickSetting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState(null);
  const [health, setHealth] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState(() => apiKeys?.[0]?.key || "");
  const [selectedModel, setSelectedModel] = useState(() => pickDefaultModel(initialStatus, availableModels));
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const hasInitializedModel = useRef(!!pickDefaultModel(initialStatus, availableModels));

  // Keep selected key in sync when keys load later (user hasn't chosen yet)
  const effectiveApiKey = selectedApiKey || apiKeys?.[0]?.key || "";

  const applyStatusAndMaybePrefill = useCallback((data) => {
    setGrokStatus(data);
    if (!hasInitializedModel.current && data?.installed) {
      const suggested = pickDefaultModel(data, availableModels);
      if (suggested) {
        hasInitializedModel.current = true;
        setSelectedModel(suggested);
      }
    }
  }, [availableModels]);

  const getConfigStatus = () => {
    if (!grokStatus?.installed) return null;
    const cfg = grokStatus.settings?.model;
    if (!cfg?.base_url) return "not_configured";
    if (matchKnownEndpoint(cfg.base_url, { tunnelPublicUrl, tailscaleUrl })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  const liveWarnings = useMemo(
    () => collectLiveWarnings(selectedModel, grokStatus, health),
    [selectedModel, grokStatus, health]
  );

  const fetchModelAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT);
      const data = await res.json();
      applyStatusAndMaybePrefill(data);
    } catch (error) {
      setGrokStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  }, [applyStatusAndMaybePrefill]);

  useEffect(() => {
    if (!isExpanded) return;
    let cancelled = false;
    (async () => {
      if (!grokStatus) {
        setChecking(true);
        try {
          const res = await fetch(ENDPOINT);
          const data = await res.json();
          if (!cancelled) applyStatusAndMaybePrefill(data);
        } catch (error) {
          if (!cancelled) setGrokStatus({ installed: false, error: error.message });
        } finally {
          if (!cancelled) setChecking(false);
        }
      }
      if (!cancelled) fetchModelAliases();
    })();
    return () => { cancelled = true; };
    // Only re-run when expand toggles; status refresh is explicit via buttons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return "http://127.0.0.1:20128";
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl || getLocalBaseUrl();
    return normalizeGrokBuildBaseUrl(url);
  };

  const applySettings = async (payload, { source = "apply" } = {}) => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      if (data.health) setHealth(data.health);
      if (payload.model) {
        hasInitializedModel.current = true;
        setSelectedModel(payload.model);
      }
      const warnCount = data.validation?.warnings?.length || 0;
      const healthOk = data.health?.status === "healthy";
      setMessage({
        type: healthOk ? "success" : "warning",
        text: data.message
          || (healthOk
            ? (source === "quick"
              ? "Quick Setup complete — smoke test healthy"
              : "Settings applied — smoke test healthy")
            : (source === "quick"
              ? "Quick Setup applied, but smoke test failed"
              : "Settings applied, but smoke test failed")),
        details: warnCount > 0 ? data.validation.warnings : null,
      });
      checkStatus();
    } else {
      setMessage({ type: "error", text: data.error || "Failed to apply settings" });
    }
  };

  const handleApply = async () => {
    const prepared = buildGrokBuildDashboardApplyPayload({
      baseUrl: getEffectiveBaseUrl(),
      model: selectedModel,
      selectedApiKey: effectiveApiKey,
      configuredModel: grokStatus?.settings?.model || null,
      cloudEnabled,
    });
    if (!prepared.ok) {
      setMessage({ type: "error", text: prepared.error });
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      await applySettings(prepared.payload, { source: "apply" });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleQuickSetup = async () => {
    // True one-click: ignore manual Apply selections; use smart model + first API key.
    const prepared = prepareGrokBuildQuickSetup({
      status: grokStatus,
      baseUrl: getEffectiveBaseUrl(),
      apiKeys,
      cloudEnabled,
    });
    if (!prepared.ok) {
      setMessage({ type: "error", text: prepared.error });
      return;
    }

    setQuickSetting(true);
    setMessage(null);
    try {
      if (prepared.payload.apiKey) setSelectedApiKey(prepared.payload.apiKey);
      await applySettings(prepared.payload, { source: "quick" });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setQuickSetting(false);
    }
  };

  const handleTest = async () => {
    const prepared = buildGrokBuildDashboardTestPayload({ status: grokStatus });
    if (!prepared.ok) {
      setMessage({ type: "error", text: prepared.error });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.payload),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.health) setHealth(data.health);
        const healthOk = data.health?.status === "healthy";
        const warns = data.validation?.warnings || [];
        setMessage({
          type: healthOk ? "success" : "warning",
          text: healthOk
            ? `Smoke test healthy (${data.health?.latencyMs ?? "?"}ms) — config unchanged`
            : `Smoke test failed: ${data.health?.error || "unknown error"}`,
          details: warns.length ? warns : null,
        });
      } else {
        setMessage({ type: "error", text: data.error || "Test failed" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    setHealth(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Settings reset successfully!" });
        hasInitializedModel.current = false;
        setSelectedModel("");
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    hasInitializedModel.current = true;
    setSelectedModel(model.value || model.name || model);
    setModalOpen(false);
  };

  const getManualConfigs = () => {
    // Never embed a live dashboard/API key into copyable UI content.
    const modelId = selectedModel || grokStatus?.suggestedModel || "provider/model-id";
    return [
      {
        filename: "~/.grok/config.toml",
        content: buildGrokBuildManualConfig({
          model: modelId,
          baseUrl: getEffectiveBaseUrl(),
        }),
      },
    ];
  };

  const healthBadge = () => {
    if (!health) return null;
    if (health.status === "healthy") {
      return (
        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">
          Healthy{health.latencyMs != null ? ` · ${health.latencyMs}ms` : ""}
        </span>
      );
    }
    return (
      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-600 dark:text-red-400 rounded-full">
        Unhealthy
      </span>
    );
  };

  const messageCls = {
    success: "bg-green-500/10 text-green-600",
    warning: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    error: "bg-red-500/10 text-red-600",
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image
              src={tool.image || "/providers/grok-cli.png"}
              alt={tool.name}
              width={32}
              height={32}
              className="size-8 object-contain rounded-lg"
              sizes="32px"
              onError={(e) => { e.target.style.display = "none"; }}
            />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
              {healthBadge()}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Grok Build...</span>
            </div>
          )}

          {!checking && grokStatus && !grokStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Grok Build not detected locally</p>
                    <p className="text-sm text-text-muted mt-1">Install:</p>
                    <code className="block mt-2 p-2 bg-black/20 rounded text-xs font-mono">curl -fsSL https://x.ai/cli/install.sh | bash</code>
                    <p className="text-sm text-text-muted mt-2">Manual configuration is still available if 9router is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pl-0 sm:pl-9">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowManualConfigModal(true)}
                    className="w-full sm:w-auto !bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30"
                  >
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checking && grokStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {tool.notes && tool.notes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {tool.notes.map((note, idx) => (
                      <div
                        key={idx}
                        className={`flex items-start gap-2 p-2 rounded text-xs ${
                          note.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
                          note.type === "error" ? "bg-red-500/10 text-red-600 dark:text-red-400" :
                          "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px] mt-0.5">
                          {note.type === "warning" ? "warning" : note.type === "error" ? "error" : "info"}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {(grokStatus?.settings?.model?.base_url || health) && (
                  <div className="grid grid-cols-1 gap-1.5 rounded border border-border/60 bg-surface/30 p-2 text-xs text-text-muted">
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <span>
                        <span className="font-semibold text-text-main">Endpoint:</span>{" "}
                        {grokStatus?.settings?.model?.base_url || getEffectiveBaseUrl()}
                      </span>
                      <span>
                        <span className="font-semibold text-text-main">Model:</span>{" "}
                        {grokStatus?.settings?.model?.model || selectedModel || "—"}
                      </span>
                      <span>
                        <span className="font-semibold text-text-main">Health:</span>{" "}
                        {health
                          ? `${health.status}${health.latencyMs != null ? ` (${health.latencyMs}ms)` : ""}`
                          : "not tested"}
                      </span>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {grokStatus?.settings?.model?.base_url && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {grokStatus.settings.model.base_url}
                      {grokStatus.settings.model.model ? ` · ${grokStatus.settings.model.model}` : ""}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect
                    value={effectiveApiKey}
                    onChange={(v) => {
                      setSelectedApiKey(v);
                    }}
                    apiKeys={apiKeys}
                    cloudEnabled={cloudEnabled}
                  />
                </div>

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Default Model</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="relative w-full min-w-0">
                    <input
                      type="text"
                      value={selectedModel}
                      onChange={(e) => {
                        hasInitializedModel.current = true;
                        setSelectedModel(e.target.value);
                      }}
                      placeholder={grokStatus?.suggestedModel || "combo or provider/model-id"}
                      className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                    />
                    {selectedModel && (
                      <button
                        onClick={() => {
                          hasInitializedModel.current = true;
                          setSelectedModel("");
                        }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                        title="Clear"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => setModalOpen(true)}
                    disabled={!hasActiveProviders}
                    className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${
                      hasActiveProviders
                        ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer"
                        : "opacity-50 cursor-not-allowed border-border"
                    }`}
                  >
                    Select
                  </button>
                </div>

                {grokStatus?.suggestedModel && selectedModel !== grokStatus.suggestedModel && (
                  <div className="flex items-center gap-2 text-xs text-text-muted pl-0 sm:pl-[calc(8rem+0.5rem+14px+0.5rem)]">
                    <span>Suggested:</span>
                    <button
                      type="button"
                      className="text-primary hover:underline font-medium"
                      onClick={() => {
                        hasInitializedModel.current = true;
                        setSelectedModel(grokStatus.suggestedModel);
                      }}
                    >
                      {grokStatus.suggestedModel}
                    </button>
                  </div>
                )}

                {liveWarnings.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {liveWarnings.map((w, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 p-2 rounded text-xs bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
                      >
                        <span className="material-symbols-outlined text-[14px] mt-0.5">warning</span>
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {message && (
                <div className={`flex flex-col gap-1 px-2 py-1.5 rounded text-xs ${messageCls[message.type] || messageCls.error}`}>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[14px]">
                      {message.type === "success" ? "check_circle" : message.type === "warning" ? "warning" : "error"}
                    </span>
                    <span>{message.text}</span>
                  </div>
                  {message.details?.length > 0 && (
                    <ul className="list-disc pl-6 opacity-90">
                      {message.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleQuickSetup}
                  disabled={!grokStatus?.installed || applying || testing || restoring}
                  loading={quickSetting}
                  className="w-full sm:w-auto"
                  title="One click: endpoint + first API key + configured/suggested model + smoke test"
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">bolt</span>Quick Setup
                </Button>
                <Button variant="secondary" size="sm" onClick={handleApply} disabled={!selectedModel || quickSetting} loading={applying} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="secondary" size="sm" onClick={handleTest} disabled={!selectedModel || quickSetting} loading={testing} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">science</span>Test
                </Button>
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!grokStatus?.has9Router || quickSetting} loading={restoring} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ModelSelectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleModelSelect}
        selectedModel={selectedModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Select Model for Grok Build"
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Grok Build - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
