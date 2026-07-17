import { describe, expect, it } from "vitest";
import {
  parseConsoleLogLine,
  inferConsoleLogSeverity,
  filterConsoleLogLines,
  prepareConsoleLogRows,
  buildConsoleLogExportText,
  consoleLogLineMatchesTags,
  splitConsoleLogHighlights,
} from "../../src/app/(dashboard)/dashboard/console-log/consoleLogView.js";

describe("inferConsoleLogSeverity", () => {
  it("maps emoji and lifecycle markers", () => {
    expect(inferConsoleLogSeverity("[03:26:30] ⚠️  [HEADROOM] skipped")).toBe("warn");
    expect(inferConsoleLogSeverity("[03:26:30] ❌ boom")).toBe("error");
    expect(inferConsoleLogSeverity("[03:26:47] 🔵 📊 DONE 17687ms")).toBe("ok");
    expect(
      inferConsoleLogSeverity(
        "[03:26:30] 🔵 ▶ POST Kelas-berat → grok-cli/grok-4.5-high · STREAM"
      )
    ).toBe("req");
    expect(inferConsoleLogSeverity("[03:26:48] ℹ️  [COMBO] Trying model 1/2")).toBe("info");
  });

  it("honors explicit buffer level tags and refines soft levels", () => {
    expect(inferConsoleLogSeverity("[03:26:30] [WARN] plain warning")).toBe("warn");
    expect(inferConsoleLogSeverity("[03:26:30] [ERROR] plain error")).toBe("error");
    expect(inferConsoleLogSeverity("[03:26:30] [DEBUG] detail")).toBe("debug");
    expect(
      inferConsoleLogSeverity(
        "[03:26:30] [LOG] 🔵 ▶ POST Kelas-berat → gcli/x · STREAM"
      )
    ).toBe("req");
    expect(
      inferConsoleLogSeverity("[03:26:47] [INFO] 🔵 📊 DONE 17687ms")
    ).toBe("ok");
  });
});

describe("parseConsoleLogLine", () => {
  it("extracts time, tag, and message from structured request logs", () => {
    const parsed = parseConsoleLogLine(
      "[03:26:30] ℹ️  [PROXY] GROK-CLI | grok-4.5-high | conn=Premiumisme"
    );
    expect(parsed.time).toBe("03:26:30");
    expect(parsed.tag).toBe("PROXY");
    expect(parsed.severity).toBe("info");
    expect(parsed.message).toContain("GROK-CLI");
    expect(parsed.meta.label).toBe("INFO");
  });

  it("parses Option B level-prefixed lines", () => {
    const parsed = parseConsoleLogLine(
      "[03:26:30] [INFO] ℹ️  [PROXY] GROK-CLI | grok-4.5-high"
    );
    expect(parsed.time).toBe("03:26:30");
    expect(parsed.level).toBe("INFO");
    expect(parsed.tag).toBe("PROXY");
    expect(parsed.severity).toBe("info");
    expect(parsed.message).toContain("GROK-CLI");
  });

  it("handles request start lines without subsystem tag", () => {
    const parsed = parseConsoleLogLine(
      "[03:26:48] 🟢 ▶ POST Kelas-berat → codex/gpt-5.6-sol · STREAM · 90 MSG"
    );
    expect(parsed.time).toBe("03:26:48");
    expect(parsed.tag).toBeNull();
    expect(parsed.severity).toBe("req");
    expect(parsed.message).toMatch(/POST Kelas-berat/);
  });

  it("tags RTK lines without brackets", () => {
    const parsed = parseConsoleLogLine("[03:26:30] [LOG] 🔵 ⚙ RTK −20124B(15%)");
    expect(parsed.tag).toBe("RTK");
    expect(parsed.message).toMatch(/RTK/);
  });

  it("keeps plain lines usable", () => {
    const parsed = parseConsoleLogLine("hello world");
    expect(parsed.time).toBeNull();
    expect(parsed.tag).toBeNull();
    expect(parsed.message).toBe("hello world");
    expect(parsed.severity).toBe("log");
  });

  it("redacts secrets while parsing for display", () => {
    const parsed = parseConsoleLogLine(
      "[12:00:00] [INFO] Authorization: Bearer sk-live-abcdefghijklmnop"
    );
    expect(parsed.message).toContain("Bearer ***");
    expect(parsed.raw).not.toContain("sk-live");
  });
});

describe("filterConsoleLogLines / tags", () => {
  const lines = [
    "[03:26:30] [WARN] ⚠️  [HEADROOM] skipped: not safe",
    "[03:26:30] [INFO] ℹ️  [COMBO] Trying model 1/2: cx/gpt-5.6-sol",
    "[03:26:47] [LOG] 🔵 📊 DONE 17687ms · TTFT 1510ms",
    "[03:26:48] [LOG] 🟢 ▶ POST Kelas-berat → codex/gpt-5.6-sol · STREAM",
    "[03:26:49] [INFO] talking about headroom conceptually",
  ];

  it("filters by free-text query", () => {
    const out = filterConsoleLogLines(lines, { query: "headroom" });
    // query still matches free text + tagged line
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by severity set", () => {
    const issues = filterConsoleLogLines(lines, { severities: ["warn", "error"] });
    expect(issues).toHaveLength(1);
    const reqs = filterConsoleLogLines(lines, { severities: ["req", "ok"] });
    expect(reqs).toHaveLength(2);
  });

  it("combines query and severity", () => {
    const out = filterConsoleLogLines(lines, {
      query: "combo",
      severities: ["info", "log"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/COMBO/);
  });

  it("filters by subsystem tags without bare substring false positives", () => {
    const headroom = filterConsoleLogLines(lines, { tags: ["HEADROOM"] });
    expect(headroom).toHaveLength(1);
    expect(headroom[0]).toMatch(/\[HEADROOM\]/);
    expect(headroom[0]).not.toMatch(/conceptually/);

    expect(consoleLogLineMatchesTags(
      "[03:26:49] [INFO] talking about headroom conceptually",
      ["HEADROOM"]
    )).toBe(false);
  });

  it("prepareConsoleLogRows returns parsed objects once", () => {
    const rows = prepareConsoleLogRows(lines, { tags: ["COMBO"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe("COMBO");
    expect(rows[0].message).toMatch(/Trying model/);
  });

  it("buildConsoleLogExportText redacts and can export filtered only", () => {
    const secretLines = [
      "[12:00:00] [INFO] Authorization: Bearer sk-live-abcdefghijklmnop",
      "[12:00:01] [INFO] ℹ️  [COMBO] ok",
    ];
    const all = buildConsoleLogExportText(secretLines, { filtered: false });
    expect(all).toContain("Bearer ***");
    expect(all).not.toContain("sk-live");

    const filtered = buildConsoleLogExportText(secretLines, {
      filtered: true,
      tags: ["COMBO"],
    });
    expect(filtered).toMatch(/COMBO/);
    expect(filtered).not.toMatch(/Bearer/);
  });
});

describe("splitConsoleLogHighlights", () => {
  it("splits query matches for highlight rendering", () => {
    expect(splitConsoleLogHighlights("hello COMBO world", "combo")).toEqual([
      { text: "hello ", hit: false },
      { text: "COMBO", hit: true },
      { text: " world", hit: false },
    ]);
    expect(splitConsoleLogHighlights("plain", "")).toEqual([
      { text: "plain", hit: false },
    ]);
    expect(splitConsoleLogHighlights("a+b a+b", "a+b")).toEqual([
      { text: "a+b", hit: true },
      { text: " ", hit: false },
      { text: "a+b", hit: true },
    ]);
  });
});
