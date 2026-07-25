import { describe, expect, it } from "vitest";
import {
  emptyPreOutputRetryTelemetry,
  sanitizePreOutputRetryTelemetry,
} from "../../open-sse/utils/retryTelemetry.js";

describe("sanitizePreOutputRetryTelemetry", () => {
  it("keeps only bounded integer pre-output retry counters", () => {
    const sanitized = sanitizePreOutputRetryTelemetry({
      pre_output_retry_attempted: 2,
      pre_output_retry_recovered: 1,
      pre_output_retry_exhausted: 0,
      stack: "TypeError: terminated\n    at ...",
      url: "https://user:secret@example.invalid/v1",
      cause: { code: "UND_ERR_SOCKET", socket: { remoteAddress: "203.0.113.9" } },
      pre_output_retry_attempted_extra: 9,
    });

    expect(sanitized).toEqual({
      pre_output_retry_attempted: 2,
      pre_output_retry_recovered: 1,
      pre_output_retry_exhausted: 0,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/secret|203\.0\.113\.9|TypeError|stack|url/i);
  });

  it("rejects non-integers, negatives, and oversized values", () => {
    expect(sanitizePreOutputRetryTelemetry({
      pre_output_retry_attempted: 1.5,
      pre_output_retry_recovered: -1,
      pre_output_retry_exhausted: 1001,
    })).toBeUndefined();
  });

  it("returns a zeroed counter object from emptyPreOutputRetryTelemetry", () => {
    expect(emptyPreOutputRetryTelemetry()).toEqual({
      pre_output_retry_attempted: 0,
      pre_output_retry_recovered: 0,
      pre_output_retry_exhausted: 0,
    });
  });
});
