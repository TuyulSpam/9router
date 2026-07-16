"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCombos } from "@/lib/localDb";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import {
  MODEL_SLOT,
  BUILTIN_DEFAULT,
  parseModelSection,
  redactModelSettingsForClient,
  parseModelsDefault,
  buildModelSection,
  upsertModelSection,
  removeModelSection,
  setModelsDefault,
  rememberPrevDefault,
  clearModelsDefaultIfOurs,
  has9RouterConfig,
  resolveSmartDefaultModel,
  validateGrokBuildModel,
  analyzeProviderPath,
  resolveStoredApiKeyForEndpoint,
  smokeTestGrokBuild,
} from "@/lib/cli-tools/grokBuildSetup.js";

/** Split "alias/model" for capability lookup; combos have no slash. */
function capabilityLookup(modelId) {
  if (!modelId || typeof modelId !== "string" || !modelId.includes("/")) {
    return null;
  }
  const slash = modelId.indexOf("/");
  const provider = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  return getCapabilitiesForModel(provider, model);
}

const execAsync = promisify(exec);

const getGrokDir = () => path.join(os.homedir(), ".grok");
const getGrokConfigPath = () => path.join(getGrokDir(), "config.toml");
const getGrokBinPath = () => path.join(getGrokDir(), "bin", "grok");

const checkGrokInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where grok" : "which grok";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getGrokBinPath());
      return true;
    } catch {
      try {
        await fs.access(getGrokConfigPath());
        return true;
      } catch {
        return false;
      }
    }
  }
};

const readConfigToml = async () => {
  try {
    return await fs.readFile(getGrokConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

/** Best-effort catalog of model ids from local combos + optional /v1/models. */
async function loadCatalog({ baseUrl, apiKey } = {}) {
  let combos = [];
  try {
    combos = await getCombos();
  } catch (err) {
    console.log("grok-build: could not load combos", err?.message || err);
  }

  const modelIds = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    modelIds.push(id);
  };

  for (const c of combos) {
    if (c?.name) push(c.name);
  }

  // Optional live catalog when we have an endpoint (Apply smoke path)
  if (baseUrl) {
    try {
      const root = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/v1`;
      const res = await fetch(`${root}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey || "sk_9router"}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout?.(8000),
      });
      if (res?.ok) {
        const body = await res.json();
        const list = body?.data || body?.models || [];
        for (const m of list) push(m?.id || m);
      }
    } catch (err) {
      // soft — catalog enrichment only
      console.log("grok-build: models catalog fetch failed", err?.message || err);
    }
  }

  return { combos, modelIds };
}

function staticGuidance() {
  return {
    preferredPath: "gcli/* (Grok CLI OAuth via 9Router)",
    avoidPath: "xai/grok-4.5-high direct API key path often returns model-not-found",
    notes: [
      "Grok Build uses ~/.grok/config.toml. Apply writes [model.9router] and sets it as default.",
      "Prefer combo members or models under gcli/ (Grok CLI) over direct xai/ for grok-4.5-high.",
      "After Apply, run grok (or /model 9router). Switch back with /model grok-build.",
    ],
  };
}

