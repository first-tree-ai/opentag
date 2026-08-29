/**
 * Every user-visible string in the onboarding flow, in one place. Copy is reviewed far more often
 * than layout during this phase, so it stays out of the components and can be read end to end.
 */

import type { CheckRow, CheckState, CloudRuntime, Destination, Runtime, StepId, TokenSource } from "./flow.js";

export const STEP_LABELS: Record<StepId, string> = {
  agent: "Create agent",
  computer: "Prepare computer",
  messaging: "Messaging app",
};

export const DESTINATION_COPY: Record<Destination, { readonly title: string; readonly description: string }> = {
  local: {
    title: "Local computer",
    description: "Run on your own machine, with the coding agent and subscription you already have.",
  },
  cloud: {
    title: "Cloud computer",
    description: "We run the agent for you, with tokens included.",
  },
};

export const COMING_SOON = "Coming soon";

export const RUNTIME_COPY: Record<Runtime, { readonly title: string; readonly description: string }> = {
  codex: { title: "Codex", description: "OpenAI" },
  "claude-code": { title: "Claude Code", description: "Anthropic" },
};

export const CLOUD_RUNTIME_COPY: Record<CloudRuntime, { readonly title: string; readonly description: string }> = {
  opentag: { title: "OpenTag agent", description: "Ours, and easy to set up." },
  "claude-code": { title: "Claude Code", description: "Anthropic" },
  codex: { title: "Codex", description: "OpenAI" },
};

export const TOKEN_COPY: Record<TokenSource, { readonly title: string; readonly description: string }> = {
  opentag: { title: "OpenTag Tokens", description: "Select from all open source models." },
  "own-plan": { title: "Your own coding plan", description: "Use the subscription you already pay for" },
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
    title: () => "Lark CLI is installed",
    detail: {
      pending: () => "Looking for lark-cli.",
      passed: () => "Found on this computer.",
      failed: () => "We need lark-cli to send Lark messages.",
      blocked: () => "",
    },
  },
};

export const COPY = {
  loading: "Picking up where you left off…",
  brand: "OpenTag",

  nav: {
    retry: "Try again",
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

  cloud: {
    title: "Create your cloud agent",
    runtimeLabel: "Agent runtime",
    runtimeHint: "The coding agent OpenTag will use.",
    runtimeFootnote: "More runtimes coming soon.",
    allocating: "Preparing…",
    tokenLabel: "Tokens",
    /** "the token your agent rely on" — the subject is plural here, so it takes "rely". */
    tokenHint: "The tokens your agent relies on to complete tasks.",
    signInTitle: (runtime: string) => `Sign in to ${runtime}`,
    signInHint: (runtime: string) =>
      `We'll open the ${runtime} sign-in page in a new tab. Approve the request there, then come back.`,
    signInAction: (runtime: string) => `Sign in to ${runtime}`,
    signInPending: "Waiting for you to approve it…",
    signInDone: (runtime: string) => `Signed in to ${runtime}.`,
    /**
     * The name is fixed once the Agent exists: the Server has no way to rename one. Picking a
     * messaging app is what creates it, so this says why the field stopped accepting edits.
     */
    nameFixed: "Your agent's name is set once it's created.",
  },

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

  check: {
    title: "Computer check",
    /** Mirrors the connect step's waiting line, so both steps say the same thing the same way. */
    waiting: "Waiting for the computer check…",
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
    retry: "Try again",
    failed: "That didn't work. Try again to get a new code.",
  },

  done: {
    title: (name: string) => `${name} is ready.`,
    description: (name: string) => `Tag @${name} in Lark to put it to work.`,
  },

  /**
   * What to say when the Server does not answer. Each names the thing that failed rather than the
   * call that failed, because the reader is standing in a step, not in a network log.
   */
  errors: {
    connectCode: "We couldn't get a connection command. Check your network and try again.",
    computers: "We lost contact while waiting for your computer.",
    createAgent: "We couldn't create your agent.",
    messaging: "We couldn't start connecting your messaging app.",
    feishuAttempt: "That code is no longer usable. Pick Lark again to get a new one.",
    resume: "We couldn't check what your account already has.",
    completeSetup: "Your agent is ready, but we couldn't finish setting up your account. Reload to try again.",
  },
} as const;
