#!/usr/bin/env bash
# Run the live MCP/API smoke test and the headless-Chrome page test against
# one DSH CLI, in a fresh disposable DSH_HOME, with a packed tarball.
#
#   scripts/version-matrix.sh /path/to/dsh-control-mcp-X.Y.Z.tgz /path/to/dsh/bin [port]
#
# The dsh binary is <prefix>/node_modules/.bin/dsh of a local
# `npm i @deepseek-ai/dsh@<version>`. Never touches ~/.dsh. Uses no model
# provider: DSH_SMOKE_NO_PROMPT is not set, so the one prompt exercises the
# "no provider" error path.
set -euo pipefail
if ss -ltn "sport = :${3:-18767}" | grep -q LISTEN; then echo "port ${3:-18767} is in use"; exit 1; fi
TARBALL="${1:?tarball}"
DSH="${2:?dsh binary}"
PORT="${3:-18767}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$(mktemp -d /tmp/dsh-control-mcp-matrix.XXXXXX)"
LOG="$HOME_DIR/server.log"
export DSH_HOME="$HOME_DIR"
cleanup() {
  # Stop the dsh listening on our port (the background job is only its subshell).
  local pid
  pid="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  [[ -n "${SERVER:-}" ]] && kill "$SERVER" 2>/dev/null || true
  wait 2>/dev/null || true
  case "$HOME_DIR" in /tmp/dsh-control-mcp-matrix.*) rm -rf -- "$HOME_DIR" ;; esac
}
trap cleanup EXIT

echo "== DSH $("$DSH" --version 2>/dev/null | tail -1)"
"$DSH" plugin --profile web add "$TARBALL" >/dev/null
(cd /tmp && "$DSH" --profile web --no-open --port "$PORT" >"$LOG" 2>&1) &
SERVER=$!
for _ in $(seq 1 60); do grep -q "token=" "$LOG" 2>/dev/null && break; sleep 1; done
URL="$(grep -o "http://127.0.0.1:$PORT/?token=[^ ]*" "$LOG" | tail -1)"
[[ -n "$URL" ]] || { echo "server did not start"; cat "$LOG"; exit 1; }
BASE="http://127.0.0.1:$PORT"
JAR="$HOME_DIR/cookies"
curl -s -c "$JAR" -o /dev/null "$URL"

DSH_E2E_URL="$URL" node "$ROOT/scripts/e2e-gui.mjs"

rpc() { curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"type\":\"client-request\",\"rpcId\":\"$RANDOM\",\"method\":\"$1\",\"payload\":{\"args\":$2}}" "$BASE/api/$1"; }
REV="$(rpc settings/describe '{}' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const v=JSON.parse(s).result.value;console.log(v.namespaces.find(n=>n.ns==='dsh-control-mcp').revision ?? 0)})")"
rpc settings/mutate "{\"ns\":\"dsh-control-mcp\",\"ops\":[{\"op\":\"set\",\"path\":[\"mcpEnabled\"],\"value\":true},{\"op\":\"set\",\"path\":[\"apiEnabled\"],\"value\":true}],\"expectedRevision\":$REV}" >/dev/null
TOKEN="$(curl -s -b "$JAR" "$BASE/dsh-control-mcp/token" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).value.token))")"
DSH_CONTROL_BASE="$BASE" DSH_CONTROL_TOKEN="$TOKEN" node "$ROOT/scripts/live-smoke.mjs"
SCOPED="$(curl -s -b "$JAR" "$BASE/dsh-control-mcp/keys" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).value.scopedSupported))")"
if [[ "$SCOPED" == "true" ]]; then
  DSH_E2E_URL="$URL" node "$ROOT/scripts/scope-smoke.mjs"
else
  echo "ℹ scoped keys not supported by this DSH version; checking they are refused"
  KEY="$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"name":"scoped","mode":"scoped","sessions":["session-x"]}' "$BASE/dsh-control-mcp/keys" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).value.token))")"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"_request":{}}' "$BASE/dsh-control-mcp/api/v1/call/session/list")"
  [[ "$CODE" == "403" ]] && echo "✔ scoped key refused on this version (403)" || { echo "✖ scoped key answered $CODE on a version without access control"; exit 1; }
fi
