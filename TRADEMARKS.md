# Trademarks

[简体中文](./TRADEMARKS.zh-CN.md)

OpenTag connects to products built by other companies. To identify those products in the interface
we display their own marks, as published by their owners.

## Ownership

Every mark below belongs to its owner, not to this project. They are reproduced here only to
identify the product each one names — the use a trademark owner expects and permits. Their presence
does not imply that any owner sponsors, endorses, or is affiliated with OpenTag.

OpenTag's own name and mark belong to this project. They are **not** covered by the repository
[LICENSE](./LICENSE): Apache-2.0 section 6 grants no trademark rights, and the code licence says
nothing about using our name or mark. Permission to use them is separate, and this document does
not grant it — ask the project owners.

Nor does anything here grant rights in someone else's mark. Recording where a file came from
establishes provenance, not permission: the owner's own terms govern what may be done with it, and
this document cannot enlarge them.

## Assets carried in this repository

Each file records where and when it came from in a comment at its top. None of them has been
redrawn or restyled: an imitation of a trademark is both inaccurate and a worse position to be in
than using the published file.

| File | Mark | Owner |
| --- | --- | --- |
| `apps/web/src/assets/slack.svg` | Slack | Slack Technologies, LLC, a Salesforce company |
| `apps/web/src/assets/feishu.svg` | Feishu / Lark | Beijing Feishu Technology Co., Ltd. |
| `apps/web/src/assets/claude.svg` | Claude | Anthropic PBC |
| `apps/web/src/assets/google-sign-in-light@2x.png` | Sign in with Google | Google LLC |

## Conditions we are keeping to

- **Slack.** The "Add to Slack" button is **referenced from Slack's own URL**, the way Slack's
  developer documentation embeds it, rather than copied into this repository. It is used unmodified
  at its published proportions, as [Slack's brand guidelines](https://slack.com/media-kit) require,
  and is never restyled, recoloured, or rebuilt from our own components.
- **Codex.** No asset is carried. openai.com serves 403 to direct asset requests, and taking the
  icon out of an installed application would establish where the bytes came from without
  establishing permission to redistribute them here. It shows a neutral mark until a publisher-
  provided asset whose terms cover this use is available.
- **Google.** The sign-in button follows
  [Google's branding guidelines](https://developers.google.com/identity/branding-guidelines).
- **Every mark.** Displayed at its own proportions, never altered, and never used in a way that
  suggests a partnership.

## Adding another

Put the publisher's own file in `apps/web/src/assets/`, record its source and the date in a comment
at the top of the file, and add a row above. Before that, confirm the owner's terms actually permit
redistributing the file in a public repository under this licence — provenance alone is not
permission. Do not redraw a mark.
