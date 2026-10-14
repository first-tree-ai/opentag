# Create an Agent with its own Slack App from Slack

[简体中文](./zh-CN/slack-agent-provisioning.md)

The running Agent prepares one independent Slack App with the official Slack CLI, then submits one
creation-and-binding request with its Session proof and an Account operation code. The operation
code cannot be exchanged for Account access or refresh tokens. No database table, column, workflow
record, or permanent delegation is added.

Use the CLI binary for the current environment in place of `opentag` below. These commands run
inside a managed Session. Ordinary `agent create` continues to use Account login; ordinary `slack api`
continues to use the current Bot's messaging proxy.

## Prepare Slack

1. Keep one `creationIntentId`, target Team, creation configuration, and App ID in conversation
   context. The new Agent uses the source Agent's Runtime Provider and the proof-verified current Computer.
   Choose an explicit model for Cloud. Do not use a display name as an App
   identity or repeat an uncertain create.
2. `opentag slack home` prints the private management directory. Cloud uses
   `/tmp/opentag/slack-management`, outside per-Turn HOME and the archived workspace. Local uses
   `<OpenTag home>/slack-management`. It contains native CLI configuration under `config/` and
   each operation under `project-<creationIntentId>/`. Pass that same `--project-dir` to every management command and keep its temporary files there. Never reuse a linked project for another App in the same Team. Run management commands sequentially.
   Local resolves the existing account-level native Provider CLI launcher, bypassing the Turn
   messaging launcher on `PATH`. Visible proof-backed Sessions receive write access only to this
   precreated 0700 management directory, not the whole OpenTag home.
3. If there is no usable native login, run
   `opentag slack manage -- auth login --no-prompt`. The user executes the returned `/slackauthticket`
   command in Slack, reviews permissions, and returns the challenge. Complete the same ticket with
   the official CLI's `--ticket` and `--challenge` flags. This does not use a localhost browser callback;
   the user can act on their own device. Physical cross-device acceptance remains a live QA item.
4. Generate the initial manifest with
   `opentag slack manifest --creation-intent <uuid> --display-name <name>`. It reuses OpenTag's name
   rules, all 18 Bot scopes, and writable App Home, with no event or interactivity callbacks.
5. Use the official API via
   `opentag slack manage --project-dir project-<intent> --team <team-id> --output-file project-<intent>/create-response.json -- api apps.manifest.create --json <manifest-request-json>`.
   The JSON request wraps the serialized manifest in its `manifest` field. Validate the same manifest first. API output files are relative to the private management directory,
   or absolute paths inside it. Never print the creation response: it contains the Signing Secret.

Raw management API commands require both `--team` and `--output-file`. The wrapper clears messaging
handles and proxy routing, runs native `auth list` to let the official CLI refresh, then reads the
latest native authorization for that Team into this process only. It checks Slack JSON `ok`, not
only the exit code. It neither copies refresh tokens elsewhere nor introduces a refresh service.
The official CLI may prefix API JSON with presentation text; the capture hook handles that prefix.

## Native management authorization boundary

This flow intentionally reuses the existing Computer-level trust boundary: visible proof-backed
Sessions on the same Computer share the private native Slack management directory and its retained
login. Such Agents can manage every App available to that Slack CLI authorization. The Account
operation code gates OpenTag creation and binding; it does not restrict native Slack management to
one App or isolate one Agent from other Agents on that Computer. Only run trusted Agents there.
No per-Agent Slack authorization or credential isolation mechanism is added.

## Install the same App and capture credentials

Create the small hook project in the private `project-<intent>/` directory:

- `.slack/config.json`: `{"manifest":{"source":"remote"}}`.
- `.slack/hooks.json`: `{"hooks":{"get-hooks":"node hooks.mjs"}}`.
- `manifest.json`: the original no-callback manifest.
- `manifest.mjs`: `import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));`.
- `hooks.mjs`: print the following object as JSON. Substitute the current CLI binary in `deploy`.

```json
{
  "runtime": "node",
  "hooks": {
    "get-manifest": "node manifest.mjs",
    "deploy": "opentag slack capture-deploy --create-response-file project-<intent>/create-response.json --output-file project-<intent>/credentials.json"
  }
}
```

