#!/usr/bin/env bash
# Restore live 9router global install from a known-good pin.
set -euo pipefail

REPO="${REPO:-/home/ubuntu/9router}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/openclaw-backups}"
GLOBAL_PKG="${GLOBAL_PKG:-/home/ubuntu/.npm-global/lib/node_modules/9router}"
PIN="${1:-}"

if [[ -z "$PIN" ]]; then
  if [[ -f /home/ubuntu/.9router/KNOWN_GOOD_PATH ]]; then
    PIN="$(cat /home/ubuntu/.9router/KNOWN_GOOD_PATH)"
  elif [[ -L "$BACKUP_ROOT/9router-known-good-latest" || -d "$BACKUP_ROOT/9router-known-good-latest" ]]; then
    PIN="$BACKUP_ROOT/9router-known-good-latest"
  else
    echo "Usage: $0 [pin-dir]" >&2
    echo "No known-good pin found." >&2
    exit 1
  fi
fi

# Resolve symlink
PIN="$(readlink -f "$PIN")"
SNAP="$PIN/global-snapshot/9router"
TGZ=""

if [[ ! -d "$SNAP" ]]; then
  PKG_VERSION=""
  if [[ -f "$PIN/meta/MANIFEST.txt" ]]; then
    PKG_VERSION="$(awk -F= '$1 == "pkg_version" { sub(/^[^=]*=/, ""); print; exit }' "$PIN/meta/MANIFEST.txt")"
  fi

  if [[ "$PKG_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
    MANIFEST_TGZ="$PIN/tarball/9router-${PKG_VERSION}.tgz"
    [[ -f "$MANIFEST_TGZ" ]] && TGZ="$MANIFEST_TGZ"
  fi

  if [[ -z "$TGZ" ]]; then
    shopt -s nullglob
    TGZ_CANDIDATES=("$PIN"/tarball/9router-*.tgz)
    shopt -u nullglob
    if [[ ${#TGZ_CANDIDATES[@]} -eq 1 ]]; then
      TGZ="${TGZ_CANDIDATES[0]}"
    elif [[ ${#TGZ_CANDIDATES[@]} -gt 1 ]]; then
      echo "ERROR: multiple restore tarballs found and manifest does not select one:" >&2
      printf '  %s\n' "${TGZ_CANDIDATES[@]}" >&2
      exit 1
    fi
  fi
fi

if [[ ! -d "$SNAP" && ( -z "$TGZ" || ! -f "$TGZ" ) ]]; then
  echo "ERROR: pin has neither global-snapshot nor tarball: $PIN" >&2
  exit 1
fi

echo "Restoring from: $PIN"
[[ -f "$PIN/meta/MANIFEST.txt" ]] && cat "$PIN/meta/MANIFEST.txt"

# Safety backup of current live
TS="$(date +%Y%m%d-%H%M%S)"
SAFETY="$BACKUP_ROOT/9router-pre-restore-$TS"
mkdir -p "$SAFETY"
if [[ -d "$GLOBAL_PKG" ]]; then
  cp -a "$GLOBAL_PKG" "$SAFETY/global-9router"
  echo "Safety backup: $SAFETY"
fi

pm2 stop 9router 2>/dev/null || true

rm -rf "$GLOBAL_PKG"
if [[ -d "$SNAP" ]]; then
  mkdir -p "$(dirname "$GLOBAL_PKG")"
  cp -a "$SNAP" "$GLOBAL_PKG"
  echo "Restored global snapshot"
elif [[ -f "$TGZ" ]]; then
  npm install -g "$TGZ"
  echo "Restored via tarball"
fi

if [[ -f "$PIN/meta/SOURCE_COMMIT" ]]; then
  mkdir -p "$GLOBAL_PKG/app"
  cp "$PIN/meta/SOURCE_COMMIT" "$GLOBAL_PKG/app/.openclaw-source-commit"
fi

pm2 restart 9router --update-env 2>/dev/null || pm2 start 9router --update-env
pm2 save 2>/dev/null || true

echo "Waiting for health..."
OK=0
for i in $(seq 1 40); do
  if curl -sf -m 3 http://127.0.0.1:20128/api/health >/dev/null 2>&1; then
    OK=1
    echo "HEALTH OK (attempt $i)"
    break
  fi
  sleep 3
done
curl -sS -m 5 http://127.0.0.1:20128/api/health || true
echo
curl -sS -m 5 http://127.0.0.1:20128/api/version || true
echo
if [[ "$OK" -ne 1 ]]; then
  echo "WARN: health not OK yet — check: pm2 logs 9router" >&2
  exit 2
fi
echo "Restore complete."
