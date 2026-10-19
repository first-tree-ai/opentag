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
