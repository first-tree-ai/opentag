import { slackAppCreationManifest } from "@opentag/shared";
import type { Command } from "commander";
import { executeCommand } from "../core/command/policy.js";
import { captureSlackDeploy, runSlackManagement, slackManagementHome } from "../core/slack-management.js";

export function registerSlackCommands(program: Command): void {
  const slack = program
    .command("slack")
    .description("Manage a user's independent Slack App with the official CLI; separate from the messaging proxy")
    .addHelpText(
      "after",
      `
Managed workflow (only when requested by the user):
  1. Keep one creationIntentId, target Team and configuration in context.
  2. Use slack home for the private directory; run management commands sequentially.
     Keep this operation in project-<creationIntentId> and pass that --project-dir
     to every management command. Keep temporary files in the same directory.
     Reuse native login or run slack manage --project-dir project-<creationIntentId> -- auth login --no-prompt, then exchange
     the returned ticket and the user's Slack challenge with --ticket/--challenge.
  3. Use slack manifest to generate the 18-scope, no-callback manifest. Validate it,
     then create ONE App using slack manage --project-dir project-<creationIntentId> --team <id> --output-file project-<creationIntentId>/create-response.json
     -- api apps.manifest.create --json <JSON with serialized manifest field>.
     An uncertain create requires inspection, never an automatic retry.
  4. In that private operation directory, use .slack/config.json with
     {"manifest":{"source":"remote"}} and .slack/hooks.json with
     {"hooks":{"get-hooks":"node hooks.mjs"}}. manifest.mjs prints manifest.json.
     hooks.mjs prints JSON with runtime "node" and hooks:
       "get-manifest": "node manifest.mjs"
       "deploy": "${program.name()} slack capture-deploy --create-response-file project-<creationIntentId>/create-response.json --output-file project-<creationIntentId>/credentials.json"
     Run slack manage --project-dir project-<creationIntentId> -- app link --team <id> --app <id> --environment deployed,
     then slack manage --project-dir project-<creationIntentId> -- platform deploy --team <id> --app <id>. Deploy includes install.
     Wait for administrator approval before obtaining an Account operation code.
  5. agent provision-slack without --code-file prints a confirmation URL locally.
     The owner generates one operation code on their own device and returns it.
     Add --code-file to submit ONE creation-and-binding request with Session proof.
     Never request normal Account login codes or give Cloud Account Tokens.
  6. Only after binding, export and update the SAME remote App manifest with the
     returned slack.eventsUrl, interactionsUrl and bot_events: app_mention,
     app_uninstalled, message.channels, message.groups, message.im, message.mpim,
     tokens_revoked. Preserve its other settings. Retry callback failure on its own.
     Return the actual Bot User ID mention and App/Team DM link, not a guessed name.
All output files stay inside slack home with mode 0600. Do not print secrets.
Use a fresh operation code and the same intent/configuration after a spent code
or lost response; never rotate credentials during a successful replay. Remove
completed temporary secrets, keep valid native login, and do not claim messaging
acceptance without a real signed event and reply.
`,
    );
  slack
    .command("home")
    .description("Show the private management directory (outside per-Turn HOME and archived workspace)")
    .action(() => {
      process.stdout.write(`${slackManagementHome()}\n`);
    });
  slack
    .command("manifest")
    .description(
      "Print a new App manifest with the required scopes and no callbacks; never overwrite an existing customer's App",
    )
    .requiredOption("--creation-intent <uuid>", "the same creation intent used by agent provision-slack")
    .requiredOption("--display-name <name>", "Agent display name")
    .action((options) => {
      process.stdout.write(
        `${JSON.stringify(slackAppCreationManifest(options.creationIntent, options.displayName), null, 2)}\n`,
      );
    });
  slack
    .command("manage")
    .description("Run the official Slack CLI with native management credentials; use -- before official CLI arguments")
    .option(
      "--output-file <path>",
      "save stdout to a 0600 file inside the private management directory; required for raw API calls",
    )
    .option("--team <id>", "target Team; required for raw management API calls")
    .option("--project-dir <path>", "project directory inside the private management directory (default: project)")
    .argument("<args...>")
    .action(async (args: string[], options) => {
      try {
        process.exitCode = await runSlackManagement(args, options);
      } catch (error) {
        process.exitCode = await executeCommand(
          async () => {
            throw error;
          },
          { phase: "request" },
        );
      }
    });
  slack
    .command("capture-deploy")
    .description("Official deploy hook: privately save Signing Secret, Bot Token and Bot identity")
    .requiredOption("--create-response-file <path>", "private apps.manifest.create response file")
    .requiredOption("--output-file <path>", "private complete credentials file")
    .action(async (options) => {
      process.exitCode = await executeCommand(
        async () => {
          await captureSlackDeploy(options);
          return "Saved Slack installation credentials privately.";
        },
        { phase: "request" },
      );
    });
}
