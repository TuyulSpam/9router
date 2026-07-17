/**
 * Shared usage helpers (cross-provider)
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { PROVIDERS } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

// usage endpoints: single source from registry transport.usage
export const U = (id) => PROVIDERS[id]?.usage || {};

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export async function parseJsonResponse(response, {
  label = "Usage API",
  maxBodyBytes = DEFAULT_MAX_JSON_BODY_BYTES,
} = {}) {
  const contentType = response.headers?.get?.("content-type") || "unknown content type";

  if (typeof response.arrayBuffer !== "function") {
    try {
      return await response.json();
    } catch {
      throw new Error(label + " returned invalid JSON (" + contentType + ").");
    }
  }

  let body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBodyBytes) {
    throw new Error(label + " response exceeded the size limit.");
  }

  const encoding = response.headers?.get?.("content-encoding")?.toLowerCase() || "";
  try {
    if (encoding.includes("br")) {
      body = brotliDecompressSync(body, { maxOutputLength: maxBodyBytes });
    } else if (encoding.includes("gzip") || (body[0] === 0x1f && body[1] === 0x8b)) {
      body = gunzipSync(body, { maxOutputLength: maxBodyBytes });
    } else if (encoding.includes("deflate")) {
      body = inflateSync(body, { maxOutputLength: maxBodyBytes });
    }

    if (body.length > maxBodyBytes) {
      throw new Error("response exceeded the size limit");
    }
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(label + " returned invalid JSON (" + contentType + ").");
  }
}

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
export function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // Unix timestamps from provider APIs may be seconds or milliseconds.
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }

    // If it's a numeric string, treat it like a Unix timestamp too.
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const timestamp = Number(resetValue);
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

export function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeCloudCodeProjectId(project) {
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object" && typeof project.id === "string") {
    return project.id.trim() || null;
  }
  return null;
}

export async function fetchWithTimeout(url, opts, ms = 10000, proxyOptions = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    return await proxyAwareFetch(url, { ...opts, signal: controller.signal }, proxyOptions);
  } finally {
    clearTimeout(timeoutId);
  }
}
