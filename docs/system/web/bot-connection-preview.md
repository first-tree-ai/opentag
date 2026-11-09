---
title: "Bot connection preview"
description: "Run and edit the last Agent setup step in an isolated local playground using production presentation and in-memory state."
---

# Bot connection preview

The standalone `apps/web/bot-connection.html` entry mounts the production
`AgentSetupPage` directly at messaging setup. Agent creation and Computer preparation
are already complete in the fixture. Their completed progress indicators remain as
context; no creation or Computer setup screens are mounted.

## Run

From the repository root, with Node 24 and the repository's pnpm 10.12.1:

```sh
pnpm install --frozen-lockfile
pnpm --filter @opentag/web dev:bot-preview
```

If the global pnpm has a different version, use the pinned version without changing
the global installation:

```sh
npm exec --yes --package=pnpm@10.12.1 -- pnpm --filter @opentag/web dev:bot-preview
```

Open `http://127.0.0.1:5178/bot-connection.html`. The command prepares the two shared
packages before starting Vite. Source edits update the preview through Vite HMR.
The server binds only to loopback and refuses to choose another port silently.
No `.env` file, account, database, Daemon, or provider credential is needed.

For a standalone bundle, run `pnpm --filter @opentag/web build:bot-preview`, then
`pnpm --filter @opentag/web preview:bot-preview` and open
`http://127.0.0.1:5179/bot-connection.html`. Generated files live in the ignored
`apps/web/dist-bot-preview/` directory. The normal product build has no import of
this entry.

## Interaction review

The default URL displays only the product setup surface. Add `?controls=1` to
show preview settings and simulation actions. Close hides both control rows
without resetting the current connection state. Reload the controls URL to
reopen the tools; a reload starts a fresh in-memory session.

- Start in the messaging chooser. Click the production provider cards.
- For Feishu/Lark, use **Simulate next event** instead of scanning the inert QR.
  The first event completes authorization; the second completes the handoff.
  Failure, administrator-approval and connection-retry simulations are available
  during authorization. Connection retry opens the saved-authorization state for
  reviewing its status, expandable details, check and cancellation actions.
- For Slack, use `demo-invalid` to exercise authorization failure and **Reauthorize**
  to get a fresh mock command with an empty code field. Use `demo-only` in **Code**, then **Connect**, close the inline verification panel, and
  simulate the handoff. The real form, validation, manual-configuration disclosure,
  copy controls, help and disconnect dialogs remain interactive. Inline automatic
  and manual forms share a compact bottom action bar; Cancel closes the form and
  restores focus to the Slack entry.
- Use the state selector for waiting, recovery and ready fixtures. The connected-app
  selector controls the provider for those fixtures; the initial chooser owns its
  own provider choice. In recovery, the failure selector injects sample service,
  permission, expiry or unspecified error codes into the preview adapter only.
- Reset discards both the memory model and the session's React Query cache.
- Chinese is the default for this preview origin. The language toggle persists the
  explicit selection. Light/dark changes are local to this document.

Messaging actions keep compact desktop sizing, with a 44px minimum below 768px
and for coarse pointers. Provider cards and activation actions use the shared
focus token; the connection accent remains a brand decoration. When reviewing
responsive changes, inspect computed control sizes at 767px and 768px as well
as common phone widths, and check keyboard focus in both themes.

## Editing map

All paths below are relative to `apps/web/`.

| Concern | Source of truth |
| --- | --- |
| Production messaging choices, QR, handoff, recovery, disconnect confirmation | `src/onboarding-v2/agent-setup-page.tsx` |
| Production completion view and step rail | `src/onboarding-v2/steps.tsx` |
| Slack inline/dialog presentation and manual credentials form | `src/im/slack-custom-app.tsx` |
| Slack assisted connection | `src/im/slack-auto-connect.tsx` |
| Feishu application approval | `src/im/feishu-activation-waiting.tsx` |
| QR and shared setup pieces | `src/setup/components.tsx`, `src/setup/setup.css` |
| Setup layout and visual recipes | `src/onboarding-v2/onboarding-v2.css` |
| Shared UI primitives and theme | `src/ui/design-system.tsx`, `src/ui/primitives.css`, `src/ui/theme.css` |
| English and Chinese product copy | `messages/onboarding-v2/{en,zh}.json`, `messages/im/{en,zh}.json` |
| Original memory fixtures and transitions | `src/onboarding-v2/setup-memory-adapter.ts`, `agent-setup-lab-model.ts`, `setup-lab-slack.ts` |
| Preview-only controls and wiring | `src/bot-preview/playground.tsx`, `adapter.ts`, `main.tsx` |

The standalone preview imports the original components directly; there is no copied
visual fork to reconcile. Future scoped edits to the production component files can
be reviewed in Git and carried to a fork/PR. Keep preview wiring out of production
imports. The older `src/im/feishu-setup.tsx` exists for other surfaces; the current
onboarding QR flow lives in `agent-setup-page.tsx`.

## Isolation and development compatibility

The entry does not mount the application router, authentication shell, analytics
bootstrap or error-report transport. It injects the existing in-memory setup and
Slack adapters, blocks `fetch`, intercepts external navigation, and uses a CSP that
disallows remote scripts, images, connections, frames and form submissions. The dev
server has no API proxy and returns 403 on `/api/`. All authorization, credentials,
connection and handoff results are simulated. No entered credentials are sent or
persisted; use demo input only.

The QR adapter replaces the upstream fixture's Feishu URL with a reserved
`preview.invalid` URL. Generated Slack links still show fixture IDs, but clicks do
not leave the page. The simulated Slack ticket is not a real authorization ticket.

The upstream shared browser export currently includes a server-only `createHash`
import through `runtime-domain.ts`. Vite's unbundled development mode evaluates it
even though connection UI does not use it. This preview config alone aliases
`node:crypto` to a function that throws if invoked. It does not provide a fake hash
or change shared business logic. The production build tree-shakes this unused path.

The source is a complete repository checkout to preserve dependency versions,
license, history, and component mapping; the browser entry is isolated to the last
setup step. This is a local editing environment, not a deployment.
