import { describe, it, expect, vi, beforeEach } from "vitest";
import { brotliCompressSync } from "node:zlib";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("uses the official IDE user agent and omits router-only source headers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe("antigravity/ide/2.1.1 darwin/arm64");
      expect(options.headers["Accept-Encoding"]).toBe("identity");
      expect(options.headers).not.toHaveProperty("x-request-source");
    }
  });

  it("parses a Brotli-compressed quota response", async () => {
    const quotaBody = brotliCompressSync(Buffer.from(JSON.stringify({
      models: {
        "gemini-3-flash-agent": {
          displayName: "Gemini 3 Flash",
          quotaInfo: { remainingFraction: 0.75 },
        },
      },
    })));

    proxyAwareFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "content-encoding" ? "br" : null },
        arrayBuffer: async () => quotaBody,
      });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["gemini-3-flash-agent"]).toMatchObject({
      used: 250,
      remainingPercentage: 75,
    });
  });
});
