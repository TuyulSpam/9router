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
TGZ="${TGZ:-/home/ubuntu/9router-0.5.30.tgz}"
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

# 2) Build
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "=== cli:pack ==="
  npm run cli:pack
else
  echo "=== skip build ==="
fi

if [[ ! -f "$TGZ" ]]; then
  echo "ERROR: tarball missing: $TGZ" >&2
  exit 1
fi
cp -a "$TGZ" "$BK/"

# 3) Install
echo "=== npm install -g ==="
npm install -g "$TGZ"

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
  echo "=== pin known-good ==="
  "$REPO/ops/pin-known-good.sh"
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
