#!/usr/bin/env bash
# Snapshot current source tip + live global install as known-good pin.
set -euo pipefail

REPO="${REPO:-/home/ubuntu/9router}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/openclaw-backups}"
GLOBAL_PKG="${GLOBAL_PKG:-/home/ubuntu/.npm-global/lib/node_modules/9router}"
TGZ_DEFAULT="${TGZ_DEFAULT:-/home/ubuntu/9router-0.5.30.tgz}"

cd "$REPO"
HEAD="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
PIN="$BACKUP_ROOT/9router-known-good-$SHORT"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$PIN"/{tarball,global-snapshot,meta}

if [[ -d "$GLOBAL_PKG" ]]; then
  rsync -a --delete "$GLOBAL_PKG/" "$PIN/global-snapshot/9router/"
else
  echo "WARN: global package missing: $GLOBAL_PKG" >&2
fi

if [[ -f "$TGZ_DEFAULT" ]]; then
  cp -a "$TGZ_DEFAULT" "$PIN/tarball/9router-0.5.30.tgz"
  cp -a "$TGZ_DEFAULT" "$PIN/tarball/9router-0.5.30-${SHORT}.tgz"
elif [[ -f "$PIN/tarball/9router-0.5.30.tgz" ]]; then
  echo "WARN: using existing tarball in pin (no $TGZ_DEFAULT)" >&2
else
  echo "WARN: no tarball found — pin has global snapshot only" >&2
fi

git rev-parse HEAD > "$PIN/meta/SOURCE_COMMIT"
git log -1 --format='%H%n%s%n%ci' > "$PIN/meta/SOURCE_LOG.txt"
git status -sb > "$PIN/meta/git-status.txt"
git log --oneline -20 > "$PIN/meta/git-log-oneline.txt"

{
  echo "pinned_at=$TS"
  echo "source_commit=$HEAD"
  echo "source_short=$SHORT"
  echo "live_marker=$(cat "$GLOBAL_PKG/app/.openclaw-source-commit" 2>/dev/null || true)"
  echo "pkg_version=$(node -e "console.log(require('$GLOBAL_PKG/package.json').version)" 2>/dev/null || echo unknown)"
  echo "health=$(curl -sS -m 4 http://127.0.0.1:20128/api/health 2>/dev/null || echo fail)"
  echo "version_api=$(curl -sS -m 4 http://127.0.0.1:20128/api/version 2>/dev/null || echo fail)"
  echo "hostname=$(hostname)"
} > "$PIN/meta/MANIFEST.txt"

cat > "$PIN/RESTORE.md" <<EOF
# Restore this known-good pin

\`\`\`bash
$REPO/ops/restore-known-good.sh $PIN
\`\`\`

Or:

\`\`\`bash
pm2 stop 9router
rm -rf $GLOBAL_PKG
cp -a $PIN/global-snapshot/9router $GLOBAL_PKG
pm2 restart 9router
curl -sf http://127.0.0.1:20128/api/health
\`\`\`

Commit: $HEAD
Pinned: $TS
EOF

cat > "$PIN/README.md" <<EOF
# 9Router known-good pin ($SHORT)

- Source commit: \`$HEAD\`
- Pinned at: $TS
- Global snapshot: \`global-snapshot/9router/\`
- Tarball: \`tarball/\`
- Manifest: \`meta/MANIFEST.txt\`

See \`$REPO/DEPLOY.md\` for deploy policy (no large rewrites, no \`npm i -g 9router@latest\`).
EOF

ln -sfn "$PIN" "$BACKUP_ROOT/9router-known-good-latest"
mkdir -p /home/ubuntu/.9router
echo "$HEAD" > /home/ubuntu/.9router/KNOWN_GOOD_COMMIT
echo "$PIN" > /home/ubuntu/.9router/KNOWN_GOOD_PATH
echo "$SHORT" > /home/ubuntu/.9router/KNOWN_GOOD_SHORT

echo "PINNED $SHORT -> $PIN"
du -sh "$PIN" | awk '{print "size", $1}'
cat "$PIN/meta/MANIFEST.txt"
