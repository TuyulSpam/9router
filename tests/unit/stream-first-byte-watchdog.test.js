import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

function makeController() {
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
    handleDisconnect: vi.fn(),
    abort: vi.fn(),
  };
}

function identityTransform() {
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
}

describe("pipeWithDisconnect first-byte watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a first-chunk timeout shorter than inter-chunk stall", () => {
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBeLessThan(STREAM_STALL_TIMEOUT_MS);
  });

  it("aborts with first-byte timeout when no upstream bytes arrive", async () => {
    vi.useFakeTimers();
    const streamController = makeController();
    const neverBody = new ReadableStream({
      start() {
        // intentionally never enqueues
      },
    });

    const out = pipeWithDisconnect(
      new Response(neverBody, { headers: { "content-type": "text/event-stream" } }),
      identityTransform(),
      streamController
    );

    const reader = out.getReader();
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS);

    expect(streamController.handleError).toHaveBeenCalledTimes(1);
    const err = streamController.handleError.mock.calls[0][0];
    expect(String(err.message)).toMatch(/first[- ]byte|first[- ]chunk/i);
    expect(err.code).toBe("STREAM_FIRST_CHUNK_TIMEOUT");
    expect(streamController.abort).toHaveBeenCalled();
    await reader.cancel();
  });


  it("uses the shorter provider stall deadline before the first chunk", async () => {
    vi.useFakeTimers();
    const streamController = makeController();
    const providerStallMs = 120_000;
    const neverBody = new ReadableStream({
      start() {
        // intentionally never enqueues
      },
    });

    const out = pipeWithDisconnect(
      new Response(neverBody, { headers: { "content-type": "text/event-stream" } }),
      identityTransform(),
      streamController,
      null,
      providerStallMs,
      STREAM_FIRST_CHUNK_TIMEOUT_MS,
    );

    const reader = out.getReader();
    await vi.advanceTimersByTimeAsync(providerStallMs);

    expect(streamController.handleError).toHaveBeenCalledTimes(1);
    expect(streamController.abort).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it("does not first-byte-timeout after the first upstream chunk arrives", async () => {
    vi.useFakeTimers();
    const streamController = makeController();
    let upstreamController;
    const body = new ReadableStream({
      start(controller) {
        upstreamController = controller;
      },
    });

    const out = pipeWithDisconnect(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      identityTransform(),
      streamController
    );

    const reader = out.getReader();
    // Deliver first byte before first-chunk deadline.
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS - 1_000);
    upstreamController.enqueue(new TextEncoder().encode("data: hi\n\n"));
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Past first-chunk window, but under stall window — should stay alive.
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS);
    expect(streamController.handleError).not.toHaveBeenCalled();

    upstreamController.close();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});
