# Agent Runtime contract: verification and acceptance

Test and acceptance material for [Agent Runtime contract](../../docs/system/runtime/agent-runtime-contract.md).

## Verification

The required CI coverage command is:

```bash
pnpm --filter @opentag/client test:agent-runtime:coverage
```

It enforces 100% statements, branches, functions, and lines over the common
contract, all Provider adapters and wires, shared process ownership, and the
production Agent Runtime composition path. Live Provider tests remain explicit
because they use installed user credentials and make real model requests.

## IM instruction placement

`agent-turn-runner.test.ts` bounds representative Slack and Feishu per-Turn managed context below
3 KiB while retaining provider-native references, attention/reply-role behavior, the adjacent outbox
reminder, and the original message. Static CLI manuals, Git/GitHub guidance, duplicate Agent identity,
and empty Session instruction placeholders are absent from those inputs. The existing observer and
explicit Session instruction cases preserve their behavior.

`managed-instructions.test.ts` verifies both provider manuals and attachment guidance in Local and
Cloud visible Session system prompts, and excludes IM outbox manuals from internal Sessions.
`provider-outbox-instructions.test.ts` retains the native CLI, attachment, credential-handling,
multiline-body and Slack guidance bounds. `session-message-inbox.test.ts` checks compact visible
callbacks with their default provider outbox targets.

The Local Session runtime restart regression resumes the same stored Provider binding with the CLI
manuals in its system prompt. The Cloud two-Turn continuity regression similarly retains the Pi UUID
and session directory while passing those manuals through `--append-system-prompt` on both creation
and resume. These use isolated adapters/fixtures and do not claim live Provider or production
acceptance.
