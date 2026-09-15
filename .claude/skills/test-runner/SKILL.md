---
name: test-runner
description: Delegate OpenTag test execution to a low-cost subagent and return concise, actionable failures.
context: fork
agent: test-runner
background: false
user-invocable: false
---

Run the validation requested in the current task using the repository test guidance in `AGENTS.md`.

Choose the narrowest affected test command during implementation. Before a pull request, run every required check listed in `AGENTS.md`. Run one command at a time when later commands depend on earlier output. Do not edit source files or attempt fixes.

Return the command, exit status, elapsed time when available, and a compact failure report. For every failure, include the test or stage, source file when known, assertion or error, and smallest useful output excerpt. State whether a failure is environmental or a test failure. Keep all other output out of the report.
