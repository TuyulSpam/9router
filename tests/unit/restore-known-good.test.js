import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const restoreScript = path.join(repoRoot, "ops/restore-known-good.sh");
const tempDirs = [];

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ops/restore-known-good.sh", () => {
  it("uses the manifest package version for tarball-only restore", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-restore-known-good-"));
    tempDirs.push(tempDir);

    const fakeBin = path.join(tempDir, "bin");
    const pin = path.join(tempDir, "9router-known-good-abcdef12");
    const tarball = path.join(pin, "tarball/9router-9.9.9.tgz");
    const commitTarball = path.join(pin, "tarball/9router-9.9.9-abcdef12.tgz");
    const globalPackage = path.join(tempDir, "global/9router");
    const backupRoot = path.join(tempDir, "backups");
    const installedTarballLog = path.join(tempDir, "installed-tarball.txt");

    fs.mkdirSync(path.dirname(tarball), { recursive: true });
    fs.mkdirSync(path.join(pin, "meta"), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(tarball, "test tarball");
    fs.writeFileSync(commitTarball, "test tarball");
    fs.writeFileSync(path.join(pin, "meta/MANIFEST.txt"), "pkg_version=9.9.9\n");
    fs.writeFileSync(path.join(pin, "meta/SOURCE_COMMIT"), "abcdef1234567890\n");

    writeExecutable(path.join(fakeBin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "install" && "\${2:-}" == "-g" ]]; then
  echo "\${3:-}" > "$FAKE_INSTALLED_TARBALL_LOG"
  exit 0
fi
exit 1
`);

    writeExecutable(path.join(fakeBin, "pm2"), `#!/usr/bin/env bash
exit 0
`);

    writeExecutable(path.join(fakeBin, "curl"), `#!/usr/bin/env bash
printf '%s' '{"ok":true}'
`);

    const result = spawnSync("bash", [restoreScript, pin], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BACKUP_ROOT: backupRoot,
        GLOBAL_PKG: globalPackage,
        FAKE_INSTALLED_TARBALL_LOG: installedTarballLog,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(installedTarballLog, "utf8").trim()).toBe(tarball);
    expect(fs.readFileSync(path.join(globalPackage, "app/.openclaw-source-commit"), "utf8").trim()).toBe(
      "abcdef1234567890",
    );
  });
});
