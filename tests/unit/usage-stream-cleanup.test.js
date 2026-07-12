import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = { update: new Set(), pending: new Set() };
  return {
    listeners,
    getUsageStats: vi.fn(),
    getActiveRequests: vi.fn(),
    statsEmitter: {
      on(event, listener) {
        listeners[event].add(listener);
      },
      off(event, listener) {
        listeners[event].delete(listener);
      },
    },
  };
});

vi.mock("@/lib/usageDb", () => ({
  getUsageStats: mocks.getUsageStats,
  getActiveRequests: mocks.getActiveRequests,
  statsEmitter: mocks.statsEmitter,
}));

import { GET } from "@/app/api/usage/stream/route.js";

describe("usage SSE cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.update.clear();
    mocks.listeners.pending.clear();
    mocks.getUsageStats.mockResolvedValue({ totalRequests: 0 });
    mocks.getActiveRequests.mockResolvedValue({
      activeRequests: [],
      recentRequests: [],
      errorProvider: "",
    });
  });

  it("removes emitter listeners when request aborts", async () => {
    const controller = new AbortController();
    const response = await GET({ signal: controller.signal });
    const reader = response.body.getReader();

    await reader.read();
    expect(mocks.listeners.update.size).toBe(1);
    expect(mocks.listeners.pending.size).toBe(1);

    controller.abort();
    await Promise.resolve();

    expect(mocks.listeners.update.size).toBe(0);
    expect(mocks.listeners.pending.size).toBe(0);
    await reader.cancel();
  });

  it("does not attach listeners when request aborts during initial stats load", async () => {
    let resolveStats;
    mocks.getUsageStats.mockReturnValue(new Promise((resolve) => {
      resolveStats = resolve;
    }));
    const controller = new AbortController();

    await GET({ signal: controller.signal });
    controller.abort();
    resolveStats({ totalRequests: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.listeners.update.size).toBe(0);
    expect(mocks.listeners.pending.size).toBe(0);
  });
});
