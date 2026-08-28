import type { AgentRuntimeProvider, ImCliProvider } from "@opentag/shared";

/**
 * A repair a person or their coding agent can run directly. Commands are printed, never executed
 * silently: installing software and signing in are the operator's decisions, not the CLI's. A fix
 * with no command needs a human to follow the documentation instead.
 */
export interface DoctorFix {
  readonly commands: readonly string[];
  readonly docsUrl?: string;
  readonly note?: string;
  readonly summary: string;
}

const AGENT_RUNTIME_FIXES: Readonly<
  Record<AgentRuntimeProvider, { readonly install: DoctorFix; readonly signIn: DoctorFix }>
> = {
  codex: {
    install: {
      commands: ["npm install -g @openai/codex"],
      docsUrl: "https://developers.openai.com/codex/cli",
      summary: "Install the Codex CLI so that `codex` runs from this computer's PATH",
    },
    signIn: {
      commands: ["codex login"],
      docsUrl: "https://developers.openai.com/codex/cli",
      summary: "Sign in to Codex on this computer",
    },
  },
  "claude-code": {
    install: {
      commands: ["npm install -g @anthropic-ai/claude-code"],
      docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
      summary: "Install the Claude Code CLI so that `claude` runs from this computer's PATH",
    },
    signIn: {
      commands: ["claude auth login"],
      docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
      // Known defect: OpenTag always sets CLAUDE_CONFIG_DIR, and Claude Code then cannot see an
      // ordinary macOS Keychain login, so this sign-in can report the same failure afterwards.
      note: "If this reports the same failure after a successful sign-in, you are hitting first-tree-ai/opentag#236",
      summary: "Sign in to Claude Code on this computer",
    },
  },
};

const IM_CLI_INSTALL_FIXES: Readonly<Record<ImCliProvider, DoctorFix>> = {
  feishu: {
    commands: ["npm install -g @larksuite/cli"],
    docsUrl: "https://www.npmjs.com/package/@larksuite/cli",
    summary: "Install the Feishu (Lark) CLI so that OpenTag can deliver messages",
  },
  slack: {
    // The Slack CLI ships as a shell installer rather than a package. Printing a piped installer for
    // an Agent to run is a different risk class from `npm install -g`, so this one stays human-only.
    commands: [],
    docsUrl: "https://docs.slack.dev/tools/slack-cli",
    note: "Install it yourself from the documentation; OpenTag does not print an installer to pipe into a shell",
    summary: "Install the Slack CLI so that OpenTag can deliver messages",
  },
};

const IM_CLI_REQUIREMENTS: Readonly<Record<ImCliProvider, string>> = {
  feishu: "`lark-cli --version` and `lark-cli im --help` must both succeed quickly",
  slack: "`slack version` and `slack api --help` must both succeed quickly",
};

export function agentRuntimeInstallFix(provider: AgentRuntimeProvider): DoctorFix {
  return AGENT_RUNTIME_FIXES[provider].install;
}

export function agentRuntimeSignInFix(provider: AgentRuntimeProvider): DoctorFix {
  return AGENT_RUNTIME_FIXES[provider].signIn;
}

export function agentRuntimeUpgradeFix(provider: AgentRuntimeProvider): DoctorFix {
  const install = AGENT_RUNTIME_FIXES[provider].install;
  return {
    ...install,
    summary: `Reinstall or upgrade the ${agentRuntimeTitle(provider)} so that OpenTag can drive it`,
  };
}

export function imCliInstallFix(provider: ImCliProvider): DoctorFix {
  return IM_CLI_INSTALL_FIXES[provider];
}

/**
 * An installed messaging CLI can also be broken, hung, or too old. Naming what OpenTag needs beats
 * guessing at a remedy, because reinstalling does not fix a command that hangs.
 */
export function imCliRepairFix(provider: ImCliProvider): DoctorFix {
  const install = IM_CLI_INSTALL_FIXES[provider];
  return {
    ...install,
    // No command: reinstalling does not fix a CLI that hangs, and printing one would contradict the
    // summary. Naming what OpenTag needs lets the operator decide what to repair.
    commands: [],
    note: `OpenTag needs it to answer its own probe: ${IM_CLI_REQUIREMENTS[provider]}`,
    summary: `Repair the ${imCliTitle(provider)}: it is installed but does not answer OpenTag's probe`,
  };
}

export function agentRuntimeTitle(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}

export function imCliTitle(provider: ImCliProvider): string {
  return provider === "feishu" ? "Feishu CLI (lark-cli)" : "Slack CLI";
}
