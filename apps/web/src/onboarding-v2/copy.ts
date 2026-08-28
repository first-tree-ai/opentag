/**
 * Every user-visible string in the onboarding flow, in one place. Copy is reviewed far more often
 * than layout during this phase, so it stays out of the components and can be read end to end.
 */

import type { CheckRow, Destination, Runtime, StepId } from "./flow.js";

export const STEP_LABELS: Record<StepId, string> = {
  destination: "Where it runs",
  agent: "Your agent",
  connect: "Your computer",
  runtime: "Runtime check",
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

export const CHECK_COPY: Record<
  CheckRow["id"],
  { readonly title: (runtime: string) => string; readonly failure: (runtime: string) => string }
> = {
  "runtime-cli": {
    title: (runtime) => `${runtime} CLI is installed`,
    failure: (runtime) => `We can't find the ${runtime} command on this computer.`,
  },
  "runtime-auth": {
    title: (runtime) => `${runtime} is signed in`,
    failure: (runtime) => `${runtime} is installed but not signed in.`,
  },
  "messaging-cli": {
    title: () => "Feishu CLI is installed",
    failure: () => "Feishu messages are sent through lark-cli, which isn't installed yet.",
  },
};

export const COPY = {
  brand: "OpenTag",

  destination: {
    title: "Where should your agent run?",
    description: "This is the one choice that shapes everything else.",
  },

  agent: {
    title: "Create your agent",
    nameLabel: "Agent name",
    nameHint: "The name you'll @mention in your messaging app.",
    nameCharsetError: "Use lowercase letters, numbers and hyphens only, starting with a letter or number.",
    nameEmptyError: "Your agent needs a name.",
    nameTooLongError: "Keep the name to 64 characters or fewer.",
    runtimeLabel: "Agent runtime",
    runtimeHint: "The coding agent OpenTag will run on your computer.",
    runtimeFootnote: "More runtimes coming soon.",
    runtimeLocked: "You can't change the runtime later, so pick the one you actually use.",
    continue: "Continue",
  },

  setup: {
    title: "Set up your agent to run",
    description: "Your AI worker runs on your own computer. Connect that computer to OpenTag.",
    privacy: "Your code and data never leave your machine.",
    commandIntro: "Run this in your terminal, or paste it to your agent.",
    commandComment: "# Install the OpenTag CLI and connect this computer to OpenTag.",
    copy: "Copy",
    copied: "Copied",
    copyFallback: "Copying is unavailable here. The command is selected — press Ctrl or Cmd + C.",
    expiresIn: (remaining: string) => `Expires in ${remaining}`,
    expired: "This command has expired.",
    refresh: "Get a new command",
    waiting: "Waiting for your computer…",
    connected: (name: string) => `${name} is connected.`,

    checksTitle: "Checking your agent runtime",
    checksTitleResolved: "Your agent runtime",
    checksDescription: "OpenTag is looking at what's already installed on your computer.",
    checksPassed: "Everything your agent needs is ready.",
    checksFailedIntro: "Two things need fixing on your computer before your agent can run.",
    checksFailedIntroSingular: "One thing needs fixing on your computer before your agent can run.",
    doctorIntro: "Run this to diagnose and fix it — or paste it to your agent and let it do the work.",
    doctorComment: "# Diagnose and fix the OpenTag agent runtime on this computer.",
    doctorWaiting: "This page updates on its own once it's fixed.",
    blockedNote: "We'll know once the CLI is installed.",
    finish: "Create my agent",
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
    title: (name: string) => `@${name} is ready.`,
    description: (name: string) => `Say @${name} in Feishu to put it to work.`,
  },
} as const;
