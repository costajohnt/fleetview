#!/usr/bin/env bash
# Manual verification against a REAL opencode server. Not part of CI.
# Prereq: opencode installed and on PATH. Optional $1 = project dir (default: throwaway tmpdir).
set -euo pipefail
HOST=127.0.0.1
PORT=4999
DIR="${1:-$(mktemp -d)}"

echo "— starting server on :$PORT"
opencode serve --port "$PORT" --hostname "$HOST" &
SERVER_PID=$!
# ponytail: cleanup only ever targets $SERVER_PID — this script never touches
# any other roost/opencode server that might be running on the machine.
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 20); do
  curl -sf "http://$HOST:$PORT/project" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "— GET /project (all known projects, global — shared opencode.db)"
curl -sf "http://$HOST:$PORT/project" | head -c 400; echo

echo "— GET /session?directory=$DIR"
curl -sf "http://$HOST:$PORT/session?directory=$DIR" | head -c 400; echo

echo "— create + prompt_async, scoped to \$DIR"
SID=$(curl -sf -X POST "http://$HOST:$PORT/session?directory=$DIR" -H 'content-type: application/json' -d '{"title":"smoke"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -sf -X POST "http://$HOST:$PORT/session/$SID/prompt_async?directory=$DIR" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"say hi and stop"}]}' >/dev/null
echo "session: $SID"

echo "— rename (PATCH), scoped"
curl -sf -X PATCH "http://$HOST:$PORT/session/$SID?directory=$DIR" -H 'content-type: application/json' -d '{"title":"smoke-renamed"}' >/dev/null

echo "— tail scoped events for 15s; VERIFY: session.status busy→idle, and note the exact"
echo "  permission event names if a permission fires (feeds session-store mapping)"
curl -sN --max-time 15 "http://$HOST:$PORT/event?directory=$DIR" | grep -E 'session.status|permission' || true

echo "— attach manually to verify handoff:  opencode attach http://$HOST:$PORT -s $SID --dir $DIR"

echo "— delete (DELETE), scoped"
curl -sf -X DELETE "http://$HOST:$PORT/session/$SID?directory=$DIR" >/dev/null

echo "— done; cleanup will kill only this script's own server (pid $SERVER_PID)"
