import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveRequestDetailMock } = vi.hoisted(() => ({
  saveRequestDetailMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: saveRequestDetailMock,
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPassthroughStreamWithLogger: vi.fn((...args) => actual.createPassthroughStreamWithLogger(...args)),
    createSSETransformStreamWithLogger: vi.fn((...args) => actual.createSSETransformStreamWithLogger(...args)),
  };
});

import { serializeStreamTransportError } from "../../open-sse/utils/streamTransportError.js";
import {
  buildOnStreamComplete,
  handleStreamingResponse,
} from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function makeTerminatedError() {
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
    name: "SocketError",
    socket: {
      bytesRead: 0,
      bytesWritten: 1234,
      remoteAddress: "203.0.113.9",
      remotePort: 443,
      localAddress: "10.0.0.8",
      localPort: 54321,
    },
  });
  const error = new TypeError("terminated");
  error.cause = cause;
  return error;
}

describe("serializeStreamTransportError", () => {
  it("keeps transport cause codes without socket endpoints", () => {
    const summary = serializeStreamTransportError(makeTerminatedError());

    expect(summary).toMatchObject({
      name: "TypeError",
      message: "terminated",
      code: "UND_ERR_SOCKET",
      cause: {
        name: "SocketError",
        code: "UND_ERR_SOCKET",
        message: "other side closed",
      },
      bytesRead: 0,
      bytesWritten: 1234,
    });
    expect(JSON.stringify(summary)).not.toContain("203.0.113.9");
    expect(JSON.stringify(summary)).not.toContain("10.0.0.8");
    expect(JSON.stringify(summary)).not.toContain("54321");
  });
});

describe("streaming request detail false-success fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overwrites the streaming placeholder with status=error and transport cause", async () => {
    const requestStartTime = Date.now() - 42990;
    const { onStreamComplete, onStreamError, streamDetailId } = buildOnStreamComplete({
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "17242005-test",
      requestStartTime,
      body: { model: "gpt-5.6-sol", stream: true },
      stream: true,
      translatedBody: { model: "gpt-5.6-sol" },
      finalBody: { model: "gpt-5.6-sol" },
      clientRawRequest: { endpoint: "/v1/responses" },
      pxpipe: { enabled: true },
      reqTag: "t1",
      log: { line: vi.fn(), errorLine: vi.fn() },
    });

    expect(typeof onStreamError).toBe("function");
    expect(streamDetailId).toEqual(expect.any(String));

    onStreamError(makeTerminatedError());
    await Promise.resolve();
    await Promise.resolve();

    expect(saveRequestDetailMock).toHaveBeenCalled();
    const detail = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(detail).toMatchObject({
      id: streamDetailId,
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "17242005-test",
      status: "error",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      response: {
        error: "terminated",
        status: 502,
        type: "stream_error",
      },
    });
    expect(detail.latency?.ttft).toBe(0);
    expect(detail.latency?.total).toBeGreaterThanOrEqual(42990);
    expect(detail.response.cause).toMatchObject({
      name: "SocketError",
      code: "UND_ERR_SOCKET",
      message: "other side closed",
    });
    expect(detail.response.bytesRead).toBe(0);
    expect(detail.response.bytesWritten).toBe(1234);
    expect(JSON.stringify(detail)).not.toContain("203.0.113.9");
    expect(JSON.stringify(detail)).not.toContain("[Streaming in progress...]");
    // complete callback still exists for happy path
    expect(typeof onStreamComplete).toBe("function");
  });

  it("does not let a late transport error overwrite a completed success detail", async () => {
    const { onStreamComplete, onStreamError, streamDetailId } = buildOnStreamComplete({
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "ok-conn",
      requestStartTime: Date.now() - 1000,
      body: { model: "gpt-5.6-sol", stream: true },
      stream: true,
      translatedBody: { model: "gpt-5.6-sol" },
      finalBody: { model: "gpt-5.6-sol" },
      clientRawRequest: { endpoint: "/v1/responses" },
      reqTag: "t2",
      log: { line: vi.fn(), errorLine: vi.fn() },
    });

    onStreamComplete(
      { content: "hello", thinking: null },
      { prompt_tokens: 10, completion_tokens: 4 },
      Date.now() - 500
    );
    await Promise.resolve();
    await Promise.resolve();

    const successCalls = saveRequestDetailMock.mock.calls.length;
    expect(successCalls).toBeGreaterThan(0);
    expect(saveRequestDetailMock.mock.calls.at(-1)[0]).toMatchObject({
      id: streamDetailId,
      status: "success",
    });

    onStreamError(makeTerminatedError());
    await Promise.resolve();
    await Promise.resolve();

    expect(saveRequestDetailMock).toHaveBeenCalledTimes(successCalls);
    expect(saveRequestDetailMock.mock.calls.at(-1)[0].status).toBe("success");
  });

  it("wires streamController.handleError to persist transport failures for the same detail id", async () => {
    const originalHandleError = vi.fn();
    const streamController = {
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: originalHandleError,
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
      signal: new AbortController().signal,
      startTime: Date.now(),
    };

    const requestStartTime = Date.now() - 100;
    const handlers = buildOnStreamComplete({
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "wire-conn",
      requestStartTime,
      body: { model: "gpt-5.6-sol", stream: true },
      stream: true,
      translatedBody: { model: "gpt-5.6-sol" },
      finalBody: { model: "gpt-5.6-sol" },
      clientRawRequest: { endpoint: "/v1/responses" },
      reqTag: "t3",
      log: { line: vi.fn(), errorLine: vi.fn() },
    });

    const providerBody = new ReadableStream({
      start(controller) {
        // Headers already accepted; fail while the body is being read.
        queueMicrotask(() => controller.error(makeTerminatedError()));
      },
    });

    const result = await handleStreamingResponse({
      providerResponse: new Response(providerBody, {
        headers: { "content-type": "text/event-stream" },
      }),
      provider: "codex",
      model: "gpt-5.6-sol",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      userAgent: "openai-node/6.0.0",
      body: { model: "gpt-5.6-sol", stream: true },
      stream: true,
      translatedBody: { model: "gpt-5.6-sol" },
      finalBody: { model: "gpt-5.6-sol" },
      requestStartTime,
      connectionId: "wire-conn",
      clientRawRequest: { endpoint: "/v1/responses" },
      streamController,
      onStreamComplete: handlers.onStreamComplete,
      onStreamError: handlers.onStreamError,
      streamDetailId: handlers.streamDetailId,
      reqTag: "t3",
      log: { line: vi.fn(), errorLine: vi.fn() },
    });

    // Drain the client-facing stream so pipeWithDisconnect surfaces the transport error.
    const reader = result.response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await Promise.resolve();
    await Promise.resolve();

    // First write is the streaming placeholder; final write must be the transport error.
    const writes = saveRequestDetailMock.mock.calls.map((call) => call[0]);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0]).toMatchObject({
      id: handlers.streamDetailId,
      status: "success",
      response: { content: "[Streaming in progress...]" },
    });
    expect(writes.at(-1)).toMatchObject({
      id: handlers.streamDetailId,
      status: "error",
      response: {
        error: "terminated",
        type: "stream_error",
        cause: { code: "UND_ERR_SOCKET" },
      },
    });
    expect(originalHandleError).toHaveBeenCalledTimes(1);
  });
});
