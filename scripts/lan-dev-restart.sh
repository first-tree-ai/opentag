#!/usr/bin/env bash
# Restart the LAN acceptance server.
#
# The web bundle's hashed filenames are registered as routes by `@fastify/static` with
# `wildcard: false`, which globs the dist root ONCE at registration. A rebuilt bundle therefore
# 404s every asset until this server restarts — the page's own `index.html` is served from a copy
# read at startup too. So: rebuild, then always run this.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${OPENTAG_PORT:-8010}"

# Kill whatever holds the port, by pid rather than by command-line pattern: the process is started as
# `node packages/server/dist/index.mjs`, so a pattern naming the repository path matches nothing and
# the old server silently keeps the port while the new one dies on EADDRINUSE.
for pid in $(ss -ltnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | sort -u); do
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 20); do
  ss -ltn 2>/dev/null | grep -q ":${PORT}" || break
  sleep 0.5
done
if ss -ltn 2>/dev/null | grep -q ":${PORT}"; then
  echo "Port ${PORT} is still held after SIGTERM; refusing to start a second server." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.lan.dev
set +a

# Rotate rather than truncate, so a reported problem can still be looked at afterwards.
if [ -f /tmp/opentag-lan.log ]; then
  mv /tmp/opentag-lan.log "/tmp/opentag-lan.log.$(date +%H%M%S)"
fi

setsid nohup node packages/server/dist/index.mjs > /tmp/opentag-lan.log 2>&1 < /dev/null &
started_pid=$!

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if grep -q "EADDRINUSE\|Failed to start" /tmp/opentag-lan.log 2>/dev/null; then
  echo "The server failed to start:" >&2
  grep -m 3 -o '"msg":"[^"]*"' /tmp/opentag-lan.log >&2 || true
  exit 1
fi

# Every asset the page references must resolve. This is the check that catches the stale-registration
# failure above, rather than reporting a healthy server with an unusable page.
missing=0
while read -r asset; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/${asset}")
  if [ "$code" != "200" ]; then
    echo "MISSING ${asset} -> ${code}"
    missing=1
  fi
done < <(curl -s "http://127.0.0.1:${PORT}/" | grep -oE '(assets/|icons/)[A-Za-z0-9._/-]+\.(js|css|svg|ico)' | sort -u)

if [ "$missing" -ne 0 ]; then
  echo "Asset check failed; the page will not load." >&2
  exit 1
fi

listening_pid=$(ss -ltnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1)
if [ "$listening_pid" != "$started_pid" ]; then
  echo "Expected pid ${started_pid} to be listening, but ${listening_pid:-nothing} is." >&2
  exit 1
fi

echo "OpenTag LAN server up on http://10.142.18.202:${PORT} (pid ${listening_pid}, assets verified)"
