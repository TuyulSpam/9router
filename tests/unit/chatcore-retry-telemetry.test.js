import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveRequestDetailMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestDetailMock: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: saveRequestDetailMock,
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore retry telemetry persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists sanitized pre-output retry counters on non-ok provider responses", async () => {
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "upstream body terminated before first user output" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
      url: "https://cli-chat-proxy.grok.com/v1/responses",
      headers: {},
      transformedBody: { model: "grok-4.5" },
      retryTelemetry: {
        pre_output_retry_attempted: 3,
        pre_output_retry_recovered: 0,
        pre_output_retry_exhausted: 1,
        stack: "should never persist",
        url: "https://user:secret@example.invalid",
      },
    });

    await handleChatCore({
      body: { model: "grok-4.5-high", stream: true, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "grok-cli", model: "grok-4.5-high" },
      credentials: { accessToken: "tok", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
      connectionId: "retry-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: {},
        headers: { accept: "text/event-stream" },
      },
    });

    expect(saveRequestDetailMock).toHaveBeenCalled();
    const detail = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detail).toMatchObject({
      provider: "grok-cli",
      model: "grok-4.5-high",
      status: "error",
      response: {
        status: 502,
        pre_output_retry_attempted: 3,
        pre_output_retry_recovered: 0,
        pre_output_retry_exhausted: 1,
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(/secret|should never persist|example\.invalid/i);
  });
});
