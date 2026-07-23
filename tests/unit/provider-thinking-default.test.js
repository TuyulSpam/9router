import { describe, expect, it } from "vitest";
import {
  applyProviderThinkingDefault,
  applyThinking,
  isRouterManagedThinkingModel,
} from "../../open-sse/translator/concerns/thinkingUnified.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

describe("applyProviderThinkingDefault", () => {
  it("injects effort only when client has no thinking intent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyProviderThinkingDefault(body, { mode: "high" });
    expect(out.reasoning_effort).toBe("high");
  });

  it("preserves client reasoning.effort over provider default", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "medium", summary: "auto" },
    };
    const out = applyProviderThinkingDefault(body, { mode: "high" });
    expect(out.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("preserves client reasoning_effort over provider default", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    };
    const out = applyProviderThinkingDefault(body, { mode: "high" });
    expect(out.reasoning_effort).toBe("low");
  });

  it("preserves Claude thinking config over provider default", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    const out = applyProviderThinkingDefault(body, { mode: "high" });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("sets reasoning_effort none for provider mode none", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyProviderThinkingDefault(body, { mode: "none" });
    expect(out.reasoning_effort).toBe("none");
    expect(out.reasoning).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  it("does nothing for auto or missing mode", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(applyProviderThinkingDefault(body, { mode: "auto" })).toBe(body);
    expect(applyProviderThinkingDefault(body, null)).toBe(body);
  });

  it("keeps extended on/off semantics when client has no thinking", () => {
    const onBody = applyProviderThinkingDefault(
      { messages: [{ role: "user", content: "hi" }] },
      { mode: "on" },
    );
    expect(onBody.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });

    const offBody = applyProviderThinkingDefault(
      { messages: [{ role: "user", content: "hi" }] },
      { mode: "off" },
    );
    expect(offBody.thinking).toEqual({ type: "disabled" });
  });

  it("replaces client thinking when the router owns the decision", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "medium", summary: "auto" },
      reasoning_effort: "low",
      thinking: { type: "enabled", budget_tokens: 4096 },
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      request: { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
      enable_thinking: true,
      thinking_budget: 2048,
    };

    const out = applyProviderThinkingDefault(body, { mode: "ultra" }, { force: true });

    expect(out.reasoning_effort).toBe("ultra");
    expect(out.reasoning).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.generationConfig.thinkingConfig).toBeUndefined();
    expect(out.request.generationConfig.thinkingConfig).toBeUndefined();
    expect(out.enable_thinking).toBeUndefined();
    expect(out.thinking_budget).toBeUndefined();
  });
});

describe("isRouterManagedThinkingModel", () => {
  it("matches Kelas-berat with or without a thinking suffix", () => {
    expect(isRouterManagedThinkingModel("Kelas-berat")).toBe(true);
    expect(isRouterManagedThinkingModel("Kelas-berat(high)")).toBe(true);
  });

  it("does not force router thinking for other models", () => {
    expect(isRouterManagedThinkingModel("Kelas-menengah")).toBe(false);
    expect(isRouterManagedThinkingModel("cx/gpt-5.6-sol")).toBe(false);
  });
});

describe("Codex provider none default reaches the wire as none", () => {
  it("maps providerThinking none through transformRequest to reasoning.effort none", () => {
    const body = applyProviderThinkingDefault(
      { input: [{ role: "user", content: "hi" }] },
      { mode: "none" },
    );
    const executor = new CodexExecutor();
    const out = executor.transformRequest("gpt-5.4", structuredClone(body), true, {});
    expect(out.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(out.include).toBeUndefined();
  });

  it("clamps none to lowest supported effort for models that cannot disable thinking", () => {
    // *codex* models advertise low/medium/high/xhigh only — no "none".
    const body = applyProviderThinkingDefault(
      { input: [{ role: "user", content: "hi" }] },
      { mode: "none" },
    );
    const normalized = applyThinking("openai-responses", "gpt-5.3-codex", structuredClone(body), "codex");
    const executor = new CodexExecutor();
    const out = executor.transformRequest("gpt-5.3-codex", structuredClone(normalized), true, {});
    expect(out.reasoning.effort).toBe("low");
    expect(out.reasoning.effort).not.toBe("none");
  });
});
