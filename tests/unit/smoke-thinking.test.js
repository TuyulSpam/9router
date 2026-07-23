import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const smokeScript = path.join(repoRoot, "ops/smoke-thinking.sh");
const tempDirs = [];

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ops/smoke-thinking.sh", () => {
  it("requires an explicit --run guard before making model requests", () => {
    const result = spawnSync("bash", [smokeScript], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--run");
  });

  it.each([
    { kelasProvider: "codex", expectedOutput: "kelas_berat_codex_effort=max" },
    { kelasProvider: "grok-cli", expectedOutput: "kelas_berat_grok_cli_effort=xhigh" },
  ])("verifies provider-owned thinking through $kelasProvider", ({ kelasProvider, expectedOutput }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-smoke-thinking-"));
    tempDirs.push(tempDir);
    const fakeBin = path.join(tempDir, "bin");
    const dbPath = path.join(tempDir, "data.sqlite");
    const livePackage = path.join(tempDir, "global/9router");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.join(livePackage, "app/.next-cli-build"), { recursive: true });
    fs.writeFileSync(path.join(livePackage, "app/.next-cli-build/BUILD_ID"), "verified-build\n");

    const schema = `
      CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      INSERT INTO settings(id, data) VALUES(1, '{"providerThinking":{"codex":{"mode":"ultra"},"antigravity":{"mode":"xhigh"},"grok-cli":{"mode":"xhigh"}}}');
      CREATE TABLE requestDetails (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, status TEXT, data TEXT NOT NULL);
    `;
    const dbResult = spawnSync("sqlite3", [dbPath, schema], { encoding: "utf8" });
    expect(dbResult.status, dbResult.stderr).toBe(0);

    writeExecutable(path.join(fakeBin, "pm2"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(fakeBin, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
let outputPath = null;
let payload = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-o") outputPath = args[index + 1];
  if (args[index] === "--data-binary") payload = args[index + 1];
}

if (!payload) {
  process.stdout.write('{"ok":true}');
  process.exit(0);
}

const body = JSON.parse(payload);
const timestamp = new Date().toISOString();
let provider;
let model;
let data;
if (body.model === "Kelas-berat") {
  provider = process.env.FAKE_KELAS_PROVIDER || "codex";
  model = provider === "grok-cli" ? "grok-4.5-high" : "gpt-5.6-sol";
  const effort = provider === "grok-cli" ? "xhigh" : "max";
  data = { request: { input: body.input, reasoning: { effort, summary: "auto" } } };
} else {
  provider = "antigravity";
  model = "gemini-3-flash-agent";
  data = {
    request: { input: body.input },
    providerRequest: { request: { generationConfig: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } } },
  };
}

const sqlValue = (value) => String(value).replaceAll("'", "''");
const sql = "INSERT INTO requestDetails(id,timestamp,provider,model,connectionId,status,data) VALUES(" +
  "'" + sqlValue(provider + "-" + Date.now()) + "'," +
  "'" + sqlValue(timestamp) + "'," +
  "'" + sqlValue(provider) + "'," +
  "'" + sqlValue(model) + "',NULL,'success'," +
  "'" + sqlValue(JSON.stringify(data)) + "');";
const inserted = spawnSync("/usr/bin/sqlite3", [process.env.DB_PATH, sql], { encoding: "utf8" });
if (inserted.status !== 0) {
  process.stderr.write(inserted.stderr);
  process.exit(inserted.status || 1);
}
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify({ status: "completed" }));
process.stdout.write("200");
`);

    const result = spawnSync("bash", [smokeScript, "--run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BASE_URL: "http://fake/v1",
        DB_PATH: dbPath,
        LIVE_PACKAGE: livePackage,
        FAKE_KELAS_PROVIDER: kelasProvider,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(expectedOutput);
    expect(result.stdout).toContain("ag_gemini_thinking_level=high");
    expect(result.stdout).toContain("SMOKE OK");
  });
});
