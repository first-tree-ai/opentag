# Staging onboarding reset

[简体中文](./zh-CN/staging-onboarding-reset.md)

Onboarding is written for an Account that has never run it, so a staging Account can only walk it once for free. The
staging onboarding reset gives that Account a repeatable way back, in two sizes: `mode: "reboard"` reopens onboarding
and keeps everything, while `mode: "all"` returns **the authenticated Account** to a genuine first-run state.

Which one you want follows from what you are testing. Only `mode: "all"` can produce a first run, because clearing the
setup-completion timestamp alone is not enough for that: existing Computer enrollments, Agents, runtime readiness and
IM bindings immediately advance the fact-derived onboarding flow. `mode: "reboard"` clears exactly that timestamp and
nothing else, so the surviving facts carry the Account into the resume path instead — which is the point of it.

Neither mode is available in production, and neither touches an Account other than the authenticated one.

For screen-level design review — copy, hierarchy, state communication — use `/internal/onboarding-v2`, which runs the
real onboarding page against a mock backend and needs neither an Account nor a reset.

## Where to click it

`/internal` is the staging-only internal tools index, and both resets are on it as buttons with a confirmation step.
Reach it from **Internal tools** in the account menu, which is rendered only where the Server answers that the
deployment offers the tools at all — production shows the menu it has always shown.

The rest of this document describes the request the page makes, for when you want to drive it by hand instead. One
thing to know either way: both resets take the Account back inside the setup gate, and the account menu lives behind
that gate, so after running one you are in onboarding without a menu to return through. `/internal` still opens if you
type it.

## Each tester uses their own Account

Sign in to staging with your own identity. A new Account starts in a first-run state, so the first complete run needs
nothing else; the reset is what lets you do it a second time.

There is no shared test Account to take turns on, and nothing to configure. Two people can run onboarding at the same
time: each resets only their own Account, each enrols their own Computer, and each Feishu authorization creates its own
application in the test tenant, so their bindings do not contend.

One shared cost remains. Reset disables OpenTag's binding but cannot delete the application it created in the Feishu
tenant, so repeated runs accumulate applications there. Clear them out by hand from time to time.

## Configuration

None. The reset is offered on any deployment running with `OPENTAG_ENV=staging`, and refused everywhere else.

Rules the Server enforces:

- every request must be authenticated;
- any deployment outside staging answers like a path that does not exist, and the environment is re-confirmed on each
  request rather than trusted from route registration;
- reset always targets the authenticated Account and accepts no client-selected Account;
- reset refuses unless that Account owns exactly one active resource scope, exclusively, so it can only ever act on
  resources that belong to the caller;
- reset requires the normal browser CSRF protection.

`OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID` used to name the one Account allowed to reset. It is retired: a deployment that
still sets it starts normally and the value is ignored.

## Asking for a reset

One authenticated request, from the browser session you are already signed in with:

```text
POST /api/v1/me/setup/reset
{ "mode": "all" | "reboard" }
```

The same path answers `GET` with `204` where the reset is offered and `404` where it is not, and nothing else.
That is how the page decides whether to show itself and whether to offer the menu entry, and it is the only way to
ask without performing a reset.

From the staging tab's console, where the session cookie and the CSRF cookie are both already present:

```js
await fetch("/api/v1/me/setup/reset", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-OpenTag-CSRF": decodeURIComponent(document.cookie.match(/opentag_csrf=([^;]+)/)[1]),
  },
  body: JSON.stringify({ mode: "all" }),
});
```

A `204` means the Account is back outside the setup gate; reload and `/onboarding` opens on its own.

### `mode: "reboard"`

Clears the setup marker and nothing else. The Agents, Computers and messaging connections the Account already has are
exactly what it keeps, which makes the next run a resume rather than a first run. Use it to look at onboarding again
without rebuilding an Agent and re-enrolling a machine first — not to test first-run behaviour, because the facts that
survive advance the flow past the steps that create them.

### `mode: "all"`

Returns the Account to a genuine first run. The reset is staged and idempotent:

1. every non-deleted Agent is suspended and deleted through the existing Agent lifecycle, which disables IM bindings,
   clears encrypted IM and setup credentials, ends active Sessions and removes runtime configuration;
2. outstanding unconsumed Computer connect codes are revoked;
3. active enrollment credentials and Computer enrollments are revoked;
4. affected live Computer connections are closed;
5. authoritative facts are re-read and verified;
6. only then is the setup-completion timestamp cleared.

Because the timestamp is the final commit marker, a reset that fails before verification leaves the Account inside the
application and can simply be run again. Two testers resetting at the same time take different Accounts and different
scope locks, so neither delays the other.

Historical and identity data is kept: the Account and its Google identity, deleted Agent rows, disabled IM bindings,
ended Sessions and messages, the stable Computer identity, and the external Feishu Bot. None of it satisfies
onboarding's active facts afterwards.

## Local Computer between runs

Repeated testing does not require deleting or rebuilding `OPENTAG_HOME`. After a `mode: "all"` reset:

1. the previous enrollment and machine token are invalid;
2. the Web produces a new Computer connect command;
3. the CLI reuses the stable physical Computer identity;
4. the new enrollment credential replaces the invalid one for the same Account and scope;
5. the existing daemon service restarts and reconnects.

This exercises the Computer step, connect command, enrollment, readiness and Agent creation. It intentionally does not
retest first-time package installation, first-time daemon-service installation, or creating a brand-new local Computer
identity; use a clean VM or CI host when you need those.

## Feishu between runs

Reset disables OpenTag's binding, clears the encrypted credential and setup context, and ends active Sessions. It does
not delete the Bot or App from the external Feishu test tenant, because no reliable provider-deletion seam exists today.

A real run still validates QR authorization, binding activation, granted capabilities, handoff readiness and onboarding
completion. To test a genuinely new tenant App, pick a different test Bot or remove the old external App by hand.

## Manual staging acceptance

```text
Reset your own Account with mode "all"
→ enter ordinary onboarding
→ run the generated Computer connect command using the existing local home
→ observe Computer readiness
→ create Agent
→ authorize Feishu in the test tenant
→ observe handoff readiness
→ complete onboarding
→ reset and repeat
```
