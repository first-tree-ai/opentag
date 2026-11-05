# Release regression tests

Start at the [release regression catalogue](regression/README.md).

`regression/` is the maintained test-content directory here. It contains Markdown cases for the product's main
features, run before every release. This README routes readers to that catalogue.

Task-specific plans, acceptance results, screenshots, performance reports, local environment configuration and raw
validation evidence stay outside the source repository. Record useful findings and redacted results in the task's
GitHub PR or Issue, with source revision, commands, scope, outcomes and limitations. Automated unit, integration and
E2E tests remain with their owning packages, applications and tooling.

The rendered evidence already committed for the in-flight computer identity repair change remains available here:

- [Computer last-online rendered evidence](web-ui/computer-last-online/README.md)
