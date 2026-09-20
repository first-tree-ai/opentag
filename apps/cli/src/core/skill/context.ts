import type { OpenTagApi } from "@opentag/client";
import { resolveCommandContext } from "../command/context.js";
import { CommandError } from "../command/policy.js";
import { resolveSessionProofContext } from "../session/index.js";
import type { SkillApiClient, SkillCommandDependencies } from "./shared.js";

/**
 * Decide whether a `skill` command runs as the Agent (Session proof) or as an Account operator.
 *
 * In a managed Session the Agent may push, list, and pull its own Skills but may not name another
 * Agent and may not run the Account lifecycle commands: disabling or deleting a Skill is a human's
 * decision, not the Agent's.
 */

export type SkillOperation = "push" | "list" | "pull" | "remove" | "enable" | "disable";

const ACCOUNT_ONLY_OPERATIONS: ReadonlySet<SkillOperation> = new Set(["remove", "enable", "disable"]);

export type SkillAuthority =
  | { readonly mode: "agent"; readonly api: SkillApiClient; readonly proof: string }
  | {
      readonly mode: "account";
      readonly api: SkillApiClient;
      readonly accessToken: string;
      readonly agentId: string;
    };

function validationError(code: string, message: string): CommandError {
  return new CommandError({ code, category: "validation", retryability: "never", phase: "validation" }, message);
}

async function agentAuthority(dependencies: SkillCommandDependencies): Promise<SkillAuthority> {
  if (dependencies.api && dependencies.proof) {
    return { mode: "agent", api: dependencies.api, proof: dependencies.proof };
  }
  const { api, proof } = await resolveSessionProofContext(dependencies.environment ?? process.env);
  return { mode: "agent", api: api as SkillApiClient, proof };
}

async function accountAuthority(agentId: string, dependencies: SkillCommandDependencies): Promise<SkillAuthority> {
  const context = await resolveCommandContext({
    accessToken: dependencies.accessToken,
    api: dependencies.api as OpenTagApi | undefined,
    environment: dependencies.environment,
    home: dependencies.home,
    requireAuth: true,
  });
  if (!context.api || !context.accessToken) {
    throw new Error("Command context did not resolve an authenticated API");
  }
  return {
    mode: "account",
    api: context.api as SkillApiClient,
    accessToken: context.accessToken,
    agentId,
  };
}

export async function resolveSkillCommandContext(
  operation: SkillOperation,
  dependencies: SkillCommandDependencies & { agentId?: string } = {},
): Promise<SkillAuthority> {
  const environment = dependencies.environment ?? process.env;
  const agentMode = Boolean(environment.OPENTAG_SESSION_PROOF_FILE) || dependencies.proof !== undefined;
  if (agentMode) {
    if (dependencies.agentId !== undefined) {
      throw validationError(
        "SKILL_AGENT_FLAG_FORBIDDEN",
        "--agent is not accepted inside a managed Session; the Skill always belongs to the Session's Agent",
      );
    }
    if (ACCOUNT_ONLY_OPERATIONS.has(operation)) {
      throw validationError(
        "SKILL_LIFECYCLE_ACCOUNT_ONLY",
        `skill ${operation} is an Account action; the Agent manages its Skills by pushing, and lifecycle is a human decision`,
      );
    }
    return agentAuthority(dependencies);
  }
  if (dependencies.agentId === undefined) {
    throw validationError("SKILL_AGENT_REQUIRED", "--agent <agent-id> is required when not running inside a Session");
  }
  return accountAuthority(dependencies.agentId, dependencies);
}
