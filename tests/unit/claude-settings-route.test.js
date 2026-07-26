import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}));

const execMocks = vi.hoisted(() => ({ execAsync: vi.fn() }));

vi.mock("fs/promises", () => ({ default: fsMocks }));
vi.mock("child_process", () => ({ exec: vi.fn() }));
vi.mock("util", () => ({ promisify: () => execMocks.execAsync }));
vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn(async () => [{ id: "c1", name: "MyFallback", kind: null, models: ["cc/claude-sonnet-5"] }]),
}));
vi.mock("open-sse/config/providerModels.js", () => ({
  getModelsByProviderId: vi.fn(() => [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ]),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
}));

import { GET, POST } from "../../src/app/api/cli-tools/claude-settings/route.js";

function requestWith(body) {
  return { json: async () => body };
}

describe("Claude settings GET suggestedModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMocks.execAsync.mockResolvedValue({ stdout: "/usr/bin/claude" }); // installed
    fsMocks.access.mockResolvedValue(undefined);
  });

  it("returns per-tier suggested models resolved from the live catalog", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ env: {} }));
    const res = await GET();
    const body = await res.json();

    expect(body.installed).toBe(true);
    expect(body.suggestedModels).toEqual({
      opus: "cc/claude-opus-4-8",
      sonnet: "cc/claude-sonnet-5",
      haiku: "cc/claude-haiku-4-5-20251001",
    });
  });
});

describe("Claude settings POST probeOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url, init = {}) => {
      // Claude Code path is native Anthropic /v1/messages, not /chat/completions.
      if (String(url).endsWith("/v1/messages")) {
        const body = JSON.parse(init.body);
        expect(body.model).toBe("cc/claude-sonnet-5");
        expect(Array.isArray(body.messages)).toBe(true);
        expect(init.headers["anthropic-version"]).toBeTruthy();
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "pong" }] }), text: async () => "{}" };
      }
      throw new Error(`unexpected URL: ${url}`);
    });
  });

  it("runs a smoke test and does NOT write settings", async () => {
    const res = await POST(requestWith({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
        ANTHROPIC_AUTH_TOKEN: "sk_test",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/claude-sonnet-5",
      },
      probeOnly: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.probeOnly).toBe(true);
    expect(body.health?.status).toBe("healthy");
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects probeOnly without a base url or model", async () => {
    const res = await POST(requestWith({ env: { ANTHROPIC_AUTH_TOKEN: "sk_test" }, probeOnly: true }));
    expect(res.status).toBe(400);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });
});
