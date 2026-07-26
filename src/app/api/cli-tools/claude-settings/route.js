"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCombos } from "@/lib/localDb";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveClaudeSuggestedModels, smokeTestClaudeMessages } from "@/lib/cli-tools/claudeSetup.js";

const execAsync = promisify(exec);

const EMPTY_SUGGESTED = { opus: null, sonnet: null, haiku: null };

// Claude Code speaks the Anthropic format → the cc (Claude) provider models,
// plus any combos (the auto-fallback flagship), are the valid default targets.
async function loadClaudeCatalog() {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  try {
    for (const m of getModelsByProviderId("claude") || []) push(`cc/${m.id}`);
  } catch {
    // soft — catalog enrichment only
  }
  let combos = [];
  try {
    combos = await getCombos();
  } catch {
    // soft — combos optional
  }
  for (const c of combos) if (c?.name) push(c.name);
  return { ids };
}

// Get claude settings path based on OS
const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};


// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
        suggestedModels: EMPTY_SUGGESTED,
      });
    }

    const settings = await readSettings();
    const has9Router = !!(settings?.env?.ANTHROPIC_BASE_URL);

    const { ids } = await loadClaudeCatalog();
    const suggestedModels = resolveClaudeSuggestedModels({
      models: ids,
      currentEnv: settings?.env || {},
    });

    return NextResponse.json({
      installed: true,
      settings: settings,
      has9Router: has9Router,
      settingsPath: getClaudeSettingsPath(),
      suggestedModels,
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env, probeOnly = false } = await request.json();

    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }

    // Test Health — live smoke test without writing ~/.claude/settings.json.
    // Probes the native Anthropic /v1/messages path Claude Code actually uses
    // (not OpenAI /chat/completions), so green reflects the real client path.
    // Sonnet is the most representative tier, falling back to Opus/Haiku.
    if (probeOnly) {
      const baseUrl = env.ANTHROPIC_BASE_URL;
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || "";
      const model =
        env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
        env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      if (!baseUrl || !model) {
        return NextResponse.json(
          { error: "baseUrl and a default model are required for probeOnly" },
          { status: 400 }
        );
      }
      const smoke = await smokeTestClaudeMessages({ baseUrl, apiKey, model });
      return NextResponse.json({
        success: true,
        probeOnly: true,
        message: smoke.ok
          ? "Smoke test healthy (config not written)"
          : "Smoke test failed (config not written)",
        smoke,
        health: {
          status: smoke.ok ? "healthy" : "unhealthy",
          chat: smoke.chat,
          latencyMs: smoke.latencyMs,
          error: smoke.error,
        },
      });
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1") 
        ? env.ANTHROPIC_BASE_URL 
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}

