/**
 * Redact likely secrets from console log text before it is buffered or shown
 * in the dashboard Console Log UI.
 *
 * Intentionally conservative: prefer false positives over leaking keys.
 * Local placeholder `sk_9router` is preserved (short, non-secret default).
 * Safe to run multiple times (idempotent for already-redacted markers).
 */

export const CONSOLE_LOG_REDACTED = "***";

/**
 * @param {unknown} input
 * @returns {string}
 */
export function redactConsoleLogSecrets(input) {
  let s = String(input ?? "");
  if (!s) return s;

  // Bearer <token> (standalone or after Authorization:)
  s = s.replace(/(Bearer\s+)(?!\*{3}\b)[A-Za-z0-9._\-+/=]{8,}/gi, `$1${CONSOLE_LOG_REDACTED}`);
  // Authorization: <raw-token> when scheme is not Bearer
  s = s.replace(
    /(Authorization\s*[:=]\s*)(?!Bearer\b)(?!\*{3}\b)(\S{8,})/gi,
    `$1${CONSOLE_LOG_REDACTED}`
  );

  // OpenAI-style sk-... and dashboard-style sk_... (keep sk_9router)
  s = s.replace(/\bsk-(?!\*{3}\b)[A-Za-z0-9_\-]{16,}\b/g, `sk-${CONSOLE_LOG_REDACTED}`);
  s = s.replace(/\bsk_(?!9router\b)(?!\*{3}\b)[A-Za-z0-9_\-]{12,}\b/g, `sk_${CONSOLE_LOG_REDACTED}`);

  // JWT-looking triples
  s = s.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    CONSOLE_LOG_REDACTED
  );

  // JSON-style "apiKey":"value"
  s = s.replace(
    /("(?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|token|authorization)"\s*:\s*")(?!\*{3}")([^"]{4,})(")/gi,
    `$1${CONSOLE_LOG_REDACTED}$3`
  );

  // Common key/value secret fields (env, query, assignment)
  s = s.replace(
    /((?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|token|anthropic_auth_token|x-api-key)\s*[:=]\s*["']?)(?!\*{3}\b)([^"'\s,;&]{6,})/gi,
    `$1${CONSOLE_LOG_REDACTED}`
  );

  // Header style: x-api-key: value / x-9r-cli-token: value
  s = s.replace(
    /((?:x-api-key|x-9r-cli-token|x-goog-api-key)\s*[:=]\s*)(?!\*{3}\b)(\S+)/gi,
    `$1${CONSOLE_LOG_REDACTED}`
  );

  return s;
}

/**
 * Redact an array of log lines for API/export surfaces.
 * @param {unknown} lines
 * @returns {string[]}
 */
export function redactConsoleLogLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => redactConsoleLogSecrets(line));
}