export async function GET() {
  try {
    const installed = await checkGrokInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Grok Build is not installed",
        suggestedModel: null,
        guidance: staticGuidance(),
      });
    }

    const toml = await readConfigToml();
    const model = parseModelSection(toml);
    const defaultModel = parseModelsDefault(toml);
    const { combos, modelIds } = await loadCatalog();

    const suggestedModel = resolveSmartDefaultModel({
      configuredModel: model?.model || null,
      combos,
      modelIds,
    });

    const validation = model?.model
      ? validateGrokBuildModel(model.model, {
          modelIds,
          combos,
          capabilityLookup,
        })
      : null;

    const pathAnalysis = model?.model
      ? analyzeProviderPath(model.model, {
          comboModels: combos.find((c) => c.name === model.model)?.models || null,
        })
      : null;

    return NextResponse.json({
      installed: true,
      settings: {
        // Never return the live api_key — clients only need hasApiKey.
        model: redactModelSettingsForClient(model),
        default: defaultModel,
      },
      has9Router: has9RouterConfig(model),
      configPath: getGrokConfigPath(),
      suggestedModel,
      validation,
      pathAnalysis,
      guidance: staticGuidance(),
    });
  } catch (error) {
    console.log("Error checking grok-build settings:", error);
    return NextResponse.json({ error: "Failed to check grok-build settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      baseUrl,
      apiKey,
      model,
      smoke = true,
      dryRun = false,
      probeOnly = false,
      probeTools = true,
      skipValidation = false,
    } = body || {};

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/v1`;
    // Empty/missing client key may reuse a stored key only for the same endpoint.
    // This lets GET redact secrets without forwarding them to a different host.
    let keyToWrite = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : "";
    if (!keyToWrite) {
      try {
        const existing = parseModelSection(await readConfigToml());
        keyToWrite = resolveStoredApiKeyForEndpoint({
          requestedBaseUrl: normalizedBaseUrl,
          storedModel: existing,
        });
      } catch {
        // soft — fall through to local placeholder
      }
    }
    if (!keyToWrite) keyToWrite = "sk_9router";

    const { combos, modelIds } = await loadCatalog({
      baseUrl: normalizedBaseUrl,
      apiKey: keyToWrite,
    });

    const validation = skipValidation
      ? { ok: true, found: true, isCombo: false, errors: [], warnings: [], path: null }
      : validateGrokBuildModel(model, { modelIds, combos, capabilityLookup });

    // Hard fail only on empty/invalid required fields (already checked) or explicit validation errors
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: validation.errors[0] || "Invalid model",
          validation,
        },
        { status: 400 }
      );
    }

    if (dryRun && !probeOnly) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        message: "Validation only — config not written",
        validation,
        suggestedModel: resolveSmartDefaultModel({
          configuredModel: model,
          combos,
          modelIds,
        }),
        configPath: getGrokConfigPath(),
        modelSlot: MODEL_SLOT,
      });
    }

    // probeOnly: validate + live smoke without writing ~/.grok/config.toml
    if (probeOnly) {
      const smokeResult = await smokeTestGrokBuild({
        baseUrl: normalizedBaseUrl,
        apiKey: keyToWrite,
        model,
        probeTools: probeTools !== false,
      });
      return NextResponse.json({
        success: true,
        probeOnly: true,
        message: smokeResult.ok
          ? "Smoke test healthy (config not written)"
          : "Smoke test failed (config not written)",
        validation,
        smoke: smokeResult,
        health: {
          status: smokeResult.ok ? "healthy" : "unhealthy",
          models: smokeResult.models,
          chat: smokeResult.chat,
          latencyMs: smokeResult.latencyMs,
          error: smokeResult.error,
        },
        configPath: getGrokConfigPath(),
        modelSlot: MODEL_SLOT,
      });
    }

    const dir = getGrokDir();
    await fs.mkdir(dir, { recursive: true });

    let toml = await readConfigToml();
    toml = rememberPrevDefault(toml);
    toml = upsertModelSection(toml, buildModelSection(model, normalizedBaseUrl, keyToWrite));
    toml = setModelsDefault(toml, MODEL_SLOT);

    await fs.writeFile(getGrokConfigPath(), toml);

    let smokeResult = null;
    if (smoke !== false) {
      smokeResult = await smokeTestGrokBuild({
        baseUrl: normalizedBaseUrl,
        apiKey: keyToWrite,
        model,
        probeTools: probeTools !== false,
      });
    }

    const successMessage = smokeResult
      ? smokeResult.ok
        ? "Grok Build settings applied — smoke test healthy"
        : "Grok Build settings applied, but smoke test failed"
      : "Grok Build settings applied successfully!";

    return NextResponse.json({
      success: true,
      message: successMessage,
      configPath: getGrokConfigPath(),
      modelSlot: MODEL_SLOT,
      validation,
      smoke: smokeResult,
      // Convenience flat fields for UI badges
      health: smokeResult
        ? {
            status: smokeResult.ok ? "healthy" : "unhealthy",
            models: smokeResult.models,
            chat: smokeResult.chat,
            latencyMs: smokeResult.latencyMs,
            error: smokeResult.error,
          }
        : null,
    });
  } catch (error) {
    console.log("Error updating grok-build settings:", error);
    return NextResponse.json({ error: "Failed to update grok-build settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getGrokConfigPath();
    let toml = "";
    try {
      toml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    toml = removeModelSection(toml);
    toml = clearModelsDefaultIfOurs(toml);
    await fs.writeFile(configPath, toml);

    return NextResponse.json({
      success: true,
      message: `9router model slot removed from Grok Build (default restored to previous or ${BUILTIN_DEFAULT})`,
    });
  } catch (error) {
    console.log("Error resetting grok-build settings:", error);
    return NextResponse.json({ error: "Failed to reset grok-build settings" }, { status: 500 });
  }
}
