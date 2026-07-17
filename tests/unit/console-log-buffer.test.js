import { describe, expect, it } from "vitest";
import { formatConsoleLogLine } from "../../src/lib/consoleLogBuffer.js";

describe("formatConsoleLogLine", () => {
  it("prefixes time and level for plain messages", () => {
    const line = formatConsoleLogLine("warn", ["tunnel stale"], {
      now: new Date("2026-07-16T03:30:05Z"),
      // force fixed clock formatting via injected formatter
      formatTime: () => "03:30:05",
    });
    expect(line).toBe("[03:30:05] [WARN] tunnel stale");
  });

  it("injects level after an existing [HH:MM:SS] prefix", () => {
    const line = formatConsoleLogLine("info", [
      "[03:26:30] ℹ️  [PROXY] GROK-CLI | grok-4.5-high",
    ]);
    expect(line).toBe("[03:26:30] [INFO] ℹ️  [PROXY] GROK-CLI | grok-4.5-high");
  });

  it("does not double-prefix an explicit level tag", () => {
    expect(formatConsoleLogLine("error", ["[ERROR] already tagged"], {
      formatTime: () => "01:02:03",
    })).toBe("[01:02:03] [ERROR] already tagged");

    expect(formatConsoleLogLine("warn", [
      "[03:26:30] [WARN] already leveled",
    ])).toBe("[03:26:30] [WARN] already leveled");
  });

  it("formats Error objects and strips ANSI", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at x";
    const line = formatConsoleLogLine("error", ["failed", err], {
      formatTime: () => "10:00:00",
    });
    expect(line.startsWith("[10:00:00] [ERROR] failed Error: boom")).toBe(true);
    expect(line).not.toMatch(/\x1b\[/);
  });

  it("uppercases console level names", () => {
    expect(formatConsoleLogLine("debug", ["x"], { formatTime: () => "00:00:01" }))
      .toBe("[00:00:01] [DEBUG] x");
    expect(formatConsoleLogLine("log", ["x"], { formatTime: () => "00:00:01" }))
      .toBe("[00:00:01] [LOG] x");
  });
});
