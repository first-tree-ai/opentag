# Internal Session collaboration

[简体中文](./zh-CN/internal-session-collaboration.md)

OpenTag Agents delegate work through the CLI available inside every managed Session:

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session list
```

The current source Session is implicit. The Runtime supplies a managed proof file and the CLI reads the Server binding
from `OPENTAG_HOME/config/computer.json`; callers cannot pass an Agent or source Session identity. The proof is bound to
the current Session, placement generation, Computer connection, and Client connection. Reconciles for the same binding
reuse the same proof, including retries after a timeout or lost response. Placement, connection, Agent, or IM-binding
changes invalidate the old proof.

All Provider processes launched by one daemon OS user currently form one trust domain. File permissions protect proof
files from other OS users and accidental exposure, but do not isolate sibling Sessions running as that same user. Until
OpenTag introduces per-Session OS or container isolation, the proof lets the Server validate a live Runtime binding and
removes caller-selected source flags; it is not a security boundary against a compromised sibling Session that can read
the daemon user's files.

`session create` atomically creates an internal child Session and its first message. `session send` addresses an
existing Session in the same Agent and conversation scope. Both accept an optional `--message-id` for an explicit retry;
reuse the same ID and identical semantic input after an uncertain result. `accepted` means the target accepted the
message into its bounded FIFO, not that the task completed.

`session list` returns direct children by default, ordered by recent message activity. Pages default to 20 items and
are capped at 100; `--cursor` continues a page, `--recursive` includes descendants, `--since` filters recent activity,
and `--json` returns `{ items, nextCursor }`. There is no unbounded `--all` mode.

Internal Sessions share their Agent's tools, MCPs, workspace, and default Runtime configuration. A creation command may
override the model, reasoning effort, or maximum Run duration. Internal Sessions do not receive IM delivery or the
temporary `OPENTAG_PROVIDER_ENV_FILE`; they report through `opentag session send`. Both visible and internal Sessions
receive role-aware managed instructions and may create further internal Sessions.

OpenTag internal Sessions are distinct from Provider-native subagents. When a person explicitly requests an OpenTag
internal Session, the visible Session uses `opentag session create` rather than substituting a Provider-native subagent.
OpenTag does not otherwise impose one automatic routing policy between direct work, Provider-native subagents, and
internal Sessions.

When a SessionMessage returns to a visible channel or thread Session, that callback Run retains the visible Session's IM
authority. Credential grant v2 atomically supplies a temporary provider credential environment and a non-secret default
outbox context derived by the Server from the Session's existing conversation scope. The visible Session synthesizes and
publishes any user-facing result through the official provider CLI during that callback Run; OpenTag does not forward the
child's text automatically. Channel callbacks target the existing chat or channel, while thread callbacks retain the
existing thread scope. Internal targets never receive provider credentials or outbox context.

Session collaboration is real-time and best-effort, not a persistent job queue. The Server stores authorized logical
messages and their latest observed outcome for idempotency and conflict detection, while target delivery remains an
in-memory bounded FIFO with no automatic replay. Agent-facing Session operations intentionally provide no `end`;
administrative lifecycle invalidation may still set the existing `sessions.ended_at` field. Retention is out of scope.

This CLI surface requires `runtime.sessionCollaboration` capability version 2. Visible callback delivery also requires
`runtime.imCredentialGrant` version 2. A new Server reports `outbox_unavailable` before delivery when the target Client is
older; a new Client connected to an older Server rejects the delivery before acknowledging it so the same logical message
remains retryable. Both upgrade directions fail closed before the callback Run instead of silently removing its IM outbox.

OpenTag currently supports this path only with a single Server replica. `OPENTAG_RUNTIME_REPLICA_MODE` defaults to
`single`, and the Server claims a PostgreSQL session advisory-lock lease before startup. A second live instance fails
closed with an actionable lease-held error; clean shutdown releases the lease so the deployment can restart. The
`/healthz` and `/readyz` responses expose `runtimeOwnership.mode`, `runtimeOwnership.status`, and the owning
`runtimeOwnership.instanceId`. Proof-authenticated Session CLI HTTP and source/target SessionMessage Runtime delivery
both use that replica's local WebSocket owner. When a request reaches an instance that does not own the connection, it
returns the structured `RUNTIME_OWNER_ELSEWHERE` code. Ordinary multi-replica load balancing, sticky routing, and
cross-replica owner discovery, forwarding, or delivery relay are not supported; horizontal replicas require an
explicit cross-instance owner-routing design before they can be enabled.
