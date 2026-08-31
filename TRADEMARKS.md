# Trademarks

[简体中文](./TRADEMARKS.zh-CN.md)

OpenTag connects to products built by other companies. To identify those products in the interface
we display their own marks, as published by their owners.

## Ownership

Every mark below belongs to its owner, not to this project. OpenTag uses third-party marks only as
unmodified, referential identifiers for the products and integrations they name. Their presence
does not imply that any owner sponsors, endorses, or is affiliated with OpenTag.

OpenTag's own name and mark belong to this project. They are **not** covered by the repository
[LICENSE](./LICENSE): Apache-2.0 section 6 grants no trademark rights, and the code licence says
nothing about using our name or mark. Permission to use them is separate, and this document does
not grant it — ask the project owners.

Nor does anything here grant rights in someone else's mark. Third-party marks and their asset files
are **not offered under Apache-2.0**. Recording where a file came from establishes provenance, not
permission: the owner's terms and applicable trademark law govern their use, and this document
cannot enlarge those rights.

## Assets carried in this repository

Each file records where and when it came from in a comment at its top. These publisher-controlled
files are carried only so the interface can identify a supported or previewed integration. None of
them has been redrawn, recoloured, or restyled, and the repository licence does not relicense them.

| File | Mark | Owner |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC, a Salesforce company |
| `apps/web/src/assets/feishu.svg` | Feishu / Lark | Beijing Feishu Technology Co., Ltd. |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/google-sign-in-light@2x.png` | Sign in with Google | Google LLC |
| `apps/web/src/assets/integration-github.svg` | GitHub | GitHub, Inc. |
| `apps/web/src/assets/integration-google-drive.svg` | Google Drive | Google LLC |
| `apps/web/src/assets/integration-linear.svg` | Linear | Linear Orbit, Inc. |
| `apps/web/src/assets/integration-notion.svg` | Notion | Notion Labs, Inc. |
| `apps/web/src/assets/integration-sentry.svg` | Sentry | Functional Software, Inc. |
| `apps/web/src/assets/integration-figma.svg` | Figma | Figma, Inc. |

## Conditions we are keeping to

- **Slack.** The "Add to Slack" button is **referenced from Slack's own URL**, the way Slack's
  developer documentation embeds it, rather than copied into this repository. It is used unmodified
  at its published proportions, as [Slack's brand guidelines](https://slack.com/media-kit) require,
  and is never restyled, recoloured, or rebuilt from our own components.
- **Codex.** No asset is carried. openai.com serves 403 to direct asset requests, and taking the
  icon out of an installed application would establish where the bytes came from without
  establishing permission to redistribute them here. It shows a neutral mark until a publisher-
  provided asset whose terms cover this use is available.
- **GitHub.** The mark identifies an integration with GitHub, a use described by
  [GitHub's logo guidelines](https://brand.github.com/foundations/logo). It remains secondary to
  OpenTag and does not imply affiliation.
- **Google.** The sign-in button follows
  [Google's identity guidelines](https://developers.google.com/identity/branding-guidelines). The
  Google Drive mark identifies that integration and follows
  [Google Drive's branding guidelines](https://developers.google.com/workspace/drive/api/guides/branding).
- **Linear.** The logo-only mark is used in a compact integrations list and follows
  [Linear's brand guidelines](https://linear.app/brand).
- **Notion.** The mark comes from Notion's publisher-controlled application asset and is used only
  to identify the Notion integration. Notion also publishes an official
  [media kit](https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286).
- **Sentry.** The mark comes from Sentry's publisher-controlled web assets and is used only to
  identify the Sentry integration.
- **Figma.** The mark identifies compatibility with Figma in accordance with
  [Figma's brand guidelines](https://www.figma.com/using-the-figma-brand/).
- **Every mark.** Displayed at its native proportions without alteration, less prominently than
  OpenTag's own identity, and never used in a way that suggests a partnership or endorsement.

## Adding another

Use a file from the publisher's brand kit, media kit, or publisher-controlled website without
changing its visible artwork. Put it in `apps/web/src/assets/`, record its source and retrieval date
in a comment at the top, and add a row above. Source comments and non-rendering XML normalization
are permitted; geometry, colours, proportions, and appearance must remain unchanged. Confirm that
the proposed display is a truthful, narrow reference to a product or integration and is consistent
with the owner's current guidelines. If those terms prohibit carrying the file in this repository,
reference an owner-hosted asset where appropriate or omit the mark. Never redraw, recolour, animate,
or combine it with OpenTag's own mark.
