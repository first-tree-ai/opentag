# Web App analytics

[简体中文](./zh-CN/web-analytics.md)

The Web App reports an activation funnel to Google Analytics 4. This document states what is measured, what is
deliberately not sent, and the one property setting the code cannot make for itself.

## The switch

Measurement is decided entirely in the browser, by `apps/web/src/analytics/config.ts`:

- the build must be a production build, which excludes every development server; and
- the hostname must be `opentag.build` or one of its subdomains.

When either test fails nothing happens at all — no tag is fetched and no event is queued.

The host rule is an **allowlist, not a loopback exclusion**, and that matters more than it looks. OpenTag is open
source and meant to be self-hosted. Excluding only loopback would mean **every self-hosted deployment quietly
reported its operators and their readers into this property** — data nobody asked to send and nobody here wants to
hold. The allowlist also fails in the safe direction: an unlisted host is simply not measured, which is a silent gap
rather than a silent leak. It excludes the end-to-end stack and local previews for free, since neither runs on this
domain.

**A self-hosted OpenTag deployment loads no tag and reports nothing.** If you fork this and want your own
measurement, change `ANALYTICS_MEASUREMENT_ID` and `MEASURED_HOST_SUFFIX` together.

There is no environment variable. A single image is built per commit and promoted unchanged to every environment, so a
build-time value could not differ between them, and a runtime one would travel through the Server for a value that
never changes. (Injecting it into `index.html` at boot does not work either: `@fastify/static` is registered with
`wildcard: false`, so `/` and `/index.html` are served from disk and never pass through the cached string.)

The accepted consequence is that **staging and production report into the same property.** To make that survivable,
every host that is not the production one (`app.opentag.build`) sends `traffic_type: "internal"`. Define an **Internal
Traffic filter** in the GA4 admin and set it Active, and staging is excluded from every report at once instead of each
report having to remember to segment by hostname — which one report eventually will not. Until that filter exists the
parameter changes nothing, so it is safe for it to arrive first.

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
| `computer_connected` | 3 (only when `mode` is `create`) | same, when the redeemed Computer comes online | `mode` |
| `agent_setup_stage_reached` | — | `onboarding-v2/agent-setup-page.tsx`, once per Agent and stage | `stage` |
| `agent_setup_completed` | — | same, when the stage first reads `ready` | — |
| `first_conversation_observed` | 4 | `features/agents/agents-page.tsx`, when the Agent list first shows a Task | — |
| `page_view` | — | `analytics/route-analytics.ts`, per resolved route template | route-derived location |

The three transitions the funnel answers are the drops between steps 1→2, 2→3 and 3→4.

A `computer_connected` with `mode: "repair"` carries **no** `funnel_step`: it reconnects a Computer the Account already
had, so counting it would report the same reader reaching step 3 again — inflating that step and understating the drop
out of it. The event is still worth having, because a repair is somebody recovering.

### Neither sign-in path can report itself

The password form navigates the browser as soon as the session cookie arrives, so an event raised beside that call
races the unload. The identity providers leave the application entirely and return through a Server redirect that
carries no marker. Both, however, know the method *before* they leave, so it is written to session storage
(`analytics/sign-in-intent.ts`) and read once by the page the Account lands on. Reading consumes it, so a return visit
with an existing session is identified but reports no sign-in.

The redirect providers necessarily record on the *press*, which is not yet a sign-in — abandoning the consent screen
would otherwise leave an intent that the next authenticated page turns into a `login` that never happened. So the
intent carries a timestamp and expires after ten minutes: long enough for a consent screen and a second factor, far
short of a working day.

Because `page_view` is keyed on the route template, `/agents/A` → `/agents/B` is **one** page view, not two. That is
deliberate — the report groups them that way — but it means this event does not answer "how many Agent detail pages
did they open".

### `first_conversation_observed` undercounts, by construction

Conversations happen in Slack or Feishu, not in the Web App, and the Task views do not poll. The Agent list is the only
surface that both re-reads on an interval and carries a Task count. Three consequences, all of which only lose events:

