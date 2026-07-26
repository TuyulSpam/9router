/** Claude Code terminal action contract (mirrors grok-build-cli-actions). */
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const menuPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../cli/src/cli/menus/claudeCodeMenu.js"
);

function loadMenu() {
  return require(menuPath);
}

function baseDeps(apiOverrides = {}) {
  return {
    api: {
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: false,
          settings: { env: {} },
          suggestedModels: {
            opus: "cc/claude-opus-4-8",
            sonnet: "cc/claude-sonnet-5",
            haiku: "cc/claude-haiku-4-5-20251001",
          },
        },
      })),
      getApiKeys: vi.fn(async () => ({ success: true, data: { keys: [{ key: "sk_first" }] } })),
      getSettings: vi.fn(async () => ({ success: true, data: { cloudEnabled: false } })),
      applyCliToolSettings: vi.fn(async () => ({
        success: true,
        data: { message: "ok", health: { status: "healthy", latencyMs: 25 } },
      })),
      resetCliToolSettings: vi.fn(async () => ({ success: true, data: { message: "reset" } })),
      ...apiOverrides,
    },
    getEndpoint: vi.fn(async () => ({ endpoint: "http://localhost:20128/v1", tunnelEnabled: false })),
    pause: vi.fn(async () => {}),
    showStatus: vi.fn(),
    print: vi.fn(),
    selectModelFromList: vi.fn(async () => "cc/claude-opus-4-8"),
  };
}

describe("claude quickSetup", () => {
  it("uses server suggestedModels + first key + endpoint, without hardcoded versions", async () => {
    const { quickSetup } = loadMenu();
    const deps = baseDeps();

    await quickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith("claude", {
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:20128/v1",
        ANTHROPIC_AUTH_TOKEN: "sk_first",
        API_TIMEOUT_MS: "600000",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-8",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/claude-sonnet-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "cc/claude-haiku-4-5-20251001",
      },
    });
    expect(deps.showStatus).toHaveBeenCalledWith(expect.stringMatching(/completed/i), "success");
  });

  it("falls back to sk_9router in local mode when no API key exists", async () => {
    const { quickSetup } = loadMenu();
    const deps = baseDeps({
      getApiKeys: vi.fn(async () => ({ success: true, data: { keys: [] } })),
      getSettings: vi.fn(async () => ({ success: true, data: { cloudEnabled: false } })),
    });

    await quickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ env: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: "sk_9router" }) })
    );
  });

  it("does not Apply when Claude Code is not installed", async () => {
    const { quickSetup } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: { installed: false, suggestedModels: { opus: null, sonnet: null, haiku: null } },
      })),
    });

    await quickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(expect.stringMatching(/not installed/i), "error");
  });

  it("does not Apply in cloud mode when no API key exists", async () => {
    const { quickSetup } = loadMenu();
    const deps = baseDeps({
      getApiKeys: vi.fn(async () => ({ success: true, data: { keys: [] } })),
      getSettings: vi.fn(async () => ({ success: true, data: { cloudEnabled: true } })),
    });

    await quickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(expect.stringMatching(/API key/i), "error");
  });
});

describe("claude selectTier", () => {
  it("includes combos in the model picker (no excludeCombos)", async () => {
    const { selectTier, TIERS } = loadMenu();
    const deps = baseDeps();
    const opus = TIERS.find((t) => t.id === "opus");

    await selectTier(opus, 20128, deps);

    // second arg must be omitted or not carry excludeCombos:true
    const call = deps.selectModelFromList.mock.calls[0];
    const opts = call[2];
    expect(opts?.excludeCombos).not.toBe(true);
    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        env: expect.objectContaining({ ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-8" }),
      })
    );
  });
});

describe("claude testHealth", () => {
  it("sends probeOnly and never writes config", async () => {
    const { testHealth } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: true,
          settings: {
            env: {
              ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
              ANTHROPIC_AUTH_TOKEN: "sk_first",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/claude-sonnet-5",
            },
          },
        },
      })),
    });

    await testHealth(deps);

    const call = deps.api.applyCliToolSettings.mock.calls[0];
    expect(call[0]).toBe("claude");
    expect(call[1].probeOnly).toBe(true);
    expect(deps.showStatus).toHaveBeenCalledWith(expect.stringMatching(/healthy/i), "success");
  });

  it("refuses to probe an unconfigured install", async () => {
    const { testHealth } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: { installed: true, settings: { env: {} } },
      })),
    });

    await testHealth(deps);

    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(expect.stringMatching(/configure/i), "error");
  });
});

describe("claude buildHeader", () => {
  it("distinguishes not-installed from not-configured", () => {
    const { buildHeader } = loadMenu();
    expect(buildHeader({ installed: false })).toMatch(/not installed/i);
    expect(buildHeader({ installed: true, settings: { env: {} } })).toMatch(/not configured/i);
    expect(
      buildHeader({ installed: true, settings: { env: { ANTHROPIC_BASE_URL: "http://x/v1" } } })
    ).toMatch(/configured/i);
  });
});
