#!/usr/bin/env bash
# Build CLI pack from source, install globally, restart PM2 9router.
# Usage:
#   ./ops/deploy-live.sh           # backup + build + install + restart
#   ./ops/deploy-live.sh --pin     # same, then refresh known-good pin
#   ./ops/deploy-live.sh --skip-build  # install existing tarball only
set -euo pipefail

REPO="${REPO:-/home/ubuntu/9router}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/openclaw-backups}"
GLOBAL_PKG="${GLOBAL_PKG:-/home/ubuntu/.npm-global/lib/node_modules/9router}"
_PKG_VER="$(node -e "console.log(require('$REPO/package.json').version)" 2>/dev/null || echo "0.5.35")"
TGZ_OVERRIDE="${TGZ:-}"
DEFAULT_TGZ="/home/ubuntu/9router-${_PKG_VER}.tgz"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:20128/api/health}"
VERSION_URL="${VERSION_URL:-http://127.0.0.1:20128/api/version}"

DO_PIN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --pin) DO_PIN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

cd "$REPO"
HEAD="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
echo "=== deploy-live ==="
echo "repo=$REPO"
echo "commit=$SHORT ($HEAD)"

# Dirty tree warning (tracked only)
if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null || true)" ]]; then
  echo "WARN: tracked working tree is dirty:" >&2
  git status --porcelain --untracked-files=no >&2
fi

# 1) Backup outside package dir (npm i -g wipes GLOBAL_PKG)
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BACKUP_ROOT/9router-pre-deploy-$TS"
mkdir -p "$BK"
if [[ -d "$GLOBAL_PKG" ]]; then
  cp -a "$GLOBAL_PKG" "$BK/global-9router"
fi
{
  echo "timestamp=$TS"
  echo "source_commit=$HEAD"
  echo "pre_live_marker=$(cat "$GLOBAL_PKG/app/.openclaw-source-commit" 2>/dev/null || true)"
  echo "health_before=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || echo fail)"
} > "$BK/MANIFEST.txt"
echo "backup=$BK"

# 2) Build into the unique backup directory so a stale fixed-path tarball
# can never be selected by a normal source deploy.
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "=== cli:build ==="
  npm --prefix cli run build
  echo "=== cli:pack ==="
  npm --prefix cli pack --pack-destination "$BK"
  TGZ="$BK/9router-${_PKG_VER}.tgz"
  if [[ -n "$TGZ_OVERRIDE" ]]; then
    mkdir -p "$(dirname "$TGZ_OVERRIDE")"
    cp -a "$TGZ" "$TGZ_OVERRIDE"
    echo "artifact_copy=$TGZ_OVERRIDE"
  fi
else
  echo "=== skip build ==="
  SOURCE_TGZ="${TGZ_OVERRIDE:-$DEFAULT_TGZ}"
  if [[ ! -f "$SOURCE_TGZ" ]]; then
    echo "ERROR: tarball missing: $SOURCE_TGZ" >&2
    exit 1
  fi
  TGZ="$BK/$(basename "$SOURCE_TGZ")"
  cp -a "$SOURCE_TGZ" "$TGZ"
fi

if [[ ! -f "$TGZ" ]]; then
  echo "ERROR: tarball missing: $TGZ" >&2
  exit 1
fi

PACKED_VERSION="$(tar -xOf "$TGZ" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
if [[ "$PACKED_VERSION" != "$_PKG_VER" ]]; then
  echo "ERROR: artifact version mismatch: expected $_PKG_VER, got $PACKED_VERSION" >&2
  exit 1
fi

PACKED_BUILD_ID="$(tar -xOf "$TGZ" package/app/.next-cli-build/BUILD_ID | tr -d '\r\n')"
if [[ -z "$PACKED_BUILD_ID" ]]; then
  echo "ERROR: artifact BUILD_ID missing: $TGZ" >&2
  exit 1
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  SOURCE_BUILD_ID="$(tr -d '\r\n' < "$REPO/cli/app/.next-cli-build/BUILD_ID")"
  if [[ "$PACKED_BUILD_ID" != "$SOURCE_BUILD_ID" ]]; then
    echo "ERROR: artifact BUILD_ID mismatch: source=$SOURCE_BUILD_ID packed=$PACKED_BUILD_ID" >&2
    exit 1
  fi
fi

ARTIFACT_SHA256="$(sha256sum "$TGZ" | awk '{print $1}')"
ARTIFACT_SIZE="$(stat -c '%s' "$TGZ")"
echo "artifact=$TGZ"
echo "artifact_sha256=$ARTIFACT_SHA256"
echo "artifact_size=$ARTIFACT_SIZE"
echo "artifact_build_id=$PACKED_BUILD_ID"
{
  echo "artifact=$TGZ"
  echo "artifact_version=$PACKED_VERSION"
  echo "artifact_sha256=$ARTIFACT_SHA256"
  echo "artifact_size=$ARTIFACT_SIZE"
  echo "artifact_build_id=$PACKED_BUILD_ID"
} >> "$BK/MANIFEST.txt"

# 3) Install
echo "=== npm install -g ==="
npm install -g "$TGZ"

LIVE_BUILD_ID="$(tr -d '\r\n' < "$GLOBAL_PKG/app/.next-cli-build/BUILD_ID")"
if [[ "$LIVE_BUILD_ID" != "$PACKED_BUILD_ID" ]]; then
  echo "ERROR: installed BUILD_ID mismatch: packed=$PACKED_BUILD_ID live=$LIVE_BUILD_ID" >&2
  exit 1
fi
echo "live_build_id=$LIVE_BUILD_ID"

# 4) Source marker (must survive for diagnostics)
mkdir -p "$GLOBAL_PKG/app"
echo "$HEAD" > "$GLOBAL_PKG/app/.openclaw-source-commit"

# 5) Restart
echo "=== pm2 restart ==="
if pm2 describe 9router >/dev/null 2>&1; then
  pm2 restart 9router --update-env
else
  echo "WARN: pm2 process 9router not found — start manually with:" >&2
  echo "  pm2 start 9router -- --no-browser --skip-update" >&2
fi
pm2 save 2>/dev/null || true

# 6) Health poll (cold start may rebuild native modules)
echo "=== health poll ==="
OK=0
for i in $(seq 1 45); do
  if curl -sf -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
    OK=1
    echo "HEALTH OK (attempt $i)"
    break
  fi
  echo "wait $i..."
  sleep 3
done

echo -n "health: "; curl -sS -m 5 "$HEALTH_URL" || echo fail
echo
echo -n "version: "; curl -sS -m 5 "$VERSION_URL" || echo fail
echo
echo -n "marker: "; cat "$GLOBAL_PKG/app/.openclaw-source-commit" 2>/dev/null || true
echo

if [[ "$OK" -ne 1 ]]; then
  echo "ERROR: health check failed. Logs: pm2 logs 9router --lines 80" >&2
  echo "Rollback: $REPO/ops/restore-known-good.sh" >&2
  exit 2
fi

# 7) Optional re-pin
if [[ "$DO_PIN" -eq 1 ]]; then
  echo "=== provider-thinking smoke ==="
  "$REPO/ops/smoke-thinking.sh" --run
  echo "=== pin known-good ==="
  TGZ_DEFAULT="$TGZ" "$REPO/ops/pin-known-good.sh"
fi

{
  echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "deployed_commit=$HEAD"
  echo "health_after=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || echo fail)"
} >> "$BK/MANIFEST.txt"

echo "=== deploy complete ==="
echo "backup=$BK"
echo "commit=$SHORT"
echo "Policy: do not npm i -g 9router@latest; no large rewrites. See DEPLOY.md"
