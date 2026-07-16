import { describe, it, expect, vi } from "vitest";
import {
  resolveSmartDefaultModel,
  prepareGrokBuildQuickSetup,
  validateGrokBuildModel,
  analyzeProviderPath,
  rememberPrevDefault,
  setModelsDefault,
  upsertModelSection,
  removeModelSection,
  clearModelsDefaultIfOurs,
  parseModelSection,
  parseModelsDefault,
  buildModelSection,
  buildGrokBuildManualConfig,
  resolveStoredApiKeyForEndpoint,
  smokeTestGrokBuild,
  MODEL_SLOT,
  BUILTIN_DEFAULT,
} from "../../src/lib/cli-tools/grokBuildSetup.js";

describe("resolveSmartDefaultModel", () => {
  const combos = [
    { name: "Kelas-berat", models: ["cx/gpt-5.6-sol", "gcli/grok-4.5-high"], createdAt: "2026-01-01" },
    { name: "Kelas-menengah", models: ["gcli/grok-4.5-medium"], createdAt: "2026-01-02" },
  ];
  const modelIds = [
    "Kelas-berat",
    "Kelas-menengah",
    "gcli/grok-4.5-high",
    "gcli/grok-4.5-medium",
    "xai/grok-4.5-high",
    "cx/gpt-5.6-sol",
  ];

  it("prefers currently configured model when still available", () => {
    expect(
      resolveSmartDefaultModel({
        configuredModel: "Kelas-menengah",
        combos,
        modelIds,
      })
    ).toBe("Kelas-menengah");
  });

  it("falls back to first LLM combo when no configured model", () => {
    expect(
      resolveSmartDefaultModel({
        configuredModel: null,
        combos: [
          { name: "image-combo", kind: "image", models: ["image/model"] },
          ...combos,
        ],
        modelIds: ["image-combo", ...modelIds],
      })
    ).toBe("Kelas-berat");
  });

  it("prefers gcli model over xai when no combos", () => {
    expect(
      resolveSmartDefaultModel({
        configuredModel: null,
        combos: [],
        modelIds: ["xai/grok-4.5-high", "gcli/grok-4.5-high", "cx/gpt-5.6-sol"],
      })
    ).toBe("gcli/grok-4.5-high");
  });

  it("returns null when nothing available", () => {
    expect(resolveSmartDefaultModel({ configuredModel: null, combos: [], modelIds: [] })).toBeNull();
  });

  it("ignores configured model that is no longer available", () => {
    expect(
      resolveSmartDefaultModel({
        configuredModel: "deleted-combo",
        combos,
        modelIds,
      })
    ).toBe("Kelas-berat");
  });
});

describe("prepareGrokBuildQuickSetup", () => {
  it("uses the current/suggested status model plus first API key and normalized endpoint", () => {
    expect(
      prepareGrokBuildQuickSetup({
        status: {
          installed: true,
          settings: { model: null },
          suggestedModel: "Kelas-berat",
        },
        baseUrl: "http://127.0.0.1:20128",
        apiKeys: [{ key: "sk_first" }, { key: "sk_second" }],
        cloudEnabled: true,
      })
    ).toEqual({
      ok: true,
      error: null,
      payload: {
        baseUrl: "http://127.0.0.1:20128/v1",
        apiKey: "sk_first",
        model: "Kelas-berat",
        smoke: true,
        probeTools: true,
      },
      model: "Kelas-berat",
    });
  });

  it("uses configured model and first key even when custom Apply selections exist", () => {
    expect(
      prepareGrokBuildQuickSetup({
        status: {
          installed: true,
          settings: { model: { model: "gcli/grok-4.5-high" } },
          suggestedModel: "Kelas-berat",
        },
        baseUrl: "https://router.example/v1/",
        apiKeys: [{ key: "sk_first" }],
        selectedApiKey: "sk_selected",
        selectedModel: "custom/model",
        cloudEnabled: true,
      })
    ).toEqual({
      ok: true,
      error: null,
      payload: {
        baseUrl: "https://router.example/v1",
        apiKey: "sk_first",
        model: "gcli/grok-4.5-high",
        smoke: true,
        probeTools: true,
      },
      model: "gcli/grok-4.5-high",
    });
  });

  it("uses local fallback key when cloud mode is disabled", () => {
    expect(
      prepareGrokBuildQuickSetup({
        status: { installed: true, suggestedModel: "Kelas-berat" },
        baseUrl: "http://localhost:20128/v1",
        apiKeys: [],
        cloudEnabled: false,
      })
    ).toMatchObject({
      ok: true,
      payload: { apiKey: "sk_9router" },
    });
  });

  it("rejects missing install, model, endpoint, or cloud API key", () => {
    expect(prepareGrokBuildQuickSetup({ status: { installed: false } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not installed/i),
    });
    expect(
      prepareGrokBuildQuickSetup({
        status: { installed: true },
        baseUrl: "http://localhost:20128/v1",
        apiKeys: [{ key: "sk" }],
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/model/i) });
    expect(
      prepareGrokBuildQuickSetup({
        status: { installed: true, suggestedModel: "Kelas-berat" },
        baseUrl: "",
        apiKeys: [{ key: "sk" }],
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/endpoint/i) });
    expect(
      prepareGrokBuildQuickSetup({
        status: { installed: true, suggestedModel: "Kelas-berat" },
        baseUrl: "http://localhost:20128/v1",
        apiKeys: [],
        cloudEnabled: true,
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/API key/i) });
  });
});

