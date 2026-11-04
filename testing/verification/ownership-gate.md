# Ownership gate verification

Supports [ownership gate reconciliation](../../docs/operations/ownership-gate.md).

## Local checks

```sh
node --test scripts/__tests__/ownership-gate*.test.mjs scripts/__tests__/check-ownership-policy.test.mjs
pnpm check
```

The concurrency tests parse the real workflow and model GitHub's documented
single-active-writer guarantee. They use the actual evaluator, HTTP retry client,
and status publisher with synthetic API responses and virtual time; they never
call GitHub or wait through real rate-limit delays.

- A negative control reproduces an uncoordinated sweep overwriting a newer
  failure with its earlier success after a rate-limited POST.
- A competing event arrives after the success read and before each of the four
  POST attempts, under both 403 and 429 responses. The exclusive slot holds
  through all three backoffs; the event reads the dismissal only after the
  sweep's final write and leaves the final status at failure.
- Multiple heads queue without replacing one another, and a queued numbered
  event reads its current head after it advances.
- Existing review dismissal, author self-review, bot/external-author, and
  shared-head rules remain covered.

The pinned actionlint version predates `concurrency.queue`. Its configuration
filters only that exact unknown-key diagnostic for the ownership gate workflow;
the parsed-YAML regression test strictly checks the queue configuration and the
narrow diagnostic filter. Other workflow diagnostics remain enabled.

## Platform boundary

These tests validate the workflow configuration and synthetic interleavings,
not GitHub Actions' scheduler implementation. They do not establish live queue
behavior, deployment, branch protection, or merge acceptance. No remote workflow
is dispatched or rerun by this verification. After a reviewed merge, normal
workflow activity can provide live evidence without replaying tasks or altering
rulesets. Older workflow revisions already in flight remain outside the new
group and must not be counted as serialized by it.
