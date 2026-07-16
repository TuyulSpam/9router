/** P0.1 Grok Build terminal action contract. */
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const menuPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../cli/src/cli/menus/grokBuildMenu.js"
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
          settings: { model: null, default: "grok-build" },
          suggestedModel: "Kelas-berat",
        },
      })),
      getApiKeys: vi.fn(async () => ({
        success: true,
        data: { keys: [{ key: "sk_first" }] },
      })),
      getSettings: vi.fn(async () => ({
        success: true,
        data: { cloudEnabled: false },
      })),
      applyCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          message: "Grok Build settings applied — smoke test healthy",
          health: { status: "healthy", latencyMs: 25 },
          validation: { warnings: [] },
        },
      })),
      resetCliToolSettings: vi.fn(async () => ({
        success: true,
        data: { message: "Grok Build reset" },
      })),
      ...apiOverrides,
    },
    getEndpoint: vi.fn(async () => ({
      endpoint: "http://localhost:20128/v1",
      tunnelEnabled: false,
    })),
    prompt: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    pause: vi.fn(async () => {}),
    showStatus: vi.fn(),
    print: vi.fn(),
    selectModelFromList: vi.fn(async () => "Kelas-berat"),
  };
}

describe("grokBuildQuickSetup", () => {
  it("uses endpoint, first API key, and suggested model without prompting", async () => {
    const { grokBuildQuickSetup } = loadMenu();
    const deps = baseDeps();

    const health = await grokBuildQuickSetup(20128, deps);

    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.selectModelFromList).not.toHaveBeenCalled();
    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith("grok-build", {
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk_first",
      model: "Kelas-berat",
      smoke: true,
      probeTools: true,
    });
    expect(health).toEqual({ status: "healthy", latencyMs: 25 });
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/healthy/i),
      "success"
    );
  });

  it("keeps the current configured model as the quick default", async () => {
    const { grokBuildQuickSetup } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: true,
          settings: {
            model: {
              model: "gcli/grok-4.5-high",
              base_url: "http://old/v1",
            },
            default: "9router",
          },
          suggestedModel: "Kelas-berat",
        },
      })),
    });

    await grokBuildQuickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith(
      "grok-build",
      expect.objectContaining({ model: "gcli/grok-4.5-high" })
    );
  });

  it("does not Apply when Grok Build is not installed", async () => {
    const { grokBuildQuickSetup } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: { installed: false, suggestedModel: "Kelas-berat" },
      })),
    });

    const health = await grokBuildQuickSetup(20128, deps);

    expect(health).toBe(null);
    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/not installed/i),
      "error"
    );
  });

  it("uses sk_9router for local Quick Setup when no API key exists", async () => {
    const { grokBuildQuickSetup } = loadMenu();
    const deps = baseDeps({
      getApiKeys: vi.fn(async () => ({ success: true, data: { keys: [] } })),
      getSettings: vi.fn(async () => ({ success: true, data: { cloudEnabled: false } })),
    });

    await grokBuildQuickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith("grok-build", {
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk_9router",
      model: "Kelas-berat",
      smoke: true,
      probeTools: true,
    });
  });

  it("does not Apply when cloud mode is enabled and no API key exists", async () => {
    const { grokBuildQuickSetup } = loadMenu();
    const deps = baseDeps({
      getApiKeys: vi.fn(async () => ({ success: true, data: { keys: [] } })),
      getSettings: vi.fn(async () => ({ success: true, data: { cloudEnabled: true } })),
    });

    await grokBuildQuickSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/API key/i),
      "error"
    );
  });
});

