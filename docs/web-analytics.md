# Web App analytics

[简体中文](./zh-CN/web-analytics.md)

The Web App reports an activation funnel to Google Analytics 4. This document states what is measured, what is
deliberately not sent, and the one property setting the code cannot make for itself.

## The switch

Measurement is decided entirely in the browser, by `apps/web/src/analytics/config.ts`:

- the build must be a production build, which excludes every development server; and
- the hostname must not be loopback, which excludes the end-to-end stack, `vite preview`, and any local run of
  `apps/web/dist`.

When either test fails nothing happens at all — no tag is fetched and no event is queued. There is no environment
variable. A single image is built per commit and promoted unchanged to every environment, so a build-time value could
not differ between them, and a runtime one would travel through the Server for a value that never changes.

The accepted consequence: **staging and production report into the same property.** Separate them in Google Analytics
by hostname.

## What is measured

Every funnel milestone carries `funnel: "activation"` and a contiguous `funnel_step`, so a funnel exploration can be
built from the step number rather than from a hand-ordered list of events.

| Event | Step | Raised where | Parameters |
| --- | --- | --- | --- |
| `login` | 1 | `routes/_authenticated.tsx`, on the first resolved Account | `method` |
| `sign_up` | 1 | same, when the press that started it was "create an account" | `method` |
| `agent_created` | 2 | `onboarding-v2/page.tsx`, after the Server returns an id | `runtime_provider` |
| `agent_create_failed` | — | same, on refusal | `reason`: `name_conflict` or `error` |
| `computer_connect_started` | — | `features/computer-connect/computer-connect.tsx`, when the command is shown | `mode` |
| `computer_connected` | 3 | same, when the redeemed Computer comes online | `mode` |
| `agent_setup_stage_reached` | — | `onboarding-v2/agent-setup-page.tsx`, once per Agent and stage | `stage` |
| `agent_setup_completed` | — | same, when the stage first reads `ready` | — |
| `first_conversation_observed` | 4 | `features/agents/agents-page.tsx`, when the Agent list first shows a Task | — |
| `page_view` | — | `analytics/route-analytics.ts`, per resolved route | sanitized location |

The three transitions the funnel answers are the drops between steps 1→2, 2→3 and 3→4.

### Neither sign-in path can report itself

The password form navigates the browser as soon as the session cookie arrives, so an event raised beside that call
races the unload. The identity providers leave the application entirely and return through a Server redirect that
carries no marker. Both, however, know the method *before* they leave, so it is written to session storage
(`analytics/sign-in-intent.ts`) and read once by the page the Account lands on. Reading consumes it, so a return visit
with an existing session is identified but reports no sign-in.

### `first_conversation_observed` undercounts, by construction

Conversations happen in Slack or Feishu, not in the Web App, and the Task views do not poll. The Agent list is the only
surface that both re-reads on an interval and carries a Task count, so this event fires when that list is next open —
late, and never at all for somebody who connects a Computer, talks to their Agent, and does not return to the site.

**Treat step 4 as a floor on the real conversion, not an estimate of it.** Making it exact means reporting server-side
through the GA4 Measurement Protocol where the turn report lands; that is deliberately not done here.

## What is never sent

- **No address, no display name, no Agent name.** The only identifier is the Account's own uuid, set as `user_id` so
  the funnel survives a reader moving between devices.
- **No raw URL.** `analytics/page-location.ts` rebuilds the location from the parts allowed to survive: the origin, the
  route template with every uuid and integer segment reduced to `:id`, and an allowlist of campaign parameters
  (`utm_*`, `gclid`, and siblings). Everything else in the query string is dropped, so a parameter added later is
  private until someone chooses otherwise. A same-origin referrer is held to the same rule; a foreign one is reduced to
  its bare origin.
- **No advertising signals.** `allow_google_signals` and `allow_ad_personalization_signals` are both off.
- **Nothing from `/internal`.** The preview lab drives the real components against in-memory adapters, so an Agent
  "created" there is not an Agent.

## Required property setting

The Web App sends its own sanitized `page_view` and configures the tag with `send_page_view: false`. GA4's enhanced
measurement also raises a page view on browser history changes, which reads the raw address.

**In the GA4 web stream, turn off "Page changes based on browser history events."** Leaving it on double-counts page
views and re-introduces the identifiers the sanitizer removes. As defence in depth the sanitized location is also
recorded with `gtag('set', …)`, so an automatic hit carries the safe value, but the setting is still the correct fix.

## Content Security Policy

`packages/server/src/web-app.ts` states `script-src` explicitly to allow `googletagmanager.com`, and widens
`connect-src` and `img-src` for the regional collectors. It is a host allowance and nothing more: there is no
`'unsafe-inline'`, so the snippet published by the Google Analytics console cannot run as written. The Web App creates
the `dataLayer` queue in its own bundle instead (`analytics/gtag.ts`).

The allowance is unconditional while the tag is loaded conditionally, so on a development or end-to-end origin these
sources are permitted but never used.

## Consent

There is none, and no cookie banner. Whoever deploys OpenTag owns that decision; the switch above is the control they
have. If consent becomes a requirement, GA Consent Mode v2 belongs in `installAnalytics`.

## Testing

`AnalyticsReporter` is inert until something arms it, so no suite reports by importing a page. A test that wants events
calls `analytics.arm(sink)` with a recording sink and `analytics.disarm()` afterwards — see
`apps/web/src/__tests__/analytics-funnel.test.tsx`. No module mocking is involved.
