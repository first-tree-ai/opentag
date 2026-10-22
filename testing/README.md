# Testing

Test plans, acceptance harnesses, and recorded validation evidence for OpenTag. This material is kept out of the
[knowledge base](../docs/NODE.md): it describes how a change was or should be verified, not how the product works.
Each verification page links back to the knowledge-base page it supports. Keep credentials, production message
contents, and machine-specific operational logs outside the repository.

## Plans and harnesses

- [Agent Runtime Provider test plan](agent-runtime-test-plan.md)
- [Cloud Computer acceptance harness](cloud-computer.md)
- [Slack local live acceptance](slack-live-acceptance.md)

## Verification by feature

- [Account, Agent, and Computer management writes](verification/account-agent-computer-writes.md)

- [Agent Runtime contract](verification/agent-runtime-contract.md)
- [Agent Skills](verification/agent-skills.md)
- [Cloud billing](verification/cloud-billing.md)
- [Cloud Computer](verification/cloud-computer.md)
- [Cloud Context Tree and Session collaboration](verification/cloud-context.md)
- [Cloud Pi image input](verification/cloud-pi-image-input.md)
- [Cloud Runner execution](verification/cloud-runner-execution.md)
- [Cloud Runner toolchain](verification/cloud-runner-toolchain.md)
- [Cloud workspace persistence](verification/cloud-workspace-persistence.md)
- [Context Tree integration](verification/context-tree-integration.md)
- [Custom Slack Apps](verification/custom-slack-apps.md)
- [GitHub platform integration](verification/github-platform-integration.md)
- [GitHub OAuth cutover](verification/github-oauth-cutover.md)
- [IM delivery claim queries](im-delivery-claim/README.md)
- [IM Turn budget and recovery](im-turn-budget-recovery/README.md)
- [Steered IM custody without terminal reports](verification/im-steer-custody.md)
- [Provider process shutdown](verification/provider-process-custody.md)
- [IM content and attachment delivery](verification/im-content-delivery.md)
- [Inbound receipt recovery](verification/inbound-receipt-recovery.md)
- [MCP Server integration](verification/mcp-server-integration.md)
- [Release guide](verification/releasing.md)
- [Session collaboration writes](verification/session-collaboration-writes.md)
- [Session configuration transitions](verification/session-configuration-transitions.md)
- [Skill details reader](verification/skill-details-reader.md)
- [Installing Skills from a remote source](verification/skill-remote-install.md)
- [Slack installation lifecycle writes](verification/slack-installation-writes.md)
- [Staging onboarding reset](verification/staging-onboarding-reset.md)
- [Web App analytics](verification/web-analytics.md)
- [Web tools](verification/web-tools.md)
- [Web UI contract](verification/web-ui-contract.md)

## Web UI evidence

Screenshots and browser checks for Web UI changes, one directory per change:

- [Agent status layout](web-ui/agent-status/README.md)
- [computer-recovery](web-ui/computer-recovery/README.md)
- [computer-status-alignment](web-ui/computer-status-alignment/README.md)
- [connector-polish](web-ui/connector-polish/README.md)
- [GitHub account settings](web-ui/github-account-review/README.md)
- [GitHub OAuth cutover](web-ui/github-oauth-cutover/README.md)
- [discover-categories](web-ui/discover-categories/README.md)
- [mcp-add-server](web-ui/mcp-add-server/README.md)
- [MCP category filter](web-ui/mcp-category-filter/README.md)
- [mcp-management](web-ui/mcp-management/README.md)
- [mcp-settings-refinement](web-ui/mcp-settings-refinement/README.md)
- [mcp-settings-simplification](web-ui/mcp-settings-simplification/README.md)
- [mcp-unified-connect](web-ui/mcp-unified-connect/README.md)
- [sidebar-navigation](web-ui/sidebar-navigation/README.md)
- [site-redesign](web-ui/site-redesign/README.md)
- [soul-template-browser](web-ui/soul-template-browser/README.md)
- [skill-reader](web-ui/skill-reader/README.md)
- [skills-management](web-ui/skills-management/README.md)
