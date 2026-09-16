#!/bin/sh
set -eu

export HOME="${HOME:-/home/runner}"
export TMPDIR="${TMPDIR:-/tmp}"
export PATH="${PATH:-/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin}"
cd "${OPENTAG_WORKSPACE:-/workspace}"

if [ "$#" -eq 0 ]; then
  set -- opentag-runner
fi

# Normalize a bare `serve` (Cloud Run container args) into the full CLI invocation.
if [ "${1:-}" = "serve" ]; then
  shift
  set -- opentag-runner serve "$@"
fi

# serve is the long-lived Instance process: run it under the source-owned PID 1 init so orphan
# reaping and signal forwarding never repeat the #630 zombie class. Every other command keeps
# the established direct-exec behavior.
if [ "${1:-}" = "opentag-runner" ] && [ "${2:-}" = "serve" ] && [ -x /usr/local/bin/opentag-init ]; then
  shift 2
  exec /usr/local/bin/opentag-init /usr/local/bin/opentag-runner serve "$@"
fi

exec "$@"
