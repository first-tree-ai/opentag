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
the current Session, placement generation, Computer enrollment, and Client connection. Reconciles for the same binding
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

Session collaboration is real-time and best-effort, not a persistent job queue. The Server stores authorized logical
messages and their latest observed outcome for idempotency and conflict detection, while target delivery remains an
in-memory bounded FIFO with no automatic replay. Agent-facing Session operations intentionally provide no `end`;
administrative lifecycle invalidation may still set the existing `sessions.ended_at` field. Retention is out of scope.

This CLI surface requires `runtime.sessionCollaboration` capability version 2. Older Clients do not negotiate the
capability and do not receive a Session proof.

OpenTag currently supports this path only with a single Server replica. Proof-authenticated Session CLI HTTP and
source/target SessionMessage Runtime delivery both use that replica's local WebSocket owner. Ordinary multi-replica
load balancing, sticky routing, and cross-replica owner discovery, forwarding, or delivery relay are not supported;
horizontal replicas require an explicit cross-instance owner-routing design before they can be enabled.
