import { redactConsoleLogSecrets } from "@/lib/consoleLogRedact.js";

const MAX_ERROR_TEXT_LENGTH = 240;
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;
const CONTROL_CHARACTERS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function sanitizeErrorText(value) {
  if (value === undefined || value === null) return undefined;
  const sanitized = redactConsoleLogSecrets(String(value))
    .replace(URL_CREDENTIALS_RE, "$1***@")
    .replace(CONTROL_CHARACTERS_RE, " ")
    .trim();
  if (!sanitized) return undefined;
  return sanitized.slice(0, MAX_ERROR_TEXT_LENGTH);
}

function finiteByteCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactError(error) {
  if (!error || typeof error !== "object") return undefined;
  const compact = {
    name: sanitizeErrorText(error.name),
    code: sanitizeErrorText(error.code),
    message: sanitizeErrorText(error.message),
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined));
}

/**
 * Build a persistence-safe transport error summary.
 *
 * Socket addresses, ports, stack traces, request URLs, and arbitrary cause
 * properties are intentionally excluded. Byte counts are useful for telling a
 * pre-first-byte close from a mid-stream reset without exposing endpoints.
 */
export function serializeStreamTransportError(error) {
  const cause = compactError(error?.cause);
  const code = sanitizeErrorText(error?.code ?? error?.cause?.code);
  const bytesRead = finiteByteCount(error?.cause?.socket?.bytesRead);
  const bytesWritten = finiteByteCount(error?.cause?.socket?.bytesWritten);

  const summary = {
    name: sanitizeErrorText(error?.name) || "Error",
    message: sanitizeErrorText(error?.message) || "stream transport error",
    code,
    cause,
    bytesRead,
    bytesWritten,
  };

  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}
