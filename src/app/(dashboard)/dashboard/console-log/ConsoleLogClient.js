"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { startConsoleLogTransport } from "./transport";
import {
  prepareConsoleLogRows,
  buildConsoleLogExportText,
  splitConsoleLogHighlights,
  CONSOLE_LOG_SEVERITY_FILTERS,
  CONSOLE_LOG_TAG_FILTERS,
} from "./consoleLogView";

function HighlightedText({ text, query, className }) {
  const parts = splitConsoleLogHighlights(text, query);
  return (
    <span className={className}>
      {parts.map((part, i) => (
        part.hit ? (
          <mark
            key={i}
            className="rounded-sm bg-yellow-300/40 px-0.5 text-inherit dark:bg-yellow-300/25"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      ))}
    </span>
  );
}

function LogLineRow({ row, wrap, query }) {
  const wrapCls = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto";

  return (
    <div
      className={`grid grid-cols-[4.5rem_3.25rem_minmax(0,1fr)] gap-x-2 items-start leading-5 ${wrapCls}`}
    >
      <span className="text-zinc-500 tabular-nums shrink-0">
        {row.time || "—"}
      </span>
      <span
        className={`shrink-0 text-[10px] font-semibold tracking-wide ${row.meta.className}`}
        title={row.severity}
      >
        {row.meta.label}
      </span>
      <div className="min-w-0">
        {row.tag ? (
          <span
            className={`mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] font-semibold tracking-wide ${row.meta.badge}`}
          >
            {row.tag}
          </span>
        ) : null}
        <HighlightedText
          text={row.message}
          query={query}
          className={row.meta.className}
        />
      </div>
    </div>
  );
}

function exportFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `9router-console-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [query, setQuery] = useState("");
  const [filterId, setFilterId] = useState("all");
  const [activeTags, setActiveTags] = useState([]);
  const [wrap, setWrap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState(true);

  const logRef = useRef(null);
  const transportRef = useRef(null);
  const pausedRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const logsRef = useRef([]);
  const pendingWhilePausedRef = useRef([]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  const applyIncoming = useCallback((updater) => {
    const resolve = (base) => (typeof updater === "function" ? updater(base) : updater);

    if (pausedRef.current) {
      const base = pendingWhilePausedRef.current.length
        ? pendingWhilePausedRef.current
        : logsRef.current;
      const next = resolve(base);
      pendingWhilePausedRef.current = Array.isArray(next) ? next : [];
      return;
    }

    pendingWhilePausedRef.current = [];
    setLogs((prev) => {
      const next = resolve(prev);
      return Array.isArray(next) ? next : prev;
    });
  }, []);

  const sourceLines = useCallback(() => (
    pendingWhilePausedRef.current.length ? pendingWhilePausedRef.current : logs
  ), [logs]);

  const activeFilter = CONSOLE_LOG_SEVERITY_FILTERS.find((f) => f.id === filterId)
    || CONSOLE_LOG_SEVERITY_FILTERS[0];

  const filtersActive = Boolean(
    query.trim() || filterId !== "all" || activeTags.length > 0
  );

  const filterOpts = useMemo(() => ({
    query,
    severities: activeFilter.severities,
    tags: activeTags,
  }), [query, activeFilter, activeTags]);

  const visibleRows = useMemo(
    () => prepareConsoleLogRows(logs, filterOpts),
    [logs, filterOpts]
  );

  const issueCount = useMemo(
    () => prepareConsoleLogRows(logs, { severities: ["error", "warn"] }).length,
    [logs]
  );

  const handleClear = async () => {
    try {
      const response = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      transportRef.current?.invalidate();
      pendingWhilePausedRef.current = [];
      setLogs([]);
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  const handleCopy = async () => {
    try {
      const text = buildConsoleLogExportText(sourceLines(), {
        ...filterOpts,
        filtered: filtersActive,
      });
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy console logs:", err);
    }
  };

  const handleDownload = () => {
    const text = buildConsoleLogExportText(sourceLines(), {
      ...filterOpts,
      filtered: filtersActive,
    });
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleResume = () => {
    const buffered = pendingWhilePausedRef.current;
    if (buffered.length) {
      const next = buffered.slice(-CONSOLE_LOG_CONFIG.maxLines);
      logsRef.current = next;
      setLogs(next);
      pendingWhilePausedRef.current = [];
    }
    setPaused(false);
    stickToBottomRef.current = true;
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
  };

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    stickToBottomRef.current = atBottom;
    if (!atBottom && !pausedRef.current) {
      // Leave the viewport frozen so the user can read history.
      setPaused(true);
      return;
    }
    // Scrolling back to the tail resumes live follow (DevTools-like).
    if (atBottom && pausedRef.current) {
      handleResume();
    }
  };

  const toggleTag = (tagId) => {
    setActiveTags((prev) => (
      prev.includes(tagId)
        ? prev.filter((t) => t !== tagId)
        : [...prev, tagId]
    ));
  };

  useEffect(() => {
    transportRef.current = startConsoleLogTransport({
      onSnapshot: (nextLogs) => {
        setLive(true);
        applyIncoming(nextLogs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      },
      onEvent: (msg) => {
        setLive(true);
        if (msg.type === "init") {
          applyIncoming(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
        } else if (msg.type === "line") {
          applyIncoming((prev) => {
            const next = [...prev, msg.line];
            return next.length > CONSOLE_LOG_CONFIG.maxLines
              ? next.slice(-CONSOLE_LOG_CONFIG.maxLines)
              : next;
          });
        } else if (msg.type === "lines") {
          applyIncoming((prev) => {
            const next = [...prev, ...msg.lines];
            return next.length > CONSOLE_LOG_CONFIG.maxLines
              ? next.slice(-CONSOLE_LOG_CONFIG.maxLines)
              : next;
          });
        } else if (msg.type === "clear") {
          pendingWhilePausedRef.current = [];
          setLogs([]);
        }
      },
    });

    return () => {
      transportRef.current?.stop();
      transportRef.current = null;
    };
  }, [applyIncoming]);

  useEffect(() => {
    if (paused || !stickToBottomRef.current || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, paused, visibleRows.length]);

  const clearFilters = () => {
    setQuery("");
    setFilterId("all");
    setActiveTags([]);
  };

  return (
    <div className="flex flex-col gap-3">
      <Card padding="none" className="overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                paused
                  ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
                  : live
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-surface-2 text-text-muted"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  paused ? "bg-yellow-500" : live ? "bg-emerald-500 animate-pulse" : "bg-zinc-400"
                }`}
              />
              {paused ? "Paused" : live ? "Live" : "Idle"}
            </span>
            <span className="text-xs text-text-muted tabular-nums">
              {visibleRows.length === logs.length
                ? `${logs.length} lines`
                : `${visibleRows.length}/${logs.length} lines`}
              {issueCount > 0 ? ` · ${issueCount} issues` : ""}
              {filtersActive ? " · filtered export" : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search logs…"
              className="h-7 w-full min-w-[10rem] rounded-[8px] border border-border bg-surface px-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50 sm:w-48"
            />
            <Button
              size="sm"
              variant={wrap ? "secondary" : "outline"}
              icon="wrap_text"
              onClick={() => setWrap((v) => !v)}
              title={wrap ? "Disable wrap" : "Enable wrap"}
            >
              Wrap
            </Button>
            {paused ? (
              <Button size="sm" variant="secondary" icon="play_arrow" onClick={handleResume}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="outline" icon="pause" onClick={() => setPaused(true)}>
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              icon={copied ? "check" : "content_copy"}
              onClick={handleCopy}
              disabled={logs.length === 0}
              title={filtersActive ? "Copy filtered lines (redacted)" : "Copy all lines (redacted)"}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon="download"
              onClick={handleDownload}
              disabled={logs.length === 0}
              title={filtersActive ? "Download filtered lines (redacted)" : "Download all lines (redacted)"}
            >
              Download
            </Button>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
              Clear
            </Button>
          </div>
        </div>

        {/* Severity + tag chips */}
        <div className="flex flex-col gap-2 border-b border-border/70 bg-surface/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              Level
            </span>
            {CONSOLE_LOG_SEVERITY_FILTERS.map((f) => {
              const active = f.id === filterId;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilterId(f.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-primary/15 text-primary"
                      : "bg-surface-2 text-text-muted hover:text-text-main"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              Tag
            </span>
            {CONSOLE_LOG_TAG_FILTERS.map((f) => {
              const active = activeTags.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleTag(f.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400"
                      : "bg-surface-2 text-text-muted hover:text-text-main"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="ml-1 text-[11px] text-primary hover:underline"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>

        {/* Log body */}
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="bg-zinc-950 p-3 text-[11px] font-mono h-[calc(100vh-300px)] min-h-[320px] overflow-auto"
        >
          {logs.length === 0 ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 text-center text-zinc-500">
              <span className="material-symbols-outlined text-[28px] opacity-60">terminal</span>
              <span>No console logs yet.</span>
              <span className="text-[10px] opacity-70">Server output will stream here live.</span>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 text-center text-zinc-500">
              <span className="material-symbols-outlined text-[28px] opacity-60">filter_alt_off</span>
              <span>No lines match the current filter.</span>
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {visibleRows.map((row, i) => (
                <LogLineRow
                  key={`${row.time || ""}-${row.severity}-${i}-${row.message.slice(0, 32)}`}
                  row={row}
                  wrap={wrap}
                  query={query}
                />
              ))}
            </div>
          )}
        </div>

        {paused && (
          <div className="flex items-center justify-between gap-2 border-t border-yellow-500/20 bg-yellow-500/10 px-3 py-1.5 text-[11px] text-yellow-700 dark:text-yellow-300">
            <span>Follow paused — scroll to bottom or resume to catch up.</span>
            <button
              type="button"
              onClick={handleResume}
              className="font-semibold hover:underline"
            >
              Jump to latest
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
