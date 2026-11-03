# Context-token audit

Issue: [#1121](https://github.com/first-tree-ai/opentag/issues/1121). Source baseline:
`bb1d4e104d5577173ef237e2111bc48777acb0d9` (2026-11-03).
Contract: [Agent Runtime](../../../docs/system/runtime/agent-runtime-contract.md#context-composition-and-token-interpretation).

**PARTIAL:** source inspection and an offline synthetic reproduction are complete. No new-release
real Session sample was supplied or retrieved. The original user's cost regression, cache hit rate,
and savings remain unproven. No production behavior, history, persistence, billing, or logs change
in this audit. No provider/model API, real IM task, deployment, or online database was used.

## Reproduce

```sh
pnpm exec tsx --tsconfig scripts/tsconfig.scripts.json scripts/performance/context-token-audit.mts
pnpm exec tsc -p testing/performance/context-tokens/tsconfig.json
```

The [harness](../../../scripts/performance/context-token-audit.mts) calls the real managed-prompt
and IM-input builders and Claude bridge with synthetic
identities, a synthetic Skill, and an `.invalid` gateway. It creates private temporary files, opens
no listener, makes no HTTP request, starts no provider, and removes its files on exit. It asserts
prompt stability, repeated Session instructions, namespace churn, and provider total-token rules.
[synthetic-results.json](synthetic-results.json) records its output. Random names and temporary
paths are represented by comparison booleans; raw configuration and credentials are not emitted.

The token estimate is `ceil(UTF-16 code units / 4)` for this mostly English fixture. It is a sizing
heuristic, **not a model tokenizer, provider usage, billing measurement, or context-window count**.
Section estimates are rounded independently and need not sum to the rounded prompt estimate.

## What the measurements mean

| Quantity | Meaning and valid evidence |
| --- | --- |
| OpenTag input | The new `AgentInput`, not the complete provider request. |
| Provider request input | Native base instructions + managed instructions + project context/catalogs + active history + current input + tool results/images, after native formatting/compaction. OpenTag does not observe every provider's final rendered request. |
| Cache read | Already processed prefix tokens reused by the provider, still part of model context. Continuity is necessary for history but is not a cache guarantee. |
| Cache write | Newly cached tokens; rates and lifetime depend on provider/model/route. This is not an extra copy in the active context. |
| Billed cost | Usage categories multiplied by their corresponding rates and pricing rules. Local totals do not establish an invoice. Cloud uses Router usage and the billing ledger. |
| Effective context | The current model input after native transforms/compaction. Summing input usage over many calls counts reused history repeatedly and is not a context-window measurement. |

One OpenTag Turn can contain many model calls and compaction calls. Compare per-call usage first,
then sum only the calls owned by that Turn. A single total cannot establish repeated injection.

## Injection boundaries

| Component | Actual boundary | Variation / evidence |
| --- | --- | --- |
| Native base prompt | Claude/Pi append the managed prompt; Codex uses `developerInstructions`. Native base prompts and host configuration add their own input. | Installed CLI versions, native configuration, tools and model. Not included in synthetic sizes. |
| Managed instructions | `renderManagedSystemPrompt`: Platform, Agent, native configuration guidance, GitHub, IM outbox manuals, Home/Skills/self-configuration where applicable, MCP onboarding, Session facts, Slack provisioning, attention policy, Tree status and Session instructions. | Rebuilt on Local runtime start, cached in the runtime; rebuilt each Cloud Turn. Same facts produce the same bytes. |
| Per-delivery input | `buildAgentInput`: dynamic facts and timestamp, Session instructions, current text, optional history, supplemental and resource context. | Timestamp is in the **new message**, not the managed system prompt. Platform/Agent bodies are not appended again here. |
| Native history | Each provider owns its Session/thread transcript. Tool output and read files can become large; native compaction can replace earlier context. | Restored through native bindings, not reassembled from all OpenTag Session messages. |
| IM history supplement | `loadDirectHistory` selects prior IM messages after the previous accepted/steered boundary, with thread-root handling, deduplication, a 100-item and 40 KiB budget. | It is not the full provider transcript. Thread roots follow the same acceptance boundary; queued/ambient messages may be new to the model. |
| Context Tree | `prepareContextTree` / Cloud preparation supplies location/status/guidance; the Agent reads relevant pages with tools. | Cloud's system text contains ready Tree commit (first 12 hex digits), path, and availability. A changed value can rewrite the prefix before history; sync itself does not inject all pages. |
| Skills | Native metadata/catalog plus explicit body/resource reads. Claude wraps packaged Skills in a native plugin and skips already-native Skill directories. | Catalog names, descriptions, locations and order may affect the prompt. Skill body reads remain in native history until compaction. |
| MCP | Native catalog, tool description/schema or Pi proxy discovery, followed by tool calls/results. | Claude private names change per Run; Codex private name changes per runtime creation; Pi Local private registration is randomized, while Cloud uses `opentag-mcp`. Credentials and endpoints belong to execution configuration, not an instruction to put secrets in model context. |
| Collaboration / schedules | `buildSessionMessageInput`, including schedule metadata where supplied. | Different envelope from ordinary IM. The numeric fixture below covers visible IM only. |

Source owners: `packages/client/src/runtime/{managed-instructions,agent-turn-runner,session-message-inbox}.ts`,
`packages/client/src/providers/{claude-code,codex,pi}/agent-runtime.ts`,
`packages/client/src/providers/claude-code/{hosted-tool-bridge,skill-plugin}.ts`,
`packages/client/src/pi-extensions/mcp-gateway.ts`,
`packages/server/src/runtime/im-delivery-custody.ts`, and `packages/shared/src/runtime-domain.ts`.
Installed Pi sources are `@earendil-works/pi-coding-agent@0.84.2` (`core/system-prompt.js`,
`core/skills.js`) and its locked `@earendil-works/pi-ai@0.84.4` (`api/openai-completions.js`).

## Same-Session continuation

| Runtime | Local | Cloud |
| --- | --- | --- |
| Claude Code | Fresh process per Run, `--session-id` then `--resume` with exact ID, `--append-system-prompt`. Native project/user/local settings remain available. | Not used. |
| Codex | Prepared runtime owns App Server and thread. `turn/start` appends input. Gateway/socket changes can `thread/unsubscribe` then `thread/resume` the same ID. `excludeTurns` reduces RPC response bytes, not model context. A never-used thread can be replaced before its first Turn. | Not used. |
| Pi | Fresh RPC process per Run with bound `--session-id`. Restoration checks prevent a materialized binding silently accepting empty history. Native Local resources enabled. | Fresh worker/Pi process per Turn, exact saved binding and Session files under `.opentag/pi-session`; replacement recovers saved archive. `openai-completions` sends active history, without a Responses `previous_response_id`. Ambient context files/resources disabled; packaged resources are added explicitly. |

`SessionRuntimeManager.ensureRuntime` reuses a live Local runtime. An unchanged effective snapshot
retains the durable native binding. A valid changed Local configuration creates a new provider
conversation without replaying history. Cloud keeps the saved Pi binding even when current model
or instructions change (covered by `cloud-context-continuity.test.ts`). Model/configuration changes
therefore have different continuity semantics and must be separated from an unchanged-session sample.
Revision identifiers participate in Local snapshot hashes; they are not wall-clock timestamps that
advance automatically on every message. Placement changes, shutdown/recovery, compaction, and native
resource edits must be recorded as distinct events in a real analysis.

## Synthetic composition

Fixture: visible Feishu IM Session; self-configuration and Session CLI enabled, no Tree, minimal
Platform/Agent text, a 67-character Session instruction, no ambient resources or prior history.

| Managed prompt only | Exact UTF-8 bytes | Rough English tokens |
| --- | ---: | ---: |
| Local Claude Code | 24,040 | 6,002 |
| Local Codex | 24,100 | 6,017 |
| Local Pi | 22,986 | 5,738 |
| Cloud Pi | 22,023 | 5,499 |

The major fixed sections are the IM outbox manual (9,785 bytes / ~2,445), MCP onboarding (3,757 /
~935), and Slack provisioning (2,577 / ~645). Their presence follows the existing capability/session
conditions, not the provider of the current inbound message. Other configurations, internal Sessions,
disabled capabilities, actual user instructions, and catalogs change these numbers. **These are not
four real Session samples or four complete model request sizes.**

The fixture's new input has a 1,421-byte managed envelope (~356) and 28-byte message (~7). Changing
only processing time changes the envelope after 233 UTF-16 code units; it leaves the existing
system prompt and old messages alone. Comparing two *new inputs* is not comparing two complete
native request prefixes. Changing Cloud's Tree SHA changes managed system text after 21,823 code
units in the synthetic ready-tree variant. No provider cache alignment or hit rate is inferred
from this character offset.

## Confirmed facts and remaining hypotheses

1. **Confirmed repeated instruction:** nonempty `instructions.session` occurs in the system prompt
   and each ordinary IM input. Size grows with user Session instructions and Turn count. Repeating
   text in an appended message is extra context, but does not prove all older input is uncached.
2. **Confirmed naming churn:** two calls to the real Claude bridge with the same Skill and gateway
   produce different plugin identities and gateway namespaces, with identical Skill bodies. The
   runtime calls this bridge for every Run. Existing bridge tests explicitly require unique Run
   names to avoid native-plugin collisions. This is a candidate cause of catalog/prefix churn,
   **not proof of a cache miss in the affected user's native request**. Claude's final catalog and
   actual cache counters were not captured.
3. **Confirmed fixed prompt size:** managed instructions alone have the sizes above. This is a
   measurable optimization target, not evidence that all these tokens are charged at uncached
   rates each Turn.
4. **Conditional prefix changes:** Cloud Tree status/commit changes alter the system text; native
   catalogs/resource edits, model switches, and compaction can change other prefix components.
   Identical Tree status/facts do not change the rendered managed prompt. Cloud does not add a
   new processing timestamp to that system prompt.
5. **Not established:** a universal failure to resume, repeated injection of the entire Tree,
   abnormal cache hit rates, a billing overcharge, the reported user's root cause, or a savings
   percentage. No runtime optimization is implemented before the gated design decision below.

## Usage normalization and billing

`parseUsage` in Claude maps `input_tokens + cache_creation_input_tokens` to runtime `inputTokens`
and keeps `cache_read_input_tokens` separate. Pi maps `input + cacheWrite` and separate `cacheRead`,
accumulating assistant calls and successful compaction usage for the Run. Codex prefers
`tokenUsage.last` over `total` and its input already includes cached tokens; its report must not
be presumed to be a sum of every model call in a multi-call Turn without checking native events.

`runtimeUsageTotalTokens` therefore adds cached input for Claude/Pi but not Codex. The harness's
synthetic `{inputTokens:1000,cachedInputTokens:800,outputTokens:50}` displays 1,050 for Codex and
1,850 for Claude/Pi. These identical numbers represent different provider-normalized categories,
not a cost comparison. Local reports fold cache writes into input and cannot recover the write
category or its price from those fields alone. Missing usage is missing evidence, not zero cost.

Cloud's strict `CloudModelRequestSchema` accepts the pinned Chat Completions request shape, not
Responses conversation or prompt-cache controls. Implicit provider caching can still work; an
absent `prompt_cache_key` alone is not proof of disabled caching. Router usage is normalized to
total input, cached reads, cache writes, and output. `CloudCallUsageSchema` requires
`cachedInputTokens + cacheWriteInputTokens <= inputTokens`; ordinary input is the remainder.
Cloud billing is a separate hosted module. The audit did not inspect an invoice or certify its
pricing. Request `cache-control: no-store` headers govern HTTP caching, not model prompt caching.

Provider references (checked 2026-11-03):

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): matching
  rendered prefixes and compatible settings permit reuse; Session continuity alone does not
  guarantee it. Cached tokens remain input/context, with category-specific rates.
- [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  cache reads, cache creation and ordinary input are distinct usage categories; tool/system/message
  changes and cache eligibility matter. Do not transfer one model's threshold, TTL, or rate to another.

## New-release sample gap and acceptance protocol

No consented, redacted post-release Session export is attached to the Issue. The existing
`ErrorReportRequest` reports failures and attribution, not complete prompts, per-call usage,
cache counters, or a representative successful-session sample. `AgentTrace` and Turn reports are
different surfaces, and Cloud totals use a separate model-call ledger. Error reporting being on
does not establish that the requested data exists or authorize creating new prompt telemetry.

For an existing authorized export, select at least: a short unchanged Local Session (prefer Claude
with stable MCP/Skills), a tool-heavy unchanged Local Session, and an unchanged Cloud Pi Session.
Collect at least three consecutive Turns each, preserving the first cold call and later calls.
Record actual release/build and runtime CLI versions, environment/model/route, redacted Session,
Turn and native binding IDs, timestamps/intervals, all model-call usage categories, compaction and
retry events, configuration/catalog changes, and missing fields. Compare same-model/route samples;
never combine cached read/write categories or fill unknown values with zero.

Component byte/token counts or prefix comparisons require authorized access to the relevant native
input, or an already-approved export. If they are unavailable, mark composition or cache diagnosis
PARTIAL even when Turn totals exist. Keep raw messages, credentials, tool output and private IDs out
of this public repository. Prefer aggregate sizes and semantic equality markers over prompt text.
No new collection, stored hashes, logging fields, SQL path, retention policy, or model experiment is
approved by this protocol; any such design needs separate human confirmation.

## Reviewable optimization proposals (not implemented)

**A — stabilize Claude names within one runtime lifetime (recommended first).** Allocate the
private plugin/server identity once in `ClaudeCodeAgentRuntime`, then pass it to each Run bridge.
Keep temporary paths, loopback ports, credentials and cleanup scoped to each Run. Each runtime
still receives a distinct identity, and a restart can choose a new one. Native user/plugin/MCP
configuration remains additive; no fixed global name is reserved. No schema, persisted namespace,
binding, history, retention, permissions, or gateway authorization changes. This changes native
catalog identity across Turns and needs explicit approval before implementation. Verify same
runtime/same catalog yields stable names, concurrent runtimes remain isolated, token rotation and
failed-run cleanup work, and native Skills/tool names still resolve. Exact cache savings remain a
separate acceptance test.

**B — one authoritative copy of Session instructions.** After approval, keep Session instructions
in the managed native system prompt and remove the ordinary IM duplicate. Preserve dynamic
attention, reply-role, time and provider facts. Audit internal/collaboration/schedule paths and Local
configuration replacement versus Cloud restore before deciding their equivalent rule. No history
rewrite or replay; previously persisted messages retain their old contents. This changes instruction
placement/trust/refresh semantics and requires separate approval.

**C — shorten or lazily load manuals.** First review the measured IM/MCP/provisioning sections.
An approved design must specify which capability instructions stay mandatory, how discovery is
triggered, and how IM delivery, OAuth state handling and provisioning behavior remain reliable.
Do not remove safety/authorization instructions solely to reduce tokens. No savings claim until
representative tasks and cache measurements confirm it.

**D — Tree facts / history / telemetry.** Moving changing Tree facts from system to a new message,
trimming history, changing compaction/cache policy, persisting prompt hashes, or adding telemetry
are separate injection/consistency/read-write designs. No generic trim, new log, or new database
column is part of this proposal. Keep factual freshness and user context intact pending a concrete
design and approval.

## Follow-up deduplication and ownership

Read-only searches of all-state Issues (`cache in:title,body`, `token in:title`) and open PRs found
no separate Claude namespace or Session-instruction deduplication work item. Proposed split:

| Candidate | Scope / gate | Existing ownership |
| --- | --- | --- |
| A: stable Claude runtime catalog identity | The in-memory design above; needs approval; first implementation candidate. | #1121, this audit's owner. |
| B: remove duplicate Session instructions | Instruction placement and all input paths; needs approved semantics. | #1121, retain as proposal until A/sample results clarify priority. |
| Real sample analysis | Existing authorized post-release exports; no new collection. | #1121 remains open and PARTIAL. |
| Cloud stages and latency metrics | Do not recreate measurement framework. | #1108 / PR #1115, separate owner. |
| Startup improvements | Not a context-token fix. | #1112, separate owner. |
| Service/query/external-call logging | Not prompt telemetry; proposed logging design not extended. | PR #1117. |
| Live Tree selection changes | Coordinate if changing Tree injection/restart semantics. | #1088 / PR #1091, separate owner. |

No new follow-up Issue is created in this audit. Recheck live Issues/PRs before any later creation;
the deduplication snapshot is not a permanent claim that no duplicate exists.

## Validation

- Offline harness and its TypeScript check pass; all recorded measurements are synthetic.
- Ten existing targeted Client suites pass (316 tests): managed instructions, IM input, Session
  manager/bindings, Cloud continuity/worker, Claude bridge, and Claude/Codex/Pi adapters. The first
  attempt needed the Shared package build in this fresh checkout; the rerun passes.
- `pnpm check` passes with existing baseline warnings. The harness lives under `scripts/`, matching the
  existing tooling scope excluded from runtime patch coverage; it is formatted, executed and typechecked.
- Application builds, the full regression matrix, Agent Runtime coverage and PostgreSQL integration
  were not run: no shipped runtime implementation, covered tests, schemas, dependencies, or database
  behavior changed. The Shared build only supplies package exports for the existing Client tests.
- No live model/IM/cache-cost acceptance, new-release Session sample, deployment, merge, or billing
  reconciliation. The original Issue is not closed by this evidence PR.
