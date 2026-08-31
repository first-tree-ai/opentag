/**
 * The strings the setup pieces show, in one place. Copy is reviewed far more often than layout, so
 * it stays out of the components and can be read end to end.
 *
 * Everything here belongs to connecting a computer and connecting a messaging app — the two pieces
 * of work that are the same whether they are met during onboarding or reopened later from an
 * Agent's settings. Copy that only one of those surfaces says stays with that surface.
 */

import * as m from "../paraglide/messages.js";
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
    refresh: "Get a new command",
    waiting: "Waiting for your computer…",
    connected: "Your computer is connected.",

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
    lastSeen: (when: string) => `last seen ${when}`,
    /** Reconnecting repairs this exact machine, rather than replacing it with a second one. */
    offlineLead: "This computer is offline. Reconnect it and this page will continue on its own.",
  },

  messaging: {
    title: m.onboarding_messaging_title(),
    description: m.onboarding_messaging_description(),
    providerLabel: m.onboarding_messaging_provider_label(),
    /**
     * Lark is the name this product goes by in English; Feishu is the same app under its
     * mainland China name. The provider's id stays `feishu`, because that is the Server's own
     * vocabulary — only what the reader sees changes here.
     */
    feishu: { title: m.onboarding_messaging_feishu_title(), description: m.onboarding_messaging_feishu_description() },
    slack: { title: m.onboarding_messaging_slack_title(), description: m.onboarding_messaging_slack_description() },
    feishuIntro: m.onboarding_messaging_feishu_intro(),
    qrAlt: m.onboarding_messaging_qr_alt(),
    waiting: m.onboarding_messaging_waiting(),
    cliMissing: (provider: string) => m.onboarding_messaging_cli_missing({ provider }),
    slackIntro: m.onboarding_messaging_slack_intro(),
    slackAction: m.onboarding_messaging_slack_action(),
    slackWaiting: m.onboarding_messaging_slack_waiting(),
    confirming: m.onboarding_messaging_confirming(),
    computerOffline: m.onboarding_messaging_computer_offline(),
    retry: m.onboarding_messaging_retry(),
    failed: m.onboarding_messaging_failed(),
  },
} as const;
