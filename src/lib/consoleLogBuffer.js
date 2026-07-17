import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";
import { redactConsoleLogLines, redactConsoleLogSecrets } from "@/lib/consoleLogRedact.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    revision: 0,
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

if (!state.pendingLines) state.pendingLines = [];
if (!state.flushTimer) state.flushTimer = null;
if (!Number.isSafeInteger(state.revision)) state.revision = 0;

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const EXISTING_TIME_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s*/;
const EXISTING_LEVEL_RE = /^\[(LOG|INFO|WARN|ERROR|DEBUG)\]\s*/i;

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;

  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function defaultFormatTime(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function normalizeLevelTag(level) {
  const raw = String(level || "log").toLowerCase();
  if (raw === "warning") return "WARN";
  if (consoleLevels.includes(raw)) return raw.toUpperCase();
  return "LOG";
}

/**
 * Build a stable UI/console-capture line:
 *   [HH:MM:SS] [LEVEL] message
 *
 * - If the message already has [HH:MM:SS], inject [LEVEL] after it (no double time).
 * - If the message already has [LEVEL], do not double-prefix level.
 *
 * @param {string} level
 * @param {any[]} args
 * @param {{ now?: Date, formatTime?: (d?: Date) => string }} [opts]
 */
export function formatConsoleLogLine(level, args = [], opts = {}) {
  const body = (Array.isArray(args) ? args : [args]).map(formatArg).join(" ").trim();
  const levelTag = normalizeLevelTag(level);
  const formatTime = typeof opts.formatTime === "function" ? opts.formatTime : defaultFormatTime;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const redact = opts.redact === false
    ? (value) => String(value ?? "")
    : redactConsoleLogSecrets;

  let line;
  const timeMatch = body.match(EXISTING_TIME_RE);
  if (timeMatch) {
    const time = timeMatch[1];
    const rest = body.slice(timeMatch[0].length);
    if (EXISTING_LEVEL_RE.test(rest)) {
      // Already [HH:MM:SS] [LEVEL] ...
      line = body;
    } else {
      line = rest ? `[${time}] [${levelTag}] ${rest}` : `[${time}] [${levelTag}]`;
    }
  } else if (EXISTING_LEVEL_RE.test(body)) {
    // Already [LEVEL] ... — only add missing timestamp.
    line = `[${formatTime(now)}] ${body}`;
  } else if (!body) {
    line = `[${formatTime(now)}] [${levelTag}]`;
  } else {
    line = `[${formatTime(now)}] [${levelTag}] ${body}`;
  }

  return redact(line);
}

function appendLine(line) {
  state.logs.push(line);
  state.revision += 1;
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      appendLine(formatConsoleLogLine(level, args));
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  // Defense-in-depth: never hand unredacted history to API/UI consumers.
  return redactConsoleLogLines(state.logs);
}

export function getConsoleLogSnapshot() {
  return { logs: redactConsoleLogLines(state.logs), revision: state.revision };
}

export function clearConsoleLogs() {
  state.logs = [];
  state.pendingLines = [];
  state.revision += 1;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
