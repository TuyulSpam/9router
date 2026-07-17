// Pure helpers for Console Log UI polish (client-side only).
// Keep free of React so unit tests can exercise parsing/filter without DOM.

import { redactConsoleLogSecrets } from "@/lib/consoleLogRedact.js";

const TIME_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s*/;
const LEVEL_RE = /^\[(LOG|INFO|WARN|ERROR|DEBUG)\]\s*/i;
const TAG_RE = /^\[([A-Z][A-Z0-9_./-]{1,32})\]\s*/;
const BRACKET_TAG_RE = /\[([A-Z][A-Z0-9_./-]{1,32})\]/g;

const LEVEL_TO_SEVERITY = {
  LOG: "log",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  DEBUG: "debug",
};

const SEVERITY_META = {
  error: { label: "ERROR", className: "text-red-400", badge: "bg-red-500/15 text-red-400" },
  warn: { label: "WARN", className: "text-yellow-400", badge: "bg-yellow-500/15 text-yellow-400" },
  info: { label: "INFO", className: "text-blue-400", badge: "bg-blue-500/15 text-blue-400" },
  ok: { label: "OK", className: "text-emerald-400", badge: "bg-emerald-500/15 text-emerald-400" },
  req: { label: "REQ", className: "text-cyan-400", badge: "bg-cyan-500/15 text-cyan-400" },
  debug: { label: "DEBUG", className: "text-purple-400", badge: "bg-purple-500/15 text-purple-400" },
  log: { label: "LOG", className: "text-green-400/90", badge: "bg-green-500/10 text-green-400" },
};

export const CONSOLE_LOG_TAG_FILTERS = Object.freeze([
  { id: "COMBO", label: "COMBO" },
  { id: "PROXY", label: "PROXY" },
  { id: "HEADROOM", label: "HEADROOM" },
  { id: "RTK", label: "RTK" },
  { id: "CHAT", label: "CHAT" },
]);

/**
 * Content/emoji heuristics used when no explicit [LEVEL] is present,
 * or to refine LOG/INFO lines into request lifecycle severities.
 */
export function inferConsoleLogSeverity(text, { allowLifecycleRefine = true } = {}) {
  const s = String(text || "");

  // Prefer structured prefix: [HH:MM:SS] [LEVEL] or leading [LEVEL]
  const structured = s.match(/^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?\[(LOG|INFO|WARN|ERROR|DEBUG)\]/i);
  if (structured) {
    const base = LEVEL_TO_SEVERITY[structured[1].toUpperCase()] || "log";
    if (base === "error" || base === "warn" || base === "debug") return base;
    if (allowLifecycleRefine) {
      if (/📊|DONE\b|succeeded|success/i.test(s)) return "ok";
      if (/[▶►]/.test(s) && /→|->/.test(s)) return "req";
      if (/⚠️|⚠/i.test(s)) return "warn";
      if (/❌|✖/i.test(s)) return "error";
    }
    return base;
  }

  if (/❌|✖|\bERROR\b|\bFATAL\b/i.test(s)) return "error";
  if (/⚠️|⚠|\bWARN(?:ING)?\b/i.test(s)) return "warn";
  if (/📊|DONE\b|succeeded|success/i.test(s)) return "ok";
  if (/[▶►]/.test(s) && /→|->/.test(s)) return "req";
  if (/🟢|🔵|⚙|ℹ️|ℹ|\[COMBO\]|\[PROXY\]|\[CHAT\]|\[HEADROOM\]|\[RTK\]/i.test(s)) {
    return "info";
  }
  if (/\bDEBUG\b/i.test(s)) return "debug";
  return "log";
}

/**
 * Parse one raw console line into columns for a tidy terminal view.
 * Supports both legacy plain lines and Option B `[HH:MM:SS] [LEVEL] ...` lines.
 * Applies client-side redaction so older buffered lines are still safe to show.
 */
export function parseConsoleLogLine(line) {
  const raw = redactConsoleLogSecrets(String(line ?? ""));
  let rest = raw;
  let time = null;
  let level = null;
  let tag = null;

  const timeMatch = rest.match(TIME_RE);
  if (timeMatch) {
    time = timeMatch[1];
    rest = rest.slice(timeMatch[0].length);
  }

  const levelMatch = rest.match(LEVEL_RE);
  if (levelMatch) {
    level = levelMatch[1].toUpperCase();
    rest = rest.slice(levelMatch[0].length);
  }

  // Strip leading emoji / decorative markers used by 9Router request logger
  rest = rest.replace(/^(?:[⚠️⚠❌✖ℹ️ℹ🟢🔵📊⚙▶►·\s]+)+/u, "").trimStart();

  // RTK lines often look like "⚙ RTK −20124B" without [RTK] brackets
  if (/^RTK\b/i.test(rest) && !TAG_RE.test(rest)) {
    tag = "RTK";
  }

  const tagMatch = rest.match(TAG_RE);
  if (tagMatch) {
    const candidate = tagMatch[1].toUpperCase();
    if (!LEVEL_TO_SEVERITY[candidate]) {
      tag = tagMatch[1];
      rest = rest.slice(tagMatch[0].length);
    }
  }

  const severity = inferConsoleLogSeverity(raw);
  const message = rest.trim() || raw;
  const meta = SEVERITY_META[severity] || SEVERITY_META.log;

  return {
    raw,
    time,
    level,
    severity,
    tag,
    message,
    meta,
  };
}

