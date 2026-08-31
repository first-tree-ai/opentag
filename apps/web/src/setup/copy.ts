/**
 * The strings the setup pieces show, in one place. Copy is reviewed far more often than layout, so
 * it stays out of the components and can be read end to end.
 *
 * Everything here belongs to connecting a computer and connecting a messaging app — the two pieces
 * of work that are the same whether they are met during onboarding or reopened later from an
 * Agent's settings. Copy that only one of those surfaces says stays with that surface.
 */

import type { CheckRow, CheckState } from "./checks.js";

/**
 * Copy for the numbered computer-check rows. Every row carries a line of detail in every state,
 * not only when it fails, so the list does not reflow as results land. A missing messaging CLI is
 * named later, as a sentence (`SETUP_COPY.messaging.cliMissing`) rather than a third check line.
 */
export const CHECK_COPY: Record<
  CheckRow["id"],
  { readonly title: (runtime: string) => string; readonly detail: Record<CheckState, (runtime: string) => string> }
> = {
  "runtime-cli": {
    title: (runtime) => `${runtime} CLI is installed`,
    detail: {
      pending: (runtime) => `Looking for the ${runtime} command.`,
      passed: () => "Found on this computer.",
      failed: (runtime) => `We can't find the ${runtime} command on this computer.`,
      blocked: () => "",
    },
  },
  "runtime-auth": {
    title: (runtime) => `${runtime} is signed in`,
    detail: {
      pending: (runtime) => `Checking your ${runtime} sign-in.`,
      passed: () => "Signed in and ready.",
      failed: (runtime) => `${runtime} is installed but not signed in.`,
      blocked: () => "We'll know once the CLI is installed.",
    },
  },
};

export const SETUP_COPY = {
  connect: {
    title: "Connect your computer",
    /** What the step is about, and what it means for your data: both belong with the title. */
    lead: "Your AI worker runs on your own computer. Connect that computer to OpenTag.",
    privacy: "Your code and data never leave your machine.",
    /** How to run it, which belongs with the command itself. */
    commandIntro: "Run this in your terminal, or paste it to your agent.",
    commandComment: "# Install the OpenTag CLI and connect this computer to OpenTag.",
    copy: "Copy",
    copied: "Copied",
    copyFallback: "Copying is unavailable here. The command is selected — press Ctrl or Cmd + C.",
    expiresIn: (remaining: string) => `Expires in ${remaining}`,
    expired: "This command has expired.",
    expiredStatus: "Connection command expired.",
    refresh: "Get a new command",
    waiting: "Waiting for your computer…",
    connected: "Your computer is connected.",
    preparing: "Preparing connection command…",

    /*
     * The same step, once the Account has its computer. An Account has one, so there is nothing to
     * choose and nothing to add: the step says which machine the Agent will run on and whether it
     * can be reached. Asking "which one" would surface a concept the reader should never meet, and
     * offering another is how an Account ends up with a duplicate it then has to repair.
     */
    yoursTitle: "Your computer",
    yoursLead: "Your AI worker runs on your own computer.",
    online: "Online",
    offline: "Offline",
    unknown: "Unable to confirm",
    lastSeen: (when: string) => `last seen ${when}`,
    offlineLead: (computerName: string) =>
      `${computerName} is offline. Start OpenTag on that Computer; this page will continue when it reconnects.`,
    unknownLead: (computerName: string) =>
      `We can't confirm ${computerName} right now. Start OpenTag on that Computer; this page will continue when it reconnects.`,
    generateRepair: "Need to reinstall? Generate a repair command.",
    hideRepair: "Hide repair command",
    repairCommandComment: (computerName: string) => `# Run this command in the terminal on ${computerName}`,
    waitingRepair: (computerName: string) => `Waiting for ${computerName} to connect…`,
  },

  messaging: {
    title: "Connect your messaging app",
    description: "Pick the app your team already works in.",
    providerLabel: "Messaging app",
    /**
     * Lark is the name this product goes by in English; Feishu is the same app under its
     * mainland China name. The provider's id stays `feishu`, because that is the Server's own
     * vocabulary — only what the reader sees changes here.
     */
    feishu: { title: "Lark", description: "Also called Feishu" },
    slack: { title: "Slack", description: "Your Slack workspace" },
    feishuIntro: "Scan this with Lark. You'll finish the last step inside Lark itself.",
    feishuPreparing: "OpenTag is preparing a secure Lark authorization.",
    qrAlt: "Scan this QR code in Lark",
    generating: "Generating QR code…",
    waiting: "Waiting for you to scan…",
    cliMissing: (provider: string) =>
      `${provider} messages are sent through its CLI, which isn't installed on your computer yet. Run opentag doctor to add it.`,
    slackIntro: "Install OpenTag in your Slack workspace. We'll take you to Slack and bring you back.",
    slackAction: "Add to Slack",
    slackWaiting: "Waiting for you to finish in Slack…",
    confirming: "Connected. Checking your agent can be reached…",
    computerOffline: "Your computer is offline. Reconnect it and this will finish on its own.",
    retry: "Try again",
    failed: "That didn't work. Try again to get a new code.",
  },
} as const;
