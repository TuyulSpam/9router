import { brotliCompressSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getCodexUsage } from "../../open-sse/services/usage/codex.js";

const usagePayload = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 20, reset_at: 1784200000 },
    secondary_window: { used_percent: 40, reset_at: 1784300000 },
  },
};

describe("Codex usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests an identity-encoded response with Codex account headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json(usagePayload));

    const usage = await getCodexUsage("token", { strictProxy: false }, { chatgptAccountId: "acct_123" });

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Accept-Encoding": "identity",
          "ChatGPT-Account-ID": "acct_123",
          "OpenAI-Beta": "codex-1",
          originator: "codex_cli_rs",
        }),
      }),
      { strictProxy: false },
    );
    expect(usage.plan).toBe("pro");
    expect(usage.quotas.session).toMatchObject({ used: 20, remaining: 80 });
    expect(usage.quotas.weekly).toMatchObject({ used: 40, remaining: 60 });
  });

  it("decodes a Brotli body forwarded by a proxy", async () => {
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify(usagePayload)));
    proxyAwareFetch.mockResolvedValueOnce(new Response(compressed, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "br",
      },
    }));

    const usage = await getCodexUsage("token");

    expect(usage.plan).toBe("pro");
    expect(usage.quotas.session.remaining).toBe(80);
  });

  it("reports invalid upstream data without exposing binary body contents", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0x64, 0x53, 0x80]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }));

    await expect(getCodexUsage("token")).rejects.toThrow(
      "Failed to fetch Codex usage: Codex usage API returned invalid JSON (application/octet-stream).",
    );
  });
});
