#!/usr/bin/env bash
# E1-only local Slack CLI substitute. Answers probes and auth.test. Never calls Slack.
set -euo pipefail
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-update) shift ;;
    --config-dir)
      shift
      if [[ $# -gt 0 ]]; then shift; fi
      ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd="${args[0]:-}"
sub="${args[1]:-}"
if [[ "$cmd" == "version" || "$cmd" == "--version" ]]; then
  echo "Using slack v4.7.0"
  exit 0
fi
if [[ "$cmd" == "api" && "$sub" == "--help" ]]; then
  echo "slack api <method>"
  echo "  auth.test"
  exit 0
fi
if [[ "$cmd" == "api" && "$sub" == "auth.test" ]]; then
  cat <<'JSON'
{"ok":true,"url":"https://e1-local-pi.example.invalid/","team":"E1 Local Pi Fixture","user":"opentag-e1","team_id":"T0E1LOCALPI","user_id":"U0E1LOCALPI","bot_id":"B0E1LOCALPI"}
JSON
  exit 0
fi
echo "opentag e1 local-pi slack substitute does not call Slack" >&2
exit 1
