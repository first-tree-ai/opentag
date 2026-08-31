## Summary

<!-- What changed, and why? -->

## Testing

<!-- List the commands and manual checks you ran. -->

## Risk review

- [ ] Affected packages: <!-- List packages, apps, or repository areas. -->
- [ ] Contract changes: <!-- Describe shared schema or API changes, or write "None". -->
- [ ] Migration and rollback: <!-- Record migration impact and the rollback plan, or write "None". -->
- [ ] Test layers exercised: <!-- List unit, integration, E2E, or manual layers. -->
- [ ] Observability impact: <!-- Record logs, metrics, traces, or write "None". -->
- [ ] Generated files touched: <!-- List generated files, or write "None". -->
- [ ] Deployment evidence: <!-- Link CI, deployment, and live verification evidence, or write "None". -->

## Maintainer branch rules (GitHub settings)

- [ ] Require the branch to be up to date before merge (strict).
- [ ] Dismiss stale approvals when new commits are pushed.
- [ ] Require approval from someone other than the last pusher.
- [ ] Require all review conversations to be resolved.
- [ ] Require cross-owner approvals for changes spanning owned seams.

## Breaking changes

<!-- Describe compatibility impact, or write "None". -->

## Checklist

- [ ] The change is focused and contains no unrelated work.
- [ ] Tests and documentation cover the changed behavior.
- [ ] `pnpm check`, `pnpm build`, `pnpm typecheck`, and `pnpm test` pass.
- [ ] No credentials, private data, or generated build output are included.
- [ ] Canonical English docs and Chinese mirrors are synchronized when applicable.
