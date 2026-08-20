# Runtime Configuration

## Product Contract

Runtime Configuration is Agent-owned desired state. It is not a Workspace Resource and it does not create a second
Session configuration model.

The v0.1 management surface contains three execution choices:

- `model`: an exact Provider-native model identifier, or `null` to let the Provider manage model selection;
- `reasoningEffort`: a Provider-native reasoning value, or `null` to let the Provider manage reasoning;
- `maxDurationMs`: one Turn's maximum wall-clock duration, or `null` to use OpenTag's 30-minute default.

"Managed by provider" intentionally does not promise a particular default model or a reset of Provider-persisted state.
Providers differ in how they restore an existing session when a selection is omitted. OpenTag guarantees only that it
does not send an OpenTag override.

The Web form accepts an exact model ID, offers Provider-specific reasoning suggestions without treating them as an
authoritative compatibility matrix, and presents duration in seconds while preserving the millisecond API contract.
Team Admins may save desired configuration while the bound Computer is offline. Compatibility is checked when the
Client prepares the Provider Runtime.

## Authority and Application

- The Server authorizes and persists the Agent configuration and resolves the Effective Runtime Snapshot.
- The bound Client reports current execution readiness and validates Provider-specific values.
- Provider adapters map explicit model and reasoning values to their native protocol. Unsupported explicit values fail
  visibly; OpenTag does not silently replace them.
- A model or reasoning value reported by a Provider is observation, not a second source of configuration truth.
- Exact resume preserves the Provider conversation binding, not an old OpenTag configuration snapshot. The Client
  reapplies the current snapshot when it creates or resumes a Runtime.

The existing Agent `expectedRevision`, Runtime Configuration revision, and Effective Snapshot hashes remain the only
configuration fences. An active Turn keeps the snapshot admitted for that Turn. A newer configuration is reconciled
after the active Turn settles; it does not mutate a Provider Run in flight.

## Duration and Failure Semantics

The common Client Turn runner owns duration enforcement. The effective timeout is:

```text
min(configured-or-default Turn duration, absolute delivery deadline)
```

The shared OpenTag default is 30 minutes and the maximum configurable duration is 24 hours. A timeout aborts the
Provider Run and reports `turn_timeout`. The result records that external execution effects may already have occurred;
timeout is not a transaction rollback.

Invalid syntax is rejected by the shared API schema. Provider-specific incompatibility is rejected by the Client during
reconciliation or by the Provider when the Run is admitted. A failed configuration remains desired state until an Admin
changes it; the Client must not fall back to a different explicit model or effort.

## Test Plan

Deterministic product tests cover:

1. Web rendering of provider-managed values, exact model input, reasoning suggestions, and the 30-minute duration
   default;
2. conversion between Web seconds and API milliseconds, including explicit values and restoring inherited defaults;
3. rejection of sub-millisecond, non-finite, zero, negative, and over-24-hour duration input before an API write;
4. Agent API optimistic concurrency and nullable model/reasoning update semantics;
5. Effective Snapshot hashes changing when model, reasoning, or duration changes;
6. Client Runtime create/resume receiving explicit model and reasoning configuration;
7. active-Turn configuration fencing and replacement only after Turn settlement;
8. duration/deadline minimum selection and stable `turn_timeout` reporting.

The repository's existing Server, shared-domain, Session Runtime, reconciliation, and Turn runner suites already cover
items 4 through 8. This change adds focused Web tests and makes the shared default-duration assertion explicit.

## Non-goals

The v0.1 feature does not add a Server-owned model catalog, an account/model compatibility matrix, Session or Turn
overrides, token or monetary budgets, Provider-specific service tiers, hot model switching, or a guarantee that every
Provider can echo the effective model. Those capabilities require separate product decisions.
