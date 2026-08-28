/**
 * Every user-visible string in the onboarding flow, in one place. Copy is reviewed far more often
 * than layout during this phase, so it stays out of the components and can be read end to end.
 */

import type { CheckRow, CheckState, Destination, Runtime, StepId } from "./flow.js";

export const STEP_LABELS: Record<StepId, string> = {
  destination: "Where it runs",
  agent: "Your agent",
  connect: "Your computer",
  check: "Computer check",
  messaging: "Messaging app",
};

export const DESTINATION_COPY: Record<
  Destination,
  { readonly title: string; readonly description: string; readonly badge?: string }
> = {
  local: {
    title: "Local computer",
    description: "Run on your own machine, with the coding agent and subscription you already have.",
  },
  cloud: {
    title: "Cloud computer",
    description: "We run the agent for you, with tokens included.",
    badge: "Coming soon",
  },
};

export const RUNTIME_COPY: Record<Runtime, { readonly title: string; readonly description: string }> = {
  codex: { title: "Codex", description: "OpenAI" },
  "claude-code": { title: "Claude Code", description: "Anthropic" },
};

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
    title: () => "Feishu CLI is installed",
    detail: {
      pending: () => "Looking for lark-cli.",
      passed: () => "Found on this computer.",
      failed: () => "We need lark-cli to send Feishu messages.",
      blocked: () => "",
    },
  },
};

export const COPY = {
  brand: "OpenTag",

  nav: {
    back: "Go back",
    next: "Continue",
  },

  destination: {
    title: "Where should your agent run?",
  },

  agent: {
    title: "Create your agent",
    nameLabel: "Agent name",
    nameHint: "The name you'll @mention in your messaging app.",
    nameCharsetError: "Use lowercase letters, numbers and hyphens only, starting with a letter or number.",
    nameEmptyError: "Your agent needs a name.",
    nameTooLongError: "Keep the name to 64 characters or fewer.",
    runtimeLabel: "Agent runtime",
    runtimeHint: "The coding agent OpenTag will use.",
    runtimeFootnote: "More runtimes coming soon.",
  },

  connect: {
    title: "Your computer",
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

  check: {
    title: "Computer check",
    passed: "Everything your agent needs is ready.",
    failedIntro: (count: number) =>
      count > 1
        ? `${count} things need fixing before your agent can run.`
        : "One thing needs fixing before your agent can run.",
    /**
     * By the time this page is read, `doctor --fix` is usually already running on the user's
     * machine — signing in during the previous step starts it. So this is a pointer back to where
     * the work is happening, not a command to go and run: one light line, no block, no copy button.
     */
    repairHint: "Continue in your terminal or agent for instructions, or run",
    repairCommand: "opentag doctor --fix",
    repairHintSuffix: "again.",
    creating: "Creating…",
  },

  messaging: {
    title: "Connect your messaging app",
    description: "Scan this with Feishu to finish. You'll do the last step inside Feishu itself.",
    slack: "Slack",
    slackBadge: "Coming soon",
    qrAlt: "Scan this QR code in Feishu",
    waiting: "Waiting for you to scan…",
  },

  done: {
    title: (name: string) => `${name} is ready.`,
    description: (name: string) => `Tag @${name} in Feishu to put it to work.`,
  },
} as const;
