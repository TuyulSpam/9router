import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { GrokCliExecutor } = await import("../../open-sse/executors/grok-cli.js");

function sseResponse(text) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function terminatedBeforeBytesResponse(message = "terminated") {
  return new Response(new ReadableStream({
    start(controller) {
      queueMicrotask(() => {
        const cause = Object.assign(new Error("other side closed"), {
          code: "UND_ERR_SOCKET",
          name: "SocketError",
        });
        const error = new TypeError(message);
        error.cause = cause;
        controller.error(error);
      });
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamThenTerminateResponse(prefix) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      queueMicrotask(() => {
        const cause = Object.assign(new Error("other side closed"), {
          code: "UND_ERR_SOCKET",
          name: "SocketError",
        });
        const error = new TypeError("terminated");
        error.cause = cause;
        controller.error(error);
      });
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function outputThenTerminateResponse(prefix) {
  let emitted = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(new TextEncoder().encode(prefix));
        return;
      }
      const cause = Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
        name: "SocketError",
      });
      const error = new TypeError("terminated");
      error.cause = cause;
      controller.error(error);
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function emptySseResponse() {
  return new Response(new ReadableStream({
    start(controller) {
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Grok CLI pre-first-byte transport retry", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once when the SSE body terminates before any bytes", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    };

    fetchMock
      .mockResolvedValueOnce(terminatedBeforeBytesResponse())
      .mockResolvedValueOnce(sseResponse([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
      ].join("\n")));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.retryTelemetry).toEqual({
      pre_output_retry_attempted: 1,
      pre_output_retry_recovered: 1,
      pre_output_retry_exhausted: 0,
    });
    const text = await new Response(result.response.body).text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("ok");
  });

  it("does not count a retry ending in an HTTP error as recovered", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    fetchMock
      .mockResolvedValueOnce(terminatedBeforeBytesResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "upstream unavailable" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(500);
    expect(result.retryTelemetry).toEqual({
      pre_output_retry_attempted: 1,
      pre_output_retry_recovered: 0,
      pre_output_retry_exhausted: 0,
    });
  });

  it("does not infinite-retry when every attempt dies before first byte", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    const rawTransportMessage = "terminated at https://user:secret@example.invalid/v1";
    const warn = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(terminatedBeforeBytesResponse(rawTransportMessage))
      .mockResolvedValueOnce(terminatedBeforeBytesResponse(rawTransportMessage));

    try {
      const result = await executor.execute({
        model: "grok-4.5-high",
        body: { model: "grok-4.5-high", input: "hi", stream: true },
        stream: true,
        credentials: { accessToken: "tok", connectionId: "c1" },
        log: { debug: vi.fn(), warn },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.retryTelemetry).toEqual({
        pre_output_retry_attempted: 1,
        pre_output_retry_recovered: 0,
        pre_output_retry_exhausted: 1,
      });
      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.error.message).toBe("upstream body terminated before first user output");
      expect(JSON.stringify(body)).not.toMatch(/203\.0\.113\.|UND_ERR_SOCKET|other side closed|user:secret/i);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/user:secret|example\.invalid/i);
      expect(JSON.stringify(consoleLog.mock.calls)).not.toMatch(/user:secret|example\.invalid/i);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("retries when metadata arrived but the body terminated before user output", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    fetchMock
      .mockResolvedValueOnce(streamThenTerminateResponse([
        "event: response.created",
        'data: {"type":"response.created"}',
        "",
      ].join("\n")))
      .mockResolvedValueOnce(sseResponse([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
      ].join("\n")));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });

  it("retries when only reasoning arrived before the body terminated", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    // Reasoning summary is not user-visible output for retry purposes. If the
    // socket dies after reasoning-only bytes, allow one pre-output transport retry.
    fetchMock
      .mockResolvedValueOnce(streamThenTerminateResponse([
        "event: response.reasoning_summary_text.delta",
        'data: {"type":"response.reasoning_summary_text.delta","delta":"still thinking"}',
        "",
      ].join("\n")))
      .mockResolvedValueOnce(sseResponse([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
      ].join("\n")));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });

  it("passes through a healthy reasoning-only stream after the bounded peek limit", async () => {
    const executor = new GrokCliExecutor();
    const reasoningText = "r".repeat(300 * 1024);
    const response = sseResponse([
      "event: response.reasoning_summary_text.delta",
      `data: {"type":"response.reasoning_summary_text.delta","delta":"${reasoningText}"}`,
      "",
    ].join("\n"));

    const peek = await executor._peekSseTransientError(response);

    expect(peek.matched).toBeNull();
    expect(peek.transportError).toBeNull();
    expect(peek.replacementBody).toBeInstanceOf(ReadableStream);
    await expect(new Response(peek.replacementBody).text()).resolves.toContain(reasoningText.slice(0, 128));
  });

  it("retries an empty 200-SSE body instead of returning false success", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    fetchMock
      .mockResolvedValueOnce(emptySseResponse())
      .mockResolvedValueOnce(sseResponse([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
      ].join("\n")));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });

  it("times out the Grok peek while waiting for its first body byte", async () => {
    vi.useFakeTimers();
    const executor = new GrokCliExecutor();
    let bodyController;
    const response = new Response(new ReadableStream({
      start(controller) {
        bodyController = controller;
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const peekPromise = executor._peekSseTransientError(response);
    const racedPromise = Promise.race([
      peekPromise,
      new Promise(resolve => setTimeout(() => resolve({ sentinel: "still-pending" }), STREAM_FIRST_CHUNK_TIMEOUT_MS + 1)),
    ]);
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1);
    const peek = await racedPromise;
    try { bodyController.error(new Error("test cleanup")); } catch { /* already cancelled */ }
    await peekPromise.catch(() => {});

    expect(peek.sentinel).toBeUndefined();
    expect(peek.transportError?.code).toBe("STREAM_FIRST_CHUNK_TIMEOUT");
    expect(peek.replacementBody).toBeNull();
  });

  it("does not retry after user-visible output has already started", async () => {
    const executor = new GrokCliExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    };

    // Once user-visible deltas already left the body, fail-fast instead of
    // replaying them on a second attempt.
    fetchMock.mockResolvedValueOnce(outputThenTerminateResponse([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      "",
    ].join("\n")));

    const result = await executor.execute({
      model: "grok-4.5-high",
      body: { model: "grok-4.5-high", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    await expect(new Response(result.response.body).text()).rejects.toThrow(/terminated/i);
  });
});
