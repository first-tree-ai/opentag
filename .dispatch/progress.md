# OBS-01 progress

## Checklist

- [x] 1. Survey observability, server/client error patterns, and shared package structure.
- [x] 2. Add failing shared taxonomy and redaction tests first.
- [x] 3. Implement shared structured-error schemas and safe serialization; refresh exports snapshot.
- [x] 4. Implement and test the server background-failure supervisor.
- [ ] 5. Write `docs/error-taxonomy.md`.
- [ ] 6. Run `pnpm check`, `pnpm typecheck`, and `pnpm test`; clean the tree.

## Completed item

Item 1 found these current shapes and gaps:

- Shared API errors use `ErrorEnvelopeSchema`/`ErrorDetailSchema` with `code`, a small legacy `category` enum (`credential`, `deterministic`, `validation`, `transient`, `rate_limit`), `message`, optional `requestId`, retry-after, and validation issues. Client runtime errors are class-based (`AgentRuntimeError`, `AgentProviderError`) with string codes and causes; server services use multiple `*Error` classes and raw `Error` instances.
- Existing observability is mostly best-effort OpenTelemetry spans and bounded diagnostic-code callbacks. `diagnostics.ts` logs only a sanitized code and emits a root span; `otel-helpers.ts` has local key-pattern/string scrubbing. Persisted diagnostics and API errors remain separate contracts.
- Supervision is missing or narrow at detached boundaries: `ImDeliveryWorker.#schedule()` catches only to a code callback; `KeyedTaskScheduler` swallows task failures; runtime socket business tasks catch and return failure frames; Feishu connection/setup timers and lifecycle callbacks classify failures locally. These paths do not share a structured event, cause chain, redaction, or counter seam.
- The task checklist explicitly assigns `packages/shared/**` and `packages/server/src/observability/**`; the environment note saying not to touch shared is stale relative to that ownership and objective, so this lane follows the checklist.

## Next

The new `structured-errors.test.ts` covers taxonomy parsing, diagnostic-event envelopes, sensitive key/header/body/message redaction, cycles, and byte bounds. It was run first and failed at collection because `structured-errors.ts` did not exist, confirming the tests are red before implementation. The shared implementation now provides strict Zod schemas, recursive causes, key-pattern and string redaction, cycle/depth/collection bounds, and UTF-8 bounded JSON serialization. The public barrel and sorted export snapshot were refreshed. Shared typecheck and the full shared test command pass (18 files, 112 tests).

The server supervisor now exposes `supervise` for awaited operations and `track` for detached promises. It classifies thrown values into the shared taxonomy, captures bounded/redacted causes, emits one `DiagnosticEvent`, invokes a counter seam (`opentag.background_failures.total`), and sends only redacted payloads to the logger. Observer failures and invalid timestamps are isolated. Failure-injection tests pass (2 tests), and server typecheck passes.

Next write the canonical English taxonomy and adoption guide, then run the repository verification commands.

## Integration notes

- Runtime lanes should route detached scheduler, socket lifecycle, worker, and process-signal promises through the supervisor and pass phase/request context.
- Service/API lanes should map existing error classes into the shared `StructuredError` categories without leaking provider payloads or credentials.