/**
 * True when a line belongs to one of the selected subsystem tags.
 * Only matches explicit `[TAG]` / parsed tag / leading `RTK` — never bare substrings.
 */
export function consoleLogLineMatchesTags(lineOrParsed, tags) {
  const tagSet = Array.isArray(tags) && tags.length > 0
    ? new Set(tags.map((t) => String(t).toUpperCase()))
    : null;
  if (!tagSet) return true;

  const parsed = typeof lineOrParsed === "string"
    ? parseConsoleLogLine(lineOrParsed)
    : lineOrParsed;

  const lineTag = (parsed?.tag || "").toUpperCase();
  if (lineTag && tagSet.has(lineTag)) return true;

  // Explicit bracket tags elsewhere in the line (rare, but safe).
  // Never match bare substrings like free-text "headroom".
  const raw = String(parsed?.raw || lineOrParsed || "");
  BRACKET_TAG_RE.lastIndex = 0;
  let m;
  while ((m = BRACKET_TAG_RE.exec(raw)) !== null) {
    const candidate = m[1].toUpperCase();
    if (LEVEL_TO_SEVERITY[candidate]) continue;
    if (tagSet.has(candidate)) return true;
  }

  return false;
}

/**
 * Filter parsed/raw lines by free-text query, severity, and subsystem tags.
 * @param {string[]} lines
 * @param {{ query?: string, severities?: string[]|null, tags?: string[]|null }} opts
 * @returns {string[]}
 */
export function filterConsoleLogLines(lines, { query = "", severities = null, tags = null } = {}) {
  return prepareConsoleLogRows(lines, { query, severities, tags }).map((row) => row.raw);
}

/**
 * Parse + filter once for render (avoids double parse in row components).
 * @returns {{ raw: string, time: string|null, level: string|null, severity: string, tag: string|null, message: string, meta: object }[]}
 */
export function prepareConsoleLogRows(lines, { query = "", severities = null, tags = null } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const q = String(query || "").trim().toLowerCase();
  const sevSet = Array.isArray(severities) && severities.length > 0
    ? new Set(severities)
    : null;
  const hasTags = Array.isArray(tags) && tags.length > 0;

  if (!q && !sevSet && !hasTags) {
    return list.map((line) => parseConsoleLogLine(line));
  }

  const out = [];
  for (const line of list) {
    const parsed = parseConsoleLogLine(line);
    if (sevSet && !sevSet.has(parsed.severity)) continue;
    if (hasTags && !consoleLogLineMatchesTags(parsed, tags)) continue;
    if (q) {
      const hay = `${parsed.raw} ${parsed.tag || ""} ${parsed.message} ${parsed.level || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Build export/copy text with redaction. Optionally only visible/filtered rows.
 * @param {string[]} lines
 * @param {{ query?: string, severities?: string[]|null, tags?: string[]|null, filtered?: boolean }} opts
 */
export function buildConsoleLogExportText(lines, opts = {}) {
  const { filtered = false, query = "", severities = null, tags = null } = opts;
  const source = filtered
    ? filterConsoleLogLines(lines, { query, severities, tags })
    : (Array.isArray(lines) ? lines : []);
  return source.map((line) => redactConsoleLogSecrets(line)).join("\n");
}

/**
 * Split text into plain/highlight segments for search hit rendering.
 * @returns {{ text: string, hit: boolean }[]}
 */
export function splitConsoleLogHighlights(text, query) {
  const value = String(text ?? "");
  const q = String(query || "").trim();
  if (!q || !value) return [{ text: value, hit: false }];

  const lower = value.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let cursor = 0;

  while (cursor < value.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) {
      parts.push({ text: value.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: value.slice(cursor, idx), hit: false });
    }
    parts.push({ text: value.slice(idx, idx + q.length), hit: true });
    cursor = idx + q.length;
  }

  return parts.length ? parts : [{ text: value, hit: false }];
}

export function getConsoleLogSeverityMeta(severity) {
  return SEVERITY_META[severity] || SEVERITY_META.log;
}

export const CONSOLE_LOG_SEVERITY_FILTERS = Object.freeze([
  { id: "all", label: "All", severities: null },
  { id: "issues", label: "Issues", severities: ["error", "warn"] },
  { id: "req", label: "Requests", severities: ["req", "ok"] },
  { id: "info", label: "Info", severities: ["info", "log", "debug"] },
]);
