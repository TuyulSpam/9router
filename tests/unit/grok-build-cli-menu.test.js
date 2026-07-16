/**
 * P0.1 — Grok Build terminal menu helpers (pure, no TTY).
 * Exercises status formatting, quick-setup payload, model resolution,
 * and health/action result messages used by CLI Tools → Grok Build.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const helpersPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../cli/src/cli/menus/grokBuildHelpers.js"
);

// Lazy require so RED fails with module-not-found before helpers exist
function loadHelpers() {
  return require(helpersPath);
}

describe("grokBuildHelpers — model resolution", () => {
  it("prefers configured model, then suggestedModel, else null", () => {
    const { resolveGrokBuildQuickModel } = loadHelpers();

    expect(
      resolveGrokBuildQuickModel({
        settings: { model: { model: "Kelas-berat" } },
        suggestedModel: "gcli/grok-4.5-high",
      })
    ).toBe("Kelas-berat");

    expect(
      resolveGrokBuildQuickModel({
        settings: { model: null },
        suggestedModel: "gcli/grok-4.5-high",
      })
    ).toBe("gcli/grok-4.5-high");

    expect(resolveGrokBuildQuickModel({})).toBe(null);
    expect(resolveGrokBuildQuickModel(null)).toBe(null);
  });
});

describe("grokBuildHelpers — apply / probe payloads", () => {
  it("builds Apply payload with smoke + probeTools", () => {
    const { buildGrokBuildApplyPayload } = loadHelpers();
    expect(
      buildGrokBuildApplyPayload({
        endpoint: "http://127.0.0.1:20128/v1",
        apiKey: "sk_test",
        model: "Kelas-berat",
      })
    ).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "Kelas-berat",
      smoke: true,
      probeTools: true,
    });
  });

  it("builds probeOnly payload without inventing a placeholder API key", () => {
    const { buildGrokBuildApplyPayload } = loadHelpers();
    const payload = buildGrokBuildApplyPayload({
      endpoint: "http://localhost:20128/v1",
      apiKey: null,
      model: "gcli/grok-4.5-high",
      probeOnly: true,
    });
    expect(payload).toEqual({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "",
      model: "gcli/grok-4.5-high",
      smoke: true,
      probeTools: true,
      probeOnly: true,
    });
  });

  it("normalizes baseUrl to end with /v1", () => {
    const { normalizeGrokBuildBaseUrl } = loadHelpers();
    expect(normalizeGrokBuildBaseUrl("http://127.0.0.1:20128")).toBe(
      "http://127.0.0.1:20128/v1"
    );
    expect(normalizeGrokBuildBaseUrl("http://127.0.0.1:20128/v1")).toBe(
      "http://127.0.0.1:20128/v1"
    );
    expect(normalizeGrokBuildBaseUrl("http://127.0.0.1:20128/v1/")).toBe(
      "http://127.0.0.1:20128/v1"
    );
  });
});

describe("grokBuildHelpers — status summary", () => {
  it("reports not installed", () => {
    const { summarizeGrokBuildStatus } = loadHelpers();
    const s = summarizeGrokBuildStatus({ installed: false });
    expect(s.installed).toBe(false);
    expect(s.configured).toBe(false);
    expect(s.statusLabel).toMatch(/not installed/i);
  });

  it("reports not configured when installed without base_url", () => {
    const { summarizeGrokBuildStatus } = loadHelpers();
    const s = summarizeGrokBuildStatus({
      installed: true,
      has9Router: false,
      settings: { model: null, default: "grok-build" },
      suggestedModel: "Kelas-berat",
    });
    expect(s.installed).toBe(true);
    expect(s.configured).toBe(false);
    expect(s.statusLabel).toMatch(/not configured/i);
    expect(s.suggestedModel).toBe("Kelas-berat");
  });

  it("reports configured with model + endpoint + optional health", () => {
    const { summarizeGrokBuildStatus } = loadHelpers();
    const s = summarizeGrokBuildStatus(
      {
        installed: true,
        has9Router: true,
        settings: {
          model: {
            model: "Kelas-berat",
            base_url: "http://127.0.0.1:20128/v1",
          },
          default: "9router",
        },
        suggestedModel: "Kelas-berat",
      },
      { status: "healthy", latencyMs: 42 }
    );
    expect(s.configured).toBe(true);
    expect(s.model).toBe("Kelas-berat");
    expect(s.endpoint).toBe("http://127.0.0.1:20128/v1");
    expect(s.healthLabel).toMatch(/healthy/i);
    expect(s.latencyMs).toBe(42);
    expect(s.statusLabel).toMatch(/configured/i);
  });

  it("formats multi-line header text for the terminal", () => {
    const { formatGrokBuildHeader } = loadHelpers();
    const text = formatGrokBuildHeader(
      {
        installed: true,
        has9Router: true,
        settings: {
          model: {
            model: "Kelas-berat",
            base_url: "http://127.0.0.1:20128/v1",
          },
          default: "9router",
        },
      },
      { status: "unhealthy", error: "timeout", latencyMs: 12000 }
    );
    expect(text).toContain("Configured");
    expect(text).toContain("Kelas-berat");
    expect(text).toContain("http://127.0.0.1:20128/v1");
    expect(text).toMatch(/unhealthy/i);
  });
});

describe("grokBuildHelpers — action result messages", () => {
  it("formats healthy apply result", () => {
    const { formatGrokBuildActionMessage } = loadHelpers();
    const msg = formatGrokBuildActionMessage({
      success: true,
      message: "Grok Build settings applied — smoke test healthy",
      health: { status: "healthy", latencyMs: 88 },
      validation: { warnings: [] },
    });
    expect(msg.type).toBe("success");
    expect(msg.text).toMatch(/healthy/i);
    expect(msg.text).toMatch(/88/);
  });

  it("formats unhealthy probeOnly result as warning", () => {
    const { formatGrokBuildActionMessage } = loadHelpers();
    const msg = formatGrokBuildActionMessage(
      {
        success: true,
        probeOnly: true,
        health: { status: "unhealthy", error: "chat 503", latencyMs: 10 },
      },
      { probeOnly: true }
    );
    expect(msg.type).toBe("warning");
    expect(msg.text).toMatch(/failed|unhealthy|503/i);
    expect(msg.text).toMatch(/unchanged|not written|probe/i);
  });

  it("formats API failure as error", () => {
    const { formatGrokBuildActionMessage } = loadHelpers();
    const msg = formatGrokBuildActionMessage({
      success: false,
      error: "Unauthorized",
    });
    expect(msg.type).toBe("error");
    expect(msg.text).toMatch(/Unauthorized/);
  });
});

describe("grokBuildHelpers — menu item labels", () => {
  it("exposes the five expected Grok Build submenu actions", () => {
    const { GROK_BUILD_MENU_ACTIONS } = loadHelpers();
    expect(GROK_BUILD_MENU_ACTIONS.map((a) => a.id)).toEqual([
      "status",
      "quick-setup",
      "custom-setup",
      "test-health",
      "reset",
    ]);
  });
});
