#!/usr/bin/env bash
# Live provider-thinking smoke test. Sends two real model requests.
# Usage: ./ops/smoke-thinking.sh --run
set -euo pipefail

if [[ "${1:-}" != "--run" || "$#" -ne 1 ]]; then
  echo "Usage: $0 --run" >&2
  echo "This sends live requests through Kelas-berat and ag/gemini-3-flash-agent." >&2
  exit 2
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:20128/v1}"
HEALTH_URL="${HEALTH_URL:-${BASE_URL%/v1}/api/health}"
DB_PATH="${DB_PATH:-/home/ubuntu/.9router/db/data.sqlite}"
LIVE_PACKAGE="${LIVE_PACKAGE:-/home/ubuntu/.npm-global/lib/node_modules/9router}"
PM2_NAME="${PM2_NAME:-9router}"
EXPECTED_CODEX_MODE="${EXPECTED_CODEX_MODE:-ultra}"
EXPECTED_CODEX_EFFORT="${EXPECTED_CODEX_EFFORT:-max}"
EXPECTED_AG_MODE="${EXPECTED_AG_MODE:-xhigh}"
EXPECTED_AG_LEVEL="${EXPECTED_AG_LEVEL:-high}"
EXPECTED_GROK_MODE="${EXPECTED_GROK_MODE:-xhigh}"
EXPECTED_GROK_EFFORT="${EXPECTED_GROK_EFFORT:-xhigh}"

for command_name in curl node pm2 sqlite3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: required command missing: $command_name" >&2
    exit 1
  fi
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: request observability database missing: $DB_PATH" >&2
  exit 1
fi

if ! pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "ERROR: PM2 process not found: $PM2_NAME" >&2
  exit 1
fi

printf 'health='
curl -fsS -m 5 "$HEALTH_URL"
echo

LIVE_BUILD_ID_FILE="$LIVE_PACKAGE/app/.next-cli-build/BUILD_ID"
if [[ ! -f "$LIVE_BUILD_ID_FILE" ]]; then
  echo "ERROR: live BUILD_ID missing: $LIVE_BUILD_ID_FILE" >&2
  exit 1
fi
printf 'live_build_id=%s\n' "$(tr -d '\r\n' < "$LIVE_BUILD_ID_FILE")"

CODEX_MODE="$(sqlite3 "$DB_PATH" "SELECT json_extract(data,'$.providerThinking.codex.mode') FROM settings WHERE id=1;")"
AG_MODE="$(sqlite3 "$DB_PATH" "SELECT json_extract(data,'$.providerThinking.antigravity.mode') FROM settings WHERE id=1;")"
GROK_MODE="$(sqlite3 "$DB_PATH" "SELECT json_extract(data,'$.providerThinking.\"grok-cli\".mode') FROM settings WHERE id=1;")"
if [[ "$CODEX_MODE" != "$EXPECTED_CODEX_MODE" ]]; then
  echo "ERROR: expected Codex providerThinking=$EXPECTED_CODEX_MODE, got ${CODEX_MODE:-missing}" >&2
  exit 1
fi
if [[ "$AG_MODE" != "$EXPECTED_AG_MODE" ]]; then
  echo "ERROR: expected Antigravity providerThinking=$EXPECTED_AG_MODE, got ${AG_MODE:-missing}" >&2
  exit 1
fi
if [[ "$GROK_MODE" != "$EXPECTED_GROK_MODE" ]]; then
  echo "ERROR: expected Grok CLI providerThinking=$EXPECTED_GROK_MODE, got ${GROK_MODE:-missing}" >&2
  exit 1
fi
printf 'provider_modes=codex:%s,antigravity:%s,grok-cli:%s\n' "$CODEX_MODE" "$AG_MODE" "$GROK_MODE"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

post_response() {
  local payload="$1"
  local output_file="$2"
  local http_code
  http_code="$(curl -sS -m 180 -o "$output_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    -H 'User-Agent: 9router-thinking-smoke/1.0' \
    "$BASE_URL/responses" \
    --data-binary "$payload")"
  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    echo "ERROR: smoke request failed with HTTP $http_code" >&2
    sed -n '1,40p' "$output_file" >&2
    exit 1
  fi
}

