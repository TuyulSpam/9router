import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployScript = path.join(repoRoot, "ops/deploy-live.sh");
const tempDirs = [];

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function createPackageTarball(rootDir, outputPath, buildId) {
  const packageDir = path.join(rootDir, "package");
  fs.mkdirSync(path.join(packageDir, "app/.next-cli-build"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "9router", version: "9.9.9" }));
  fs.writeFileSync(path.join(packageDir, "app/.next-cli-build/BUILD_ID"), `${buildId}\n`);
  const result = spawnSync("tar", ["-czf", outputPath, "-C", rootDir, "package"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ops/deploy-live.sh", () => {
  it("installs the freshly built backup-scoped artifact instead of a stale fixed-path tarball", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-deploy-live-"));
    tempDirs.push(tempDir);

    const fakeRepo = path.join(tempDir, "repo");
    const fakeBin = path.join(tempDir, "bin");
    const backupRoot = path.join(tempDir, "backups");
    const globalPackage = path.join(tempDir, "global/9router");
    const fakePackageRoot = path.join(tempDir, "fresh-package");
    const npmLog = path.join(tempDir, "npm.log");
    const installedTarballLog = path.join(tempDir, "installed-tarball.txt");
    const smokeLog = path.join(tempDir, "smoke.txt");
    const pinLog = path.join(tempDir, "pin.txt");

    fs.mkdirSync(path.join(fakeRepo, "cli"), { recursive: true });
    fs.mkdirSync(path.join(fakeRepo, "ops"), { recursive: true });
    fs.mkdirSync(path.join(fakeRepo, ".next-cli-build/cache"), { recursive: true });
    fs.mkdirSync(path.join(globalPackage, "app/.next-cli-build"), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeRepo, "package.json"), JSON.stringify({ name: "9router-app", version: "9.9.9" }));
    fs.writeFileSync(path.join(fakeRepo, "cli/package.json"), JSON.stringify({ name: "9router", version: "9.9.9" }));
    fs.writeFileSync(path.join(fakeRepo, ".next-cli-build/cache/stale.pack"), "corrupt-cache");
    fs.writeFileSync(path.join(globalPackage, "app/.next-cli-build/BUILD_ID"), "old-live-build\n");
    fs.writeFileSync(path.join(globalPackage, "app/.openclaw-source-commit"), "old-commit\n");
    writeExecutable(path.join(fakeRepo, "ops/smoke-thinking.sh"), "#!/usr/bin/env bash\necho \"$*\" > \"$FAKE_SMOKE_LOG\"\n");
    writeExecutable(path.join(fakeRepo, "ops/pin-known-good.sh"), "#!/usr/bin/env bash\necho \"$TGZ_DEFAULT\" > \"$FAKE_PIN_LOG\"\n");

    const stalePackageRoot = path.join(tempDir, "stale-package");
    const staleTarball = path.join(tempDir, "9router-9.9.9.tgz");
    createPackageTarball(stalePackageRoot, staleTarball, "stale-build-id");

    writeExecutable(path.join(fakeBin, "git"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "rev-parse" && "\${2:-}" == "--short" ]]; then
  echo 1111111
elif [[ "\${1:-}" == "rev-parse" ]]; then
  echo 1111111111111111111111111111111111111111
elif [[ "\${1:-}" == "status" ]]; then
  exit 0
else
  exit 1
fi
`);

    writeExecutable(path.join(fakeBin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_NPM_LOG"

if [[ "\${1:-}" == "--prefix" && "\${2:-}" == "cli" && "\${3:-}" == "run" && "\${4:-}" == "build" ]]; then
  if [[ -e "$REPO/.next-cli-build/cache/stale.pack" ]]; then
    echo "stale webpack cache was not cleared" >&2
    exit 41
  fi
  mkdir -p "$REPO/cli/app/.next-cli-build"
  echo fresh-build-id > "$REPO/cli/app/.next-cli-build/BUILD_ID"
  exit 0
fi

if [[ "\${1:-}" == "--prefix" && "\${2:-}" == "cli" && "\${3:-}" == "pack" ]]; then
  destination=""
  shift 3
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--pack-destination" ]]; then
      destination="$2"
      shift 2
    else
      shift
    fi
  done
  mkdir -p "$destination"
  echo wrong-root-package > "$destination/9router-app-9.9.9.tgz"
  echo 9router-app-9.9.9.tgz
  exit 0
fi

if [[ "\${1:-}" == "pack" ]]; then
  if [[ "$PWD" != "$REPO/cli" ]]; then
    echo "npm pack must run from the CLI package directory" >&2
    exit 42
  fi
  destination=""
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--pack-destination" ]]; then
      destination="$2"
      shift 2
    else
      shift
    fi
  done
  mkdir -p "$destination" "$FAKE_PACKAGE_ROOT/package/app/.next-cli-build"
  printf '%s' '{"name":"9router","version":"9.9.9"}' > "$FAKE_PACKAGE_ROOT/package/package.json"
  echo fresh-build-id > "$FAKE_PACKAGE_ROOT/package/app/.next-cli-build/BUILD_ID"
  tar -czf "$destination/9router-9.9.9.tgz" -C "$FAKE_PACKAGE_ROOT" package
  echo 9router-9.9.9.tgz
  exit 0
fi

if [[ "\${1:-}" == "run" && "\${2:-}" == "cli:pack" ]]; then
  exit 0
fi

if [[ "\${1:-}" == "install" && "\${2:-}" == "-g" ]]; then
  artifact="$3"
  echo "$artifact" > "$FAKE_INSTALLED_TARBALL_LOG"
  extract_dir="$FAKE_PACKAGE_ROOT/install"
  rm -rf "$extract_dir" "$GLOBAL_PKG"
  mkdir -p "$extract_dir" "$(dirname "$GLOBAL_PKG")"
  tar -xzf "$artifact" -C "$extract_dir"
  cp -a "$extract_dir/package" "$GLOBAL_PKG"
  exit 0
fi

echo "unexpected npm invocation: $*" >&2
exit 1
`);

    writeExecutable(path.join(fakeBin, "pm2"), `#!/usr/bin/env bash
exit 0
`);

    writeExecutable(path.join(fakeBin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
if [[ "$url" == *"/api/version" ]]; then
  printf '%s' '{"currentVersion":"9.9.9"}'
else
  printf '%s' '{"ok":true}'
fi
`);

    const result = spawnSync("bash", [deployScript, "--pin"], {
      cwd: fakeRepo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        REPO: fakeRepo,
        BACKUP_ROOT: backupRoot,
        GLOBAL_PKG: globalPackage,
        HEALTH_URL: "http://fake/api/health",
        VERSION_URL: "http://fake/api/version",
        FAKE_NPM_LOG: npmLog,
        FAKE_INSTALLED_TARBALL_LOG: installedTarballLog,
        FAKE_PACKAGE_ROOT: fakePackageRoot,
        FAKE_SMOKE_LOG: smokeLog,
        FAKE_PIN_LOG: pinLog,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const backupDirs = fs.readdirSync(backupRoot).map((entry) => path.join(backupRoot, entry));
    expect(backupDirs).toHaveLength(1);
    const backupTarball = path.join(backupDirs[0], "9router-9.9.9.tgz");
    expect(fs.existsSync(backupTarball)).toBe(true);
    expect(fs.readFileSync(path.join(globalPackage, "app/.next-cli-build/BUILD_ID"), "utf8").trim()).toBe("fresh-build-id");
    expect(fs.readFileSync(installedTarballLog, "utf8").trim()).toBe(backupTarball);
    expect(fs.readFileSync(installedTarballLog, "utf8").trim()).not.toBe(staleTarball);
    expect(fs.readFileSync(smokeLog, "utf8").trim()).toBe("--run");
    expect(fs.readFileSync(pinLog, "utf8").trim()).toBe(backupTarball);
  });
});
