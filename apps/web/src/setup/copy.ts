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
 * Every check carries a line of detail in every state, not only when it fails. The list is the
 * page's spine while the user works in their terminal, so its rows must not change height as
 * results land — a list that reflows under someone is worse than one that says "checking".
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
  "messaging-cli": {
    title: () => "Lark CLI is installed",
    detail: {
      pending: () => "Looking for lark-cli.",
      passed: () => "Found on this computer.",
      failed: () => "We need lark-cli to send Lark messages.",
      blocked: () => "",
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
    refresh: "Get a new command",
    waiting: "Waiting for your computer…",
    connected: "Your computer is connected.",

    /*
     * The same step, once the Account already has a computer. The title changes because the
     * question does: connecting one is now a choice rather than the only way through.
     *
     * The lead says what the step is for and stops. What the control offers — an existing machine
     * or a new one — is visible in the control itself, so narrating it here would only add a
     * sentence to the step that needs one least.
     */
    chooseTitle: "Choose a computer",
    chooseLead: "Your AI worker runs on your own computer.",
    selectLabel: "Computer",
    newOption: "Connect a new computer…",
    online: "Online",
    offline: "Offline",
    lastSeen: (when: string) => `last seen ${when}`,
    /** Reconnecting repairs this exact machine, so the Account does not collect a second one. */
    offlineLead: "This computer is offline. Reconnect it and this page will continue on its own.",
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
    qrAlt: "Scan this QR code in Lark",
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
