import { afterEach, describe, expect, it, vi } from "vitest";

describe("proxyAwareFetch undici proxy path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("uses undici.fetch with ProxyAgent instead of Node global fetch + dispatcher", async () => {
    const undiciFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const ProxyAgent = vi.fn(function ProxyAgent() {
      this.kind = "proxy-agent";
    });

    vi.doMock("undici", () => ({
      ProxyAgent,
      fetch: undiciFetch,
    }));

    const originalFetch = vi.fn(async () => {
      throw new Error("Node global fetch should not be used for proxied requests");
    });
    vi.stubGlobal("fetch", originalFetch);

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const response = await proxyAwareFetch(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:18080",
        strictProxy: true,
      },
    );

    expect(ProxyAgent).toHaveBeenCalledWith({ uri: "http://127.0.0.1:18080" });
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).not.toHaveBeenCalled();

    const [, undiciOptions] = undiciFetch.mock.calls[0];
    expect(undiciOptions.dispatcher).toEqual(expect.objectContaining({ kind: "proxy-agent" }));
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
