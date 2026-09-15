#!/bin/sh
set -eu

export HOME="${HOME:-/home/runner}"
export TMPDIR="${TMPDIR:-/tmp}"
export PATH="${PATH:-/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin}"
cd "${OPENTAG_WORKSPACE:-/workspace}"

if [ "$#" -eq 0 ]; then
  exec /usr/local/bin/opentag-runner
fi

exec "$@"
