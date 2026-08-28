# Staging Onboarding Lab

[简体中文](./zh-CN/staging-onboarding-lab.md)

The Onboarding Lab is a staging-only page for iterating on the first-run experience. It gives every signed-in staging
Account two things: fixed onboarding screen states for fast design review, and a repeatable reset that returns **that
Account** to a real first-run state, so the whole staging path can be walked again from the beginning.

It exists because clearing the setup-completion timestamp alone is not enough. Existing Computer enrollments, Agents,
runtime readiness and IM bindings immediately advance the fact-derived onboarding flow, so a completed Account cannot
return to a first-run state on its own.

The Lab is not available in production, and the reset never touches an Account other than the authenticated one.

## Each tester uses their own Account

Sign in to staging with your own identity. A new Account starts in a first-run state, so the first complete run needs
nothing else; the Lab is what lets you do it a second time.

There is no shared test Account to take turns on, and nothing to configure. Two people can run onboarding at the same
time: each resets only their own Account, each enrols their own Computer, and each Feishu authorization creates its own
application in the test tenant, so their bindings do not contend.

One shared cost remains. Reset disables OpenTag's binding but cannot delete the application it created in the Feishu
tenant, so repeated runs accumulate applications there. Clear them out by hand from time to time.

## Configuration

None. The Lab is offered on any deployment running with `OPENTAG_ENV=staging`, and refused everywhere else.

Rules the Server enforces:

- every request must be authenticated;
- any deployment outside staging answers both requests like a page that does not exist, and the environment is
  re-confirmed on each request rather than trusted from route registration;
- reset always targets the authenticated Account and accepts no client-selected Account;
- reset refuses unless that Account owns exactly one active resource scope, exclusively, so it can only ever act on
  resources that belong to the caller;
- reset requires the normal browser CSRF protection.

`OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID` used to name the one Account allowed to reset. It is retired: a deployment that
still sets it starts normally and the value is ignored.

## Using the Lab

Open the route directly and bookmark it; it is deliberately absent from product navigation:

```text
https://<staging-host>/internal/onboarding-lab
```

The route lives inside authenticated routing but outside the setup-completion gate, so it stays reachable if a real
onboarding run gets stuck after a reset.

### Scenario Preview

Preview renders the production onboarding page from fixed facts, through the same state derivation and presentation
production uses. The selected fixture is the only state kept, and it lives in the URL:

```text
/internal/onboarding-lab?scenario=computer-offline
```

Scenarios cover a brand new Account, an offline Computer, an unavailable Provider, a runnable route ready to create an
Agent, an Agent whose runtime route is gone, waiting for Feishu, Feishu authorization in progress, setup complete, and a
loading failure.

Preview makes no request and creates no durable state. It is the tool for screen hierarchy, copy and state
communication — not for interaction. It does not simulate the Computer daemon, the Feishu protocol, or a fake Server, so
use the real reset below for anything you need to click through.

### Real reset

`Reset my account and start onboarding` asks for one confirmation, then resets your own Account and enters the
ordinary `/onboarding` route. The reset is staged and idempotent:

1. every non-deleted Agent is suspended and deleted through the existing Agent lifecycle, which disables IM bindings,
   clears encrypted IM and setup credentials, ends active Sessions and removes runtime configuration;
2. outstanding unconsumed Computer connect codes are revoked;
3. active enrollment credentials and Computer enrollments are revoked;
4. affected live Computer connections are closed;
5. authoritative facts are re-read and verified;
6. only then is the setup-completion timestamp cleared.

Because the timestamp is the final commit marker, a reset that fails before verification leaves the Account outside
onboarding and can simply be run again — the page keeps you on the Lab with a retry. Two testers resetting at the same
time take different Accounts and different scope locks, so neither delays the other.

Historical and identity data is kept: the Account and its Google identity, deleted Agent rows, disabled IM bindings,
ended Sessions and messages, the stable Computer identity, and the external Feishu Bot. None of it satisfies onboarding's
active facts afterwards.

## Local Computer between runs

Repeated testing does not require deleting or rebuilding `OPENTAG_HOME`. After a reset:

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
Reset your own Account
→ enter ordinary onboarding
→ run the generated Computer connect command using the existing local home
→ observe Computer readiness
→ create Agent
→ authorize Feishu in the test tenant
→ observe handoff readiness
→ complete onboarding
→ reset and repeat
```
