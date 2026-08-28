import type { AgentRuntimeProvider, ImCliProvider } from "@opentag/shared";

/**
 * A repair a person or their coding agent can run directly. Commands are printed, never executed
 * silently: installing software and signing in are the operator's decisions, not the CLI's.
 */
export interface DoctorFix {
  readonly commands: readonly string[];
  readonly docsUrl?: string;
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
    commands: ["curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash"],
    docsUrl: "https://docs.slack.dev/tools/slack-cli",
    summary: "Install the Slack CLI so that OpenTag can deliver messages",
  },
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

export function imCliUpgradeFix(provider: ImCliProvider): DoctorFix {
  const install = IM_CLI_INSTALL_FIXES[provider];
  return { ...install, summary: `Reinstall or upgrade the ${imCliTitle(provider)}` };
}

export function agentRuntimeTitle(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}

export function imCliTitle(provider: ImCliProvider): string {
  return provider === "feishu" ? "Feishu CLI (lark-cli)" : "Slack CLI";
}
