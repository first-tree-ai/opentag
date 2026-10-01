# Trademarks

[简体中文](./zh-CN/trademarks.md)

OpenTag connects to products built by other companies. To identify those products in the interface
we display their own marks, as published by their owners.

## Ownership

Every mark below belongs to its owner, not to this project. OpenTag uses third-party marks only as
unmodified, referential identifiers for the products and integrations they name. Their presence
does not imply that any owner sponsors, endorses, or is affiliated with OpenTag.

OpenTag's own name and mark belong to this project. They are **not** covered by the repository
[LICENSE](../LICENSE): Apache-2.0 section 6 grants no trademark rights, and the code licence says
nothing about using our name or mark. Permission to use them is separate, and this document does
not grant it — ask the project owners.

Nor does anything here grant rights in someone else's mark. Third-party marks and their asset files
are **not offered under Apache-2.0**. Recording where a file came from establishes provenance, not
permission: the owner's terms and applicable trademark law govern their use, and this document
cannot enlarge those rights.

## Assets carried in this repository

SVG files record where and when they came from in a comment at the top; bitmap provenance is recorded below.
These publisher-controlled files are carried only so the interface can identify a supported or previewed integration. None of
them has been redrawn, recoloured, or restyled, and the repository licence does not relicense them.

| File | Mark | Owner |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC, a Salesforce company |
| `apps/web/src/assets/feishu.svg` | Feishu / Lark | Beijing Feishu Technology Co., Ltd. |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/openai-blossom-black.svg` | OpenAI Blossom, black | OpenAI, L.L.C. |
| `apps/web/src/assets/openai-blossom-white.svg` | OpenAI Blossom, white | OpenAI, L.L.C. |
| `apps/web/src/assets/google-g.png` | Google G | Google LLC |
| `apps/web/src/assets/pi.svg` | Pi | Pi (pi.dev) |

## Conditions we are keeping to

- **Slack.** The "Add to Slack" button is **referenced from Slack's own URL**, the way Slack's
  developer documentation embeds it, rather than copied into this repository. It is used unmodified
  at its published proportions, as [Slack's brand guidelines](https://slack.com/media-kit) require,
  and is never restyled, recoloured, or rebuilt from our own components.
- **Codex.** The interface uses the unmodified OpenAI Blossom files from OpenAI's official
  [logo package](https://cdn.openai.com/brand/openai-logos.zip), under OpenAI's
  [brand guidelines and Marks usage terms](https://openai.com/brand/). It identifies Codex as an
  OpenAI service, appears beside the explicit “Codex / OpenAI” label, and remains subordinate to
  OpenTag's own brand. The black and white published variants preserve the mark in light and dark
  colour schemes without recolouring it.
- **Google.** The sign-in button follows
  [Google's identity guidelines](https://developers.google.com/identity/branding-guidelines). Its unmodified G mark was
  retrieved from [Google's published asset](https://developers.google.com/static/identity/images/g-logo.png) on 2026-09-07; the
  button label is localized HTML text.
- **Feishu / Lark.** The unmodified app mark was sourced from
  [Feishu's published icon](https://www.feishu.cn/favicon.ico) on 2026-08-24, as recorded in the
  SVG header. It identifies the Feishu / Lark integration only and does not imply endorsement or
  affiliation; the publisher's current terms govern its use.
- **Claude.** The unmodified app mark was sourced from [Claude's published icon](https://claude.ai/favicon.ico)
  on 2026-08-29, as recorded in the SVG header. It identifies the Claude integration only and does
  not imply endorsement or affiliation; the publisher's current terms govern its use.
- **Pi.** The official Pi mark was added in [PR #683](https://github.com/first-tree-ai/opentag/pull/683),
  commit `d6e7fd0f105befd616df30f7ef7df42524d4ea00`, from
  [Pi's published logo](https://pi.dev/logo-auto.svg) on 2026-09-21, as recorded in the SVG header.
  It is used unmodified only to identify the Pi runtime; the publisher's current terms govern its
  use and this record does not imply endorsement or affiliation.
- **Every mark.** Displayed at its native proportions without alteration, less prominently than
  OpenTag's own identity, and never used in a way that suggests a partnership or endorsement.

## Adding another

Use a file from the publisher's brand kit, media kit, or publisher-controlled website without
changing its visible artwork. Put it in `apps/web/src/assets/`, record its source and retrieval date
in a top-of-file SVG comment or in this document for a bitmap, and add a row above. Source comments and non-rendering XML normalization
are permitted; geometry, colours, proportions, and appearance must remain unchanged. Confirm that the
proposed display is a truthful, narrow reference to a product or integration and is consistent with
the owner's current guidelines. If those terms prohibit carrying the file in this repository,
reference an owner-hosted asset where appropriate or omit the mark. Never redraw, recolour, animate,
or combine it with OpenTag's own mark.
