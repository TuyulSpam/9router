// Native Anthropic smoke test — Claude Code hits /v1/messages, not /chat/completions.
import { describe, expect, it, vi } from "vitest";
import { smokeTestClaudeMessages } from "../../src/lib/cli-tools/claudeSetup.js";

function okFetch() {
  return vi.fn(async (url, init = {}) => {
    if (String(url).endsWith("/v1/messages")) {
      const body = JSON.parse(init.body);
      // Anthropic request shape
      expect(body.model).toBe("cc/claude-sonnet-5");
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(Array.isArray(body.messages)).toBe(true);
      // Auth via x-api-key (native Anthropic), plus anthropic-version header
      expect(init.headers["x-api-key"]).toBe("sk_test");
      expect(init.headers["anthropic-version"]).toBeTruthy();
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "pong" }] }),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

describe("smokeTestClaudeMessages", () => {
  it("POSTs Anthropic-shaped body to /v1/messages and reports healthy", async () => {
    const fetchImpl = okFetch();
    const res = await smokeTestClaudeMessages({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "cc/claude-sonnet-5",
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    expect(res.chat).toBe("ok");
    expect(res.endpoint).toBe("http://127.0.0.1:20128/v1");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // messages only, no /chat/completions
  });

  it("normalizes a base url without /v1 suffix", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("http://127.0.0.1:20128/v1/messages");
      return { ok: true, status: 200, json: async () => ({ content: [] }), text: async () => "{}" };
    });
    await smokeTestClaudeMessages({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_test",
      model: "cc/claude-sonnet-5",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("reports unhealthy with the upstream error text on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "invalid x-api-key" } }),
      text: async () => "{}",
    }));
    const res = await smokeTestClaudeMessages({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "bad",
      model: "cc/claude-sonnet-5",
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.chat).toBe("error");
    expect(res.error).toMatch(/401|invalid x-api-key/i);
  });

  it("requires baseUrl and model", async () => {
    const res = await smokeTestClaudeMessages({ baseUrl: "", model: "", fetchImpl: vi.fn() });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/required/i);
  });

  it("never throws when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const res = await smokeTestClaudeMessages({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "cc/claude-sonnet-5",
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });
});
