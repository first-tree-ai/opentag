/**
 * The strings the setup pieces show, in one place. Copy is reviewed far more often than layout, so
 * it stays out of the components and can be read end to end.
 *
 * Everything here belongs to connecting a computer and connecting a messaging app — the two pieces
 * of work that are the same whether they are met during onboarding or reopened later from an
 * Agent's settings. Copy that only one of those surfaces says stays with that surface.
 */

import { messagingProviderLabel } from "../im/provider-label.js";
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
  /*
   * The title names the job rather than the tool. The binary really is called `lark-cli` and there
   * is no "Feishu CLI" to go and install, so the two honest options were to print a product that
   * does not exist or to put "lark" on a screen that is about Feishu. Neither belongs in a heading
   * whose only job is to say which check this is: the real command stays in the detail line, where
   * it is a command rather than a channel name, and where it can be copied.
   */
  "messaging-cli": {
    title: () => "Messaging CLI is installed",
    detail: {
      pending: () => "Looking for lark-cli.",
      passed: () => "Found on this computer.",
      failed: () => "We need lark-cli to send Feishu messages.",
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
  },

  messaging: {
    title: "Connect your messaging app",
    description: "Pick the app your team already works in.",
    providerLabel: "Messaging app",
    /**
     * Feishu and Lark are two channels, not one product under two names, and what OpenTag carries
     * today is Feishu. A Lark channel would arrive as its own provider beside this one. So this
     * card names Feishu alone: an "also called Feishu/Lark" would present a channel we do not
     * deliver as merely another word for one we do, and the code behind this card is minted
     * against Feishu regardless.
     *
     * The titles come from `messagingProviderLabel` rather than being spelled again here, so this
     * picker cannot drift from what the same provider is called everywhere else in the product.
     */
    feishu: { title: messagingProviderLabel("feishu"), description: "Your Feishu workspace" },
    slack: { title: messagingProviderLabel("slack"), description: "Your Slack workspace" },
    feishuIntro: "Scan this with Feishu. You'll finish the last step inside Feishu itself.",
    qrAlt: "Scan this QR code in Feishu",
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
