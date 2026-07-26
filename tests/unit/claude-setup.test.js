// Pure helpers for Claude Code CLI-tool setup: server-resolved tier defaults.
import { describe, expect, it } from "vitest";
import {
  resolveClaudeSuggestedModels,
  CLAUDE_TIER_ENV_KEYS,
} from "../../src/lib/cli-tools/claudeSetup.js";

const CC_MODELS = [
  "cc/claude-fable-5",
  "cc/claude-sonnet-5",
  "cc/claude-opus-4-8",
  "cc/claude-opus-4-7",
  "cc/claude-haiku-4-5-20251001",
];

describe("resolveClaudeSuggestedModels", () => {
  it("matches each tier to a live model id by name", () => {
    const out = resolveClaudeSuggestedModels({ models: CC_MODELS });
    expect(out.opus).toBe("cc/claude-opus-4-8"); // first opus match
    expect(out.sonnet).toBe("cc/claude-sonnet-5");
    expect(out.haiku).toBe("cc/claude-haiku-4-5-20251001");
  });

  it("keeps a still-valid current env value over the name match", () => {
    const out = resolveClaudeSuggestedModels({
      models: CC_MODELS,
      currentEnv: { ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-7" },
    });
    expect(out.opus).toBe("cc/claude-opus-4-7");
  });

  it("ignores a current env value that is no longer in the catalog", () => {
    const out = resolveClaudeSuggestedModels({
      models: CC_MODELS,
      currentEnv: { ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-5-20251101" },
    });
    expect(out.opus).toBe("cc/claude-opus-4-8");
  });

  it("falls back to the first available model when a tier has no name match", () => {
    const out = resolveClaudeSuggestedModels({ models: ["cc/claude-fable-5"] });
    expect(out.opus).toBe("cc/claude-fable-5");
    expect(out.sonnet).toBe("cc/claude-fable-5");
    expect(out.haiku).toBe("cc/claude-fable-5");
  });

  it("returns nulls when the catalog is empty", () => {
    const out = resolveClaudeSuggestedModels({ models: [] });
    expect(out).toEqual({ opus: null, sonnet: null, haiku: null });
  });

  it("exposes the tier->envKey map used by the client", () => {
    expect(CLAUDE_TIER_ENV_KEYS).toEqual({
      opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    });
  });
});
