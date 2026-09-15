---
name: test-runner
description: Delegate OpenTag test execution to the low-cost test_runner subagent and return concise, actionable failures.
---

# Test Runner

When validation requires running a test command, delegate it to the `test_runner` subagent. Do this for targeted tests during implementation and for required repository checks before completion. Do not run the test suite in the parent context unless subagent delegation is unavailable.

Tell the subagent which command to run and why that scope is appropriate. Follow `AGENTS.md`: run directly affected tests while developing, then run all required checks before opening a pull request. Ask it to run one command at a time when later commands depend on earlier output.

The subagent must not change source files. It returns the command, exit status, and a compact failure report. Use a passing result as validation. On failure, inspect the returned test name, file, assertion or error, and excerpt; fix the code in the parent context, then delegate the relevant rerun. Treat setup, toolchain, and service failures separately from test failures.
