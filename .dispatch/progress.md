# CLI coverage lane progress

## Checklist

- [x] Read the existing suites in `apps/cli/src/__tests__` and plan extensions in those files.
- [x] Measure the starting coverage with `node scripts/unit-coverage.mjs --project cli`.
- [x] Work file by file in descending order of uncovered lines; commit each file or coherent group at target.
- [x] Cover error and rejection branches, not only happy paths.
- [x] Reach at least 95% line coverage for `apps/cli/src/**`.
- [x] Run `pnpm check`, `pnpm typecheck`, and `pnpm test` successfully.
- [x] Write `.dispatch/DONE` with the final percentage.

## What I just did

- Inspected all existing CLI suites and their covered source areas; future tests will extend the current files rather than add parallel suites.
- Ran the required baseline command. It produced `0.76%` line coverage (`30/3911`) with tests failing during collection because workspace `@opentag/client` and `@opentag/shared` build entries were absent in this checkout.
- Built the workspace to restore those generated package entries, then reran the command successfully: `77.65%` line coverage (`2547/3280`) for the CLI project.

## Next

- Added behavior-focused tests to the existing suites for daemon service shared and platform backends, daemon runtime and command wrappers, computer connect, doctor, session, and agent flows. The suites include rejected operations, malformed state, unsupported platforms, ownership conflicts, and credential/configuration failures.
- The current CLI coverage command reports `95.94%` line coverage (`3147/3280`), above the required floor.
- Final verification passed: `pnpm check`, `pnpm typecheck`, `pnpm test`, and `node scripts/unit-coverage.mjs --project cli`.
- Final coverage evidence: `95.94%` CLI line coverage (`3147/3280`).

## Decisions and evidence

- No production edits are planned unless a specific branch is genuinely untestable; tests remain inside `apps/cli/src/__tests__`.
- The initial coverage percentage is not a valid behavioral baseline because 14 suites failed to resolve workspace package entries; it is recorded for traceability, not treated as progress toward the 95% floor.
- The usable baseline is 77.65%; the report lists 733 uncovered lines across 3280 measured lines. Platform-specific backends must be tested with injected runners/temp paths as required by the task.
