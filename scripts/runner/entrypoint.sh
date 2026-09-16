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

# Only the exact long-lived Instance command keeps root: the native Cloud Run sandbox launcher
# requires the parent process to run as root. serve still runs under the source-owned PID 1 init
# so orphan reaping and signal forwarding never repeat the #630 zombie class.
if [ "${1:-}" = "opentag-runner" ] && [ "${2:-}" = "serve" ]; then
  if [ ! -x /usr/local/bin/opentag-init ]; then
    echo "runner-entrypoint: opentag-init is missing; refusing to run serve without the source-owned init" >&2
    exit 1
  fi
  shift 2
  exec /usr/local/bin/opentag-init /usr/local/bin/opentag-runner serve "$@"
fi

# Every non-serve command is unprivileged: uid/gid 10000 with supplementary groups cleared. The
# absolute path is supplied by the digest-pinned base image (util-linux) and asserted at build
# time; a missing binary must fail closed instead of silently running the command as root.
if [ "$(id -u)" -eq 0 ]; then
  exec /usr/bin/setpriv --reuid=10000 --regid=10000 --clear-groups -- "$@"
fi

# Already non-root: never elevate, keep the established direct-exec behavior.
exec "$@"
