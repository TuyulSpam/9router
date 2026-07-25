const PRE_OUTPUT_RETRY_KEYS = [
  "pre_output_retry_attempted",
  "pre_output_retry_recovered",
  "pre_output_retry_exhausted",
];

export function emptyPreOutputRetryTelemetry() {
  return {
    pre_output_retry_attempted: 0,
    pre_output_retry_recovered: 0,
    pre_output_retry_exhausted: 0,
  };
}

/**
 * Persist only bounded integer counters. Reject non-integers, negatives,
 * oversized values, and any unknown keys (no free-form cause/url/stack).
 */
export function sanitizePreOutputRetryTelemetry(value) {
  if (!value || typeof value !== "object") return undefined;
  const out = {};
  for (const key of PRE_OUTPUT_RETRY_KEYS) {
    const n = value[key];
    if (Number.isInteger(n) && n >= 0 && n <= 1000) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}