describe("analyzeProviderPath", () => {
  it("warns when direct xai grok-4.5 path is used", () => {
    const result = analyzeProviderPath("xai/grok-4.5-high");
    expect(result.severity).toBe("warn");
    expect(result.warnings.some((w) => /gcli\//i.test(w))).toBe(true);
  });

  it("is ok for gcli path", () => {
    const result = analyzeProviderPath("gcli/grok-4.5-high");
    expect(result.severity).toBe("info");
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when combo members include risky xai path", () => {
    const result = analyzeProviderPath("Kelas-berat", {
      comboModels: ["cx/gpt-5.6-sol", "xai/grok-4.5-high"],
    });
    expect(result.severity).toBe("warn");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("is ok when combo members use gcli", () => {
    const result = analyzeProviderPath("Kelas-berat", {
      comboModels: ["cx/gpt-5.6-sol", "gcli/grok-4.5-high"],
    });
    expect(result.severity).toBe("info");
    expect(result.warnings).toHaveLength(0);
  });
});

describe("validateGrokBuildModel", () => {
  const modelIds = ["Kelas-berat", "gcli/grok-4.5-high", "xai/grok-4.5-high"];
  const combos = [
    { name: "Kelas-berat", models: ["cx/gpt-5.6-sol", "gcli/grok-4.5-high"] },
  ];

  it("accepts known combo", () => {
    const result = validateGrokBuildModel("Kelas-berat", { modelIds, combos });
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.isCombo).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts known provider model", () => {
    const result = validateGrokBuildModel("gcli/grok-4.5-high", { modelIds, combos });
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.isCombo).toBe(false);
  });

  it("flags unknown model as not found with warning (soft)", () => {
    const result = validateGrokBuildModel("totally-missing", { modelIds, combos });
    expect(result.found).toBe(false);
    expect(result.ok).toBe(true); // still applyable (custom gateway ids)
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("requires non-empty model", () => {
    const result = validateGrokBuildModel("", { modelIds, combos });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("includes provider-path warnings for xai", () => {
    const result = validateGrokBuildModel("xai/grok-4.5-high", { modelIds, combos });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /gcli\//i.test(w))).toBe(true);
  });

  it("warns when tools capability is explicitly false", () => {
    const result = validateGrokBuildModel("embed/my-embed", {
      modelIds: ["embed/my-embed"],
      combos: [],
      capabilityLookup: () => ({ tools: false }),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /tool/i.test(w))).toBe(true);
  });

  it("does not warn tools when capability is true or unknown", () => {
    const withTools = validateGrokBuildModel("gcli/grok-4.5-high", {
      modelIds: ["gcli/grok-4.5-high"],
      combos: [],
      capabilityLookup: () => ({ tools: true }),
    });
    expect(withTools.warnings.some((w) => /tool/i.test(w))).toBe(false);

    const unknown = validateGrokBuildModel("custom/unknown", {
      modelIds: ["custom/unknown"],
      combos: [],
    });
    expect(unknown.warnings.some((w) => /tool/i.test(w))).toBe(false);
  });
});

describe("idempotent apply / safe reset (TOML)", () => {
  const baseToml = `[models]
default = "grok-build"
default_reasoning_effort = "high"

[ui]
yolo = false
`;

  it("first apply remembers previous default and sets 9router slot", () => {
    let toml = baseToml;
    toml = rememberPrevDefault(toml);
    toml = upsertModelSection(
      toml,
      buildModelSection("Kelas-berat", "http://127.0.0.1:20128/v1", "sk_test")
    );
    toml = setModelsDefault(toml, MODEL_SLOT);

    expect(parseModelsDefault(toml)).toBe("9router");
    expect(toml).toMatch(/# 9router-prev-default = "grok-build"/);
    const section = parseModelSection(toml);
    expect(section.model).toBe("Kelas-berat");
    expect(section.base_url).toBe("http://127.0.0.1:20128/v1");
  });

  it("re-apply does not overwrite prev-default marker", () => {
    let toml = baseToml;
    toml = rememberPrevDefault(toml);
    toml = upsertModelSection(
      toml,
      buildModelSection("Kelas-berat", "http://127.0.0.1:20128/v1", "sk_test")
    );
    toml = setModelsDefault(toml, MODEL_SLOT);

    // second apply with different model
    toml = rememberPrevDefault(toml);
    toml = upsertModelSection(
      toml,
      buildModelSection("Kelas-menengah", "http://127.0.0.1:20128/v1", "sk_test2")
    );
    toml = setModelsDefault(toml, MODEL_SLOT);

    const markers = [...toml.matchAll(/# 9router-prev-default = "([^"]*)"/g)];
    expect(markers).toHaveLength(1);
    expect(markers[0][1]).toBe("grok-build");
    expect(parseModelSection(toml).model).toBe("Kelas-menengah");
  });

  it("reset restores previous default and removes slot", () => {
    let toml = baseToml;
    toml = rememberPrevDefault(toml);
    toml = upsertModelSection(
      toml,
      buildModelSection("Kelas-berat", "http://127.0.0.1:20128/v1", "sk_test")
    );
    toml = setModelsDefault(toml, MODEL_SLOT);

    toml = removeModelSection(toml);
    toml = clearModelsDefaultIfOurs(toml);

    expect(parseModelSection(toml)).toBeNull();
    expect(parseModelsDefault(toml)).toBe("grok-build");
    expect(toml).not.toMatch(/9router-prev-default/);
  });

  it("reset without marker falls back to built-in default", () => {
    let toml = `[models]
default = "9router"

[model.9router]
model = "Kelas-berat"
base_url = "http://127.0.0.1:20128/v1"
`;
    toml = removeModelSection(toml);
    toml = clearModelsDefaultIfOurs(toml);
    expect(parseModelsDefault(toml)).toBe(BUILTIN_DEFAULT);
  });
});

describe("TOML string safety and Manual Config masking", () => {
  it("escapes quotes and backslashes when writing the model section", () => {
    const section = buildModelSection(
      'combo"x',
      "http://127.0.0.1:20128/v1",
      'sk_"secret\\path'
    );
    expect(section).toContain('model = "combo\\"x"');
    expect(section).toContain('api_key = "sk_\\"secret\\\\path"');
  });

  it("builds Manual Config TOML with a placeholder instead of a live API key", () => {
    const content = buildGrokBuildManualConfig({
      model: "Kelas-berat",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_live_should_not_appear",
    });
    expect(content).toContain('model = "Kelas-berat"');
    expect(content).toContain('base_url = "http://127.0.0.1:20128/v1"');
    expect(content).toContain('api_key = "<API_KEY_FROM_DASHBOARD>"');
    expect(content).not.toContain("sk_live_should_not_appear");
  });

  it("reuses a stored key only when the endpoint matches", () => {
    const stored = {
      model: "Kelas-berat",
      base_url: "http://127.0.0.1:20128/v1",
      api_key: "sk_stored",
    };
    expect(
      resolveStoredApiKeyForEndpoint({
        requestedBaseUrl: "http://127.0.0.1:20128/v1",
        storedModel: stored,
      })
    ).toBe("sk_stored");
    expect(
      resolveStoredApiKeyForEndpoint({
        requestedBaseUrl: "http://127.0.0.1:20128",
        storedModel: stored,
      })
    ).toBe("sk_stored");
    expect(
      resolveStoredApiKeyForEndpoint({
        requestedBaseUrl: "https://router.example/v1",
        storedModel: stored,
      })
    ).toBe("");
  });
});

describe("smokeTestGrokBuild", () => {
  it("reports healthy when chat completions succeeds", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "Kelas-berat" }] }),
        };
      }
      if (String(url).includes("/chat/completions")) {
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body);
        expect(body.model).toBe("Kelas-berat");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "pong" } }],
          }),
          text: async () => '{"choices":[{"message":{"content":"pong"}}]}',
        };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await smokeTestGrokBuild({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "Kelas-berat",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.models).toBe("ok");
    expect(result.chat).toBe("ok");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.error).toBeNull();
  });

  it("sends a tiny tool definition when tool-call probing is enabled", async () => {
    let chatBody = null;
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gcli/grok-4.5-high" }] }) };
      }
      chatBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { tool_calls: [] } }] }),
        text: async () => "{}",
      };
    });

    const result = await smokeTestGrokBuild({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "gcli/grok-4.5-high",
      fetchImpl,
      probeTools: true,
    });

    expect(result.ok).toBe(true);
    expect(chatBody.tools).toHaveLength(1);
    expect(chatBody.tools[0].function.name).toBe("health_check");
    expect(chatBody.tool_choice).toBe("none");
  });

  it("reports unhealthy when chat fails", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { message: "Model not found" } }),
        text: async () => '{"error":{"message":"Model not found"}}',
      };
    });

    const result = await smokeTestGrokBuild({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "missing",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.chat).toBe("error");
    expect(result.error).toMatch(/Model not found|404/i);
  });
});
