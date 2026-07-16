import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsMocks }));
vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn(async () => [
    {
      id: "combo-1",
      name: "Kelas-berat",
      kind: null,
      models: ["cx/gpt-5.6-sol", "gcli/grok-4.5-high"],
    },
  ]),
}));
vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({ tools: true })),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
}));

import { GET, POST } from "../../src/app/api/cli-tools/grok-build-settings/route.js";

function requestWith(body) {
  return { json: async () => body };
}

function mockGatewayFetch() {
  return vi.fn(async (url, init = {}) => {
    if (String(url).endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "Kelas-berat" }] }),
      };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("Kelas-berat");
      expect(body.tools).toHaveLength(1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "pong" } }] }),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

describe("Grok Build settings GET/POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.readFile.mockResolvedValue(`[models]
default = "grok-build"
`);
    global.fetch = mockGatewayFetch();
  });

  it("GET redacts api_key and reports hasApiKey instead", async () => {
    fsMocks.readFile.mockResolvedValue(`[models]
default = "9router"

[model.9router]
model = "Kelas-berat"
base_url = "http://127.0.0.1:20128/v1"
name = "9Router"
api_backend = "chat_completions"
api_key = "sk_live_secret"
`);
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.installed).toBe(true);
    expect(body.settings?.model?.model).toBe("Kelas-berat");
    expect(body.settings?.model?.base_url).toBe("http://127.0.0.1:20128/v1");
    expect(body.settings?.model?.api_key).toBeUndefined();
    expect(body.settings?.model?.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk_live_secret");
  });

  it("probeOnly uses the stored config key when the client omits apiKey", async () => {
    fsMocks.readFile.mockResolvedValue(`[models]
default = "9router"

[model.9router]
model = "Kelas-berat"
base_url = "http://127.0.0.1:20128/v1"
api_key = "sk_stored"
`);
    global.fetch = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/v1/models") || String(url).endsWith("/models")) {
        const auth = init.headers?.Authorization || "";
        expect(auth).toBe("Bearer sk_stored");
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "Kelas-berat" }] }),
        };
      }
      if (String(url).includes("/chat/completions")) {
        const auth = init.headers?.Authorization || "";
        expect(auth).toBe("Bearer sk_stored");
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "pong" } }] }),
          text: async () => "{}",
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const response = await POST(requestWith({
      baseUrl: "http://127.0.0.1:20128/v1",
      model: "Kelas-berat",
      probeOnly: true,
      probeTools: true,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.probeOnly).toBe(true);
    expect(body.health.status).toBe("healthy");
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("sk_stored");
  });

  it("never sends the stored key to a different endpoint", async () => {
    fsMocks.readFile.mockResolvedValue(`[models]
default = "9router"

[model.9router]
model = "Kelas-berat"
base_url = "http://127.0.0.1:20128/v1"
api_key = "sk_stored_secret"
`);
    global.fetch = vi.fn(async (url, init = {}) => {
      expect(String(url)).toContain("router.example");
      expect(init.headers?.Authorization).toBe("Bearer sk_9router");
      if (String(url).endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "Kelas-berat" }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "pong" } }] }),
        text: async () => "{}",
      };
    });

    const response = await POST(requestWith({
      baseUrl: "https://router.example/v1",
      model: "Kelas-berat",
      probeOnly: true,
      probeTools: true,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.health.status).toBe("healthy");
    expect(JSON.stringify(body)).not.toContain("sk_stored_secret");
  });

  it("probeOnly validates and runs smoke test without writing config", async () => {
    const response = await POST(requestWith({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "Kelas-berat",
      probeOnly: true,
      probeTools: true,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.probeOnly).toBe(true);
    expect(body.health.status).toBe("healthy");
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("normal Apply writes once and returns smoke health", async () => {
    const response = await POST(requestWith({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_test",
      model: "Kelas-berat",
      smoke: true,
      probeTools: true,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.health.status).toBe("healthy");
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
  });
});