wait_for_value() {
  local query="$1"
  local value=""
  for _ in $(seq 1 30); do
    value="$(sqlite3 -noheader "$DB_PATH" "$query")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

KELAS_MARKER="kelas-thinking-smoke-$(date +%s%N)"
KELAS_START="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
KELAS_PAYLOAD="$(node -e 'const marker=process.argv[1]; console.log(JSON.stringify({model:"Kelas-berat",input:`Balas tepat OK. Marker: ${marker}`,reasoning:{effort:"medium",summary:"auto"},max_output_tokens:32,stream:false}))' "$KELAS_MARKER")"
post_response "$KELAS_PAYLOAD" "$TMP_DIR/kelas.json"

KELAS_QUERY="SELECT provider || '|' || model || '|' || json_extract(data,'$.request.reasoning.effort') FROM requestDetails WHERE timestamp >= '$KELAS_START' AND status='success' AND data LIKE '%$KELAS_MARKER%' AND json_extract(data,'$.request.reasoning.effort') IS NOT NULL ORDER BY timestamp DESC LIMIT 1;"
if ! KELAS_ROW="$(wait_for_value "$KELAS_QUERY")"; then
  echo "ERROR: no observable Kelas-berat upstream effort found" >&2
  exit 1
fi
IFS='|' read -r KELAS_PROVIDER KELAS_MODEL KELAS_EFFORT <<< "$KELAS_ROW"
case "$KELAS_PROVIDER" in
  codex)
    KELAS_EXPECTED_EFFORT="$EXPECTED_CODEX_EFFORT"
    KELAS_PROVIDER_LABEL="codex"
    ;;
  grok-cli)
    KELAS_EXPECTED_EFFORT="$EXPECTED_GROK_EFFORT"
    KELAS_PROVIDER_LABEL="grok_cli"
    ;;
  *)
    echo "ERROR: Kelas-berat selected unexpected provider $KELAS_PROVIDER/$KELAS_MODEL" >&2
    exit 1
    ;;
esac
if [[ "$KELAS_EFFORT" != "$KELAS_EXPECTED_EFFORT" ]]; then
  echo "ERROR: Kelas-berat expected $KELAS_PROVIDER/$KELAS_EXPECTED_EFFORT, got $KELAS_PROVIDER/$KELAS_MODEL/$KELAS_EFFORT" >&2
  exit 1
fi
printf 'kelas_berat_route=%s/%s\n' "$KELAS_PROVIDER" "$KELAS_MODEL"
printf 'kelas_berat_%s_effort=%s\n' "$KELAS_PROVIDER_LABEL" "$KELAS_EFFORT"

AG_MARKER="ag-thinking-smoke-$(date +%s%N)"
AG_START="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
AG_PAYLOAD="$(node -e 'const marker=process.argv[1]; console.log(JSON.stringify({model:"ag/gemini-3-flash-agent",input:`Balas tepat OK. Marker: ${marker}`,max_output_tokens:16,stream:false}))' "$AG_MARKER")"
post_response "$AG_PAYLOAD" "$TMP_DIR/ag.json"

AG_QUERY="SELECT json_extract(data,'$.providerRequest.request.generationConfig.thinkingConfig.thinkingLevel') FROM requestDetails WHERE timestamp >= '$AG_START' AND provider='antigravity' AND model='gemini-3-flash-agent' AND status='success' AND data LIKE '%$AG_MARKER%' AND json_extract(data,'$.providerRequest.request.generationConfig.thinkingConfig.thinkingLevel') IS NOT NULL ORDER BY timestamp DESC LIMIT 1;"
if ! AG_LEVEL="$(wait_for_value "$AG_QUERY")"; then
  echo "ERROR: no observable Antigravity thinkingLevel found" >&2
  exit 1
fi
if [[ "$AG_LEVEL" != "$EXPECTED_AG_LEVEL" ]]; then
  echo "ERROR: expected Antigravity thinkingLevel=$EXPECTED_AG_LEVEL, got $AG_LEVEL" >&2
  exit 1
fi
printf 'ag_gemini_thinking_level=%s\n' "$AG_LEVEL"
echo "SMOKE OK"
