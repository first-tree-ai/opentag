# obs-foundation-1 progress

## Checklist

- [x] 1. `redactForLog` + `STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES` in shared, exported from `src/index.ts`
- [x] 2. Named `structured-errors.js` export line in `packages/shared/src/browser.ts` + shared snapshot updated
- [x] 3. Tests: string-value byte cap, shared public-exports green, web entry chunk under budget
- [x] 4. `packages/server/src/observability/service-logger.ts` + exported from `observability/index.ts`
- [x] 5. Exactly one `serviceLogger` wiring line in `packages/server/src/index.ts`
- [x] 6. `OPENTAG_LOG_LEVEL` in `config.ts` (strict schema) + `level` on the Fastify logger
- [x] 7. `requestIdHeader` + `genReqId` + `x-request-id` response echo + extended `request-logging.test.ts`
- [x] 8. `createServerDiagnosticReporter` widened to `(code, context?)`
- [x] 9. `recordSpanError` accepts and records the real error
- [x] 10. Client logger context + dual destination + string-value scrubbing + rotation time floor
- [x] 11. `WORKSPACE_ID` attribute, docs (+ zh-CN mirrors), Docker log driver caps

## Current work

- Baseline checked: clean `feature/obs-foundation` worktree at `bda5a7a1`, tracking `origin/main`.
- Shared redaction now caps recursively redacted string values at 4 KiB UTF-8 and is available from both package barrels; the focused shared suite and Web build pass, with the Web entry chunk below the 600 KiB budget.
- Shared and server foundations are committed (`d0cb63ac`, `e3b89f9c`). Focused request, observability, service-logger, and type checks pass. The existing span contract requires generic `INTERNAL_ERROR` status while the exception event now carries scrubbed error type/message.
- A follow-up extracted Fastify logger option construction from `createApp`; the complexity ratchet now passes for this changed function without altering business behavior.
- Client logger work is committed (`6e50e246`); its focused logger, rotation, public-export, and type checks pass (16 tests).
- Item 11 vocabulary, English/Chinese documentation, and Docker caps are implemented locally; the docs unit is next.
- `pnpm check` now passes after extracting logger option construction from `createApp`; it reports existing complexity diagnostics as warnings and the complexity ratchet passes.

## Decisions / deviations

- None.