- **Lag and survivorship.** It fires when that list is next open — late, and never at all for somebody who connects a
  Computer, talks to their Agent, and does not return to the site. That is backwards from the truth: a delighted user
  who never comes back is recorded as a step-3 drop-off.
- **A thirty-day window.** `usage.tasks` is a rolling thirty-day aggregate (`AgentUsageSummarySchema` pins
  `windowDays: 30`), not a lifetime count. An Agent whose only conversations are older than that reads here as one that
  has held none.
- **Acceptance, not completion.** `usage.tasks > 0` means a message was accepted. Completion lives in the turn report,
  on a surface the app never polls.

**Treat step 4 as a floor on the real conversion, never as "readers who have ever held a conversation".** Making it
exact means reporting server-side through the GA4 Measurement Protocol where the turn report lands; that is
deliberately not done here.

### Event counts are per object, not per reader

Steps 2, 3 and 4 are reported per Agent or per Computer, so an Account with five conversing Agents contributes five
step-4 events. Funnel explorations are user-scoped, so conversion *rates* are unaffected — but a raw event-count report
on any of these steps reads high.

## What is never sent

- **No address, no display name, no Agent name.** The only identifier is the Account's own uuid, set as `user_id` so
  the funnel survives a reader moving between devices.
- **No address, ever — the path comes from the route, not the URL.** `page_path` and `page_location` are projected from
  the *matched route's declared path*: `/agents/$agentId/settings/$section` becomes
  `/agents/:agentId/settings/:section`. A value reaches a report only because a route file names the parameter.

  Classifying the address by shape was tried first and is not sound, which is worth recording so it is not
  reintroduced: routes here declare free-form parameters, so `/agents/<uuid>/settings/<anything>` matches and renders,
  and no rule over segment length or character set can tell a section name from a secret. Anything the router did not
  match — including `/invites/<token>`, which renders the not-found page rather than failing to match — is reported as
  the single constant path `/(not-found)`, carrying none of the address.
- **Campaign parameters are allowlisted by key and still not trusted by value.** Only `utm_*`, `gclid` and siblings
  survive from the query string. Their values are written by whoever built the link, so an address-shaped or
  implausibly long value is dropped rather than forwarded. Note the honest limit of the "no address" claim above: it is
  a guarantee about what *this application* sends, and a campaign value is caller-supplied.
- **Referrers are origins only.** An in-app navigation reports the previous page's template; the first view of a
  document reports the referring site's bare origin. An opaque origin (an Android app, an `about:` document) is
  reported as nothing rather than as the literal string `"null"`.
- **No advertising signals.** `allow_google_signals` and `allow_ad_personalization_signals` are both off.
- **Nothing from `/internal`.** The preview lab drives the real components against in-memory adapters, so an Agent
  "created" there is not an Agent. Refusing this application's own calls is not enough on its own — Enhanced
  Measurement raises scroll, click, download and form events of the tag's own accord — so the exclusion is enforced at
  the tag with Google's `ga-disable-<id>` flag, kept in step with the route so a direct entry and a later navigation
  are both covered.
- **No identity after sign-out.** `endSession` clears `user_id`. Signing out is a client-side navigation, so without
  that the login page and everything after it would still be attributed to the Account that just left.

## Required property setting

The Web App sends its own sanitized `page_view` and configures the tag with `send_page_view: false`. GA4's enhanced
measurement also raises a page view on browser history changes, which reads the raw address.

**In the GA4 web stream, turn off "Page changes based on browser history events."** Leaving it on double-counts page
views and re-introduces the addresses the projection removes. As defence in depth the route-derived location is also
recorded with `gtag('set', …)`, so an automatic hit carries the safe value, but the setting is still the correct fix.

Two more admin steps before the numbers mean anything:

- **Define internal traffic** (`traffic_type` equals `internal`) and set the filter **Active**, per the switch section.
- **Register event-scoped custom dimensions** for `funnel`, `funnel_step`, `method`, `runtime_provider`, `mode`,
  `stage` and `reason`. They take 24–48 hours to become queryable, so do this first or the first day of explorations
  looks empty.

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