describe("grokBuildCustomSetup", () => {
  it("lets the user override endpoint/key and choose a model", async () => {
    const { grokBuildCustomSetup } = loadMenu();
    const deps = baseDeps();
    deps.prompt
      .mockResolvedValueOnce("http://router.example:9000")
      .mockResolvedValueOnce("sk_custom");
    deps.selectModelFromList.mockResolvedValueOnce("gcli/grok-4.5-high");

    await grokBuildCustomSetup(20128, deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith("grok-build", {
      baseUrl: "http://router.example:9000/v1",
      apiKey: "sk_custom",
      model: "gcli/grok-4.5-high",
      smoke: true,
      probeTools: true,
    });
  });
});

describe("grokBuildTestHealth", () => {
  it("sends probeOnly without echoing a stored API key from GET", async () => {
    const { grokBuildTestHealth } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: true,
          settings: {
            model: {
              model: "Kelas-berat",
              base_url: "http://127.0.0.1:20128/v1",
              hasApiKey: true,
            },
            default: "9router",
          },
        },
      })),
    });

    const health = await grokBuildTestHealth(deps);

    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith("grok-build", {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "",
      model: "Kelas-berat",
      smoke: true,
      probeTools: true,
      probeOnly: true,
    });
    expect(health).toEqual({ status: "healthy", latencyMs: 25 });
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/unchanged/i),
      "success"
    );
  });

  it("prefers configured-key hint when hasApiKey is true during custom setup", async () => {
    const { grokBuildCustomSetup } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: true,
          settings: {
            model: {
              model: "gcli/grok-4.5-high",
              base_url: "http://127.0.0.1:20128/v1",
              hasApiKey: true,
            },
            default: "9router",
          },
          suggestedModel: "Kelas-berat",
        },
      })),
    });
    deps.getEndpoint.mockResolvedValueOnce({
      endpoint: "http://127.0.0.1:20128/v1",
      tunnelEnabled: false,
    });
    deps.prompt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    deps.selectModelFromList.mockResolvedValueOnce("gcli/grok-4.5-high");

    await grokBuildCustomSetup(20128, deps);

    expect(deps.prompt).toHaveBeenCalledWith(
      expect.stringContaining("configured key")
    );
    // Empty key input signals the server to reuse the stored key without echoing it via GET.
    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith(
      "grok-build",
      expect.objectContaining({
        model: "gcli/grok-4.5-high",
        apiKey: "",
      })
    );
  });

  it("does not reuse the configured-key hint when the endpoint changes", async () => {
    const { grokBuildCustomSetup } = loadMenu();
    const deps = baseDeps({
      getCliToolSettings: vi.fn(async () => ({
        success: true,
        data: {
          installed: true,
          has9Router: true,
          settings: {
            model: {
              model: "gcli/grok-4.5-high",
              base_url: "http://127.0.0.1:20128/v1",
              hasApiKey: true,
            },
            default: "9router",
          },
          suggestedModel: "Kelas-berat",
        },
      })),
    });
    deps.prompt
      .mockResolvedValueOnce("https://router.example:9000")
      .mockResolvedValueOnce("");
    deps.selectModelFromList.mockResolvedValueOnce("gcli/grok-4.5-high");

    await grokBuildCustomSetup(20128, deps);

    expect(deps.prompt).toHaveBeenCalledWith(
      expect.stringContaining("first 9Router key")
    );
    expect(deps.api.applyCliToolSettings).toHaveBeenCalledWith(
      "grok-build",
      expect.objectContaining({
        baseUrl: "https://router.example:9000/v1",
        apiKey: "sk_first",
      })
    );
  });

  it("does not probe an unconfigured installation", async () => {
    const { grokBuildTestHealth } = loadMenu();
    const deps = baseDeps();

    await grokBuildTestHealth(deps);

    expect(deps.api.applyCliToolSettings).not.toHaveBeenCalled();
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/configure/i),
      "error"
    );
  });
});

describe("grokBuildReset", () => {
  it("never sends DELETE when confirmation is declined", async () => {
    const { grokBuildReset } = loadMenu();
    const deps = baseDeps();
    deps.confirm.mockResolvedValueOnce(false);

    const reset = await grokBuildReset(deps);

    expect(reset).toBe(false);
    expect(deps.api.resetCliToolSettings).not.toHaveBeenCalled();
  });

  it("sends DELETE only after confirmation", async () => {
    const { grokBuildReset } = loadMenu();
    const deps = baseDeps();

    const reset = await grokBuildReset(deps);

    expect(reset).toBe(true);
    expect(deps.api.resetCliToolSettings).toHaveBeenCalledWith("grok-build");
    expect(deps.showStatus).toHaveBeenCalledWith(
      expect.stringMatching(/reset/i),
      "success"
    );
  });
});
