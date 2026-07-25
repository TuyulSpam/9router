import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");

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

describe("Codex pre-first-byte transport retry", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once when the SSE body terminates before any bytes", async () => {
    const executor = new CodexExecutor();
    // Force zero delay retries via provider retry config override on the instance.
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
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
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const text = await new Response(result.response.body).text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("ok");
  });

  it("does not infinite-retry when every attempt dies before first byte", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
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
        model: "gpt-5.6-sol",
        body: { model: "gpt-5.6-sol", input: "hi", stream: true },
        stream: true,
        credentials: { accessToken: "tok", connectionId: "c1" },
        log: { debug: vi.fn(), warn },
      });

      // After retries exhaust, expose transport failure as Bad Gateway, not overload.
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("times out the Codex peek while waiting for its first body byte", async () => {
    vi.useFakeTimers();
    const executor = new CodexExecutor();
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

    // Settle the current implementation's pending read during RED; after GREEN
    // the timeout path has already cancelled the body, making this a no-op.
    try { bodyController.error(new Error("test cleanup")); } catch { /* already cancelled */ }
    await peekPromise.catch(() => {});

    expect(peek.sentinel).toBeUndefined();
    expect(peek.transportError?.code).toBe("STREAM_FIRST_CHUNK_TIMEOUT");
    expect(peek.replacementBody).toBeNull();
  });


  it("retries when metadata arrived but the body terminated before user output", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
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
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });


  it("retries metadata-only EOF without a terminal event", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      retry: { 502: { attempts: 1, delayMs: 0 } },
    };

    fetchMock
      .mockResolvedValueOnce(sseResponse([
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_partial","status":"in_progress"}}',
        "",
      ].join("\n")))
      .mockResolvedValueOnce(sseResponse([
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
      ].join("\n")));

    const result = await executor.execute({
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });

  it("retries an empty 200-SSE body instead of returning false success", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
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
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(new Response(result.response.body).text()).resolves.toContain("ok");
  });



  it("times out when only metadata arrives before the first-output deadline", async () => {
    vi.useFakeTimers();
    const executor = new CodexExecutor();
    let metadataController;
    const response = new Response(new ReadableStream({
      start(controller) {
        metadataController = controller;
        controller.enqueue(new TextEncoder().encode([
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"resp_meta","status":"in_progress"}}',
          "",
        ].join("\n")));
        // No further bytes — hang after metadata only.
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
    try { metadataController.error(new Error("test cleanup")); } catch { /* already cancelled */ }
    await peekPromise.catch(() => {});

    expect(peek.sentinel).toBeUndefined();
    expect(peek.transportError?.code).toBe("STREAM_FIRST_CHUNK_TIMEOUT");
    expect(peek.replacementBody).toBeNull();
  });

  it("does not emit unhandledRejection when first-byte timeout cancels the body", async () => {
    vi.useFakeTimers();
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const executor = new CodexExecutor();
      const response = new Response(new ReadableStream({
        start() {
          // never enqueues; first-byte timer should win
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const peekPromise = executor._peekSseTransientError(response);
      await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1);
      const peek = await peekPromise;
      // Allow any late microtasks from cancelled reader.read() to surface.
      await Promise.resolve();
      await Promise.resolve();

      expect(peek.transportError?.code).toBe("STREAM_FIRST_CHUNK_TIMEOUT");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });


  it("does not retry a terminal completed stream with no user output", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    };

    fetchMock.mockResolvedValueOnce(sseResponse([
      "event: response.created",
      'data: {"type":"response.created"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
      "",
    ].join("\n")));

    const result = await executor.execute({
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    const text = await new Response(result.response.body).text();
    expect(text).toContain("response.completed");
  });

  it("does not treat successful first-byte output as a transport retry", async () => {
    const executor = new CodexExecutor();
    executor.config = {
      ...executor.config,
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      retry: { 502: { attempts: 2, delayMs: 0 } },
    };

    fetchMock.mockResolvedValueOnce(sseResponse([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      "",
    ].join("\n")));

    const result = await executor.execute({
      model: "gpt-5.6-sol",
      body: { model: "gpt-5.6-sol", input: "hi", stream: true },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "c1" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    const text = await new Response(result.response.body).text();
    expect(text).toContain("ok");
  });
});