Use `opentag slack manage --project-dir project-<intent> -- app link --team <team-id> --app <app-id> --environment deployed`, then
`opentag slack manage --project-dir project-<intent> -- platform deploy --team <team-id> --app <app-id>`. Deploy already includes
installation; do not add a separate install step or force a local manifest over the remote one.
The official hook supplies `SLACK_BOT_TOKEN`; the capture command verifies the Bot with `auth.test`
and writes App ID, Team ID, Bot User ID, Bot Token, and Signing Secret to a 0600 file. Hook stdout
contains only a completion message. Native configuration/output directories are 0700.

If Team policy requires approval, wait here. The administrator approves in Slack on their own device;
resume installation of this same App. Do not request the Account code until credentials are ready.

## Confirm once and bind

Save `creationIntentId`, name, displayName, the source Agent's runtimeProvider, and optional model,
reasoning effort and instructions to `agent.json`. The provisioning schema rejects `computerId`,
`runtimeConfig.permissions` and `runtimeConfig.maxDurationMs`; the Server fixes the Computer to the
Session proof and requires the same Provider. This also prevents switching from an approval-based
Provider to Pi's full-permission policy. Existing default permissions and duration apply; the owner
can change them later through the normal Account surface. Then run:

```sh
opentag agent provision-slack --request-file <agent.json> --credentials-file <private-credentials.json> --json
```

Without `--code-file`, this only validates local inputs and prints the Account confirmation URL and
the proposed Agent/App/Team. It makes no server request. The Account owner opens that URL on their
own device and clicks **Generate and copy code**, then returns the code to the original conversation.
Clipboard denial leaves a selectable code; it does not request a second code. Save the code privately
and repeat the same command with `--code-file <private-code-file>`.

The confirmation entry stays available after sign-in even when a CLI-created Account has not completed Web setup; other pages keep their existing setup gate.

This sends exactly one `POST /api/v1/runtime/agent/slack-provision`. The server authenticates Session
proof, resolves the source Agent's owner, consumes a matching operation code, calls existing Agent
creation, and binds only that creation result. Existing Computer ownership, Slack App/Team/Bot and
scope checks, binding conflicts, and encrypted credential storage apply. The self-configuration
switch retains its existing meaning. Arbitrary target Agent or Account IDs are rejected.

The existing authenticated `POST /api/v1/me/connect-codes` accepts only the additional fixed purpose
`slack-agent-provision`; the default request/response remains the normal login flow. The operation
code is `slack-provision.<random>`, with the entire string hashed and the fixed purpose prefix also placed outside the stored hash in the existing code table. Old Server versions compute only a plain hex hash and therefore cannot redeem these codes after rollback.
Normal token exchange rejects that prefix before consumption; provisioning rejects normal codes.
Removing/replacing the prefix cannot match the stored hash. No purpose column or intermediate ticket
exchange is needed.

## Configure callbacks and recover

Only after binding, export the same remote App manifest and update its event URL to the returned
`slack.eventsUrl`, interactivity URL to `interactionsUrl`, and Bot events to `app_mention`,
`app_uninstalled`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `tokens_revoked`.
Preserve the rest of the remote manifest. Existing server ingress can now locate the Signing Secret
and handle a challenge. Return the actual `slack.binding.identity.botUserId` mention and the App/Team
DM link; use `slack.binding.bot.displayName` only when present.

- An uncertain App create requires inspection, not automatic recreation.
- Schema, Provider and code validity checks happen before consumption. Creation and Slack identity
  validation follow consumption, so a name conflict or invalid Slack credential can spend the code.
  This preserves one-time authorization before side effects without a reservation or extra exchange.
  Check the prepared local files first.
- After code consumption or a lost response, use a fresh operation code with the same intent and
  creation configuration. An unbound Agent is retained. A matching existing App/Team/Bot binding
  returns its live state without rotating credentials; a different binding conflicts.
- Keep the same effective Computer and Provider when recovering. If the source Session moved or its
  Provider changed after a lost response, the existing creation fingerprint conflicts safely. Resume
  from the original Computer/Provider; do not override them, change the intent or silently create
  another Agent.
- Callback failure retries only the callback update. It needs no new Account code or binding request.
- Sandbox replacement can lose native login and temporary secrets. Reauthorize and inspect the known
  App; do not promise transparent cross-Sandbox recovery.
- Remove the completed operation's temporary secret files; keep a still-valid native management login.

Configuration success does not prove real messaging. Live Cloud execution, administrator approval,
cross-device use, and signed send/receive require separate, narrowly authorized acceptance.
