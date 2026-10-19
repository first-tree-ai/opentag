import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import { AgentService } from "../services/agents/agent-service.js";
import { AgentTransferError, type AgentTransferResult } from "../services/agents/agent-transfer.js";

/**
 * Operator-only Agent transfer. OpenTag has no runtime admin role, so this lives next to
 * `bootstrap.ts` as a direct-database CLI rather than behind an HTTP route: the caller already holds
 * the deployment's credentials, and adding a route would need an authorization story the product
 * does not have.
 *
 * This module owns the input contract and the audit log line; the transaction and every precondition
 * live in `AgentService.transferToAccount`.
 */
export const TransferAgentInputSchema = z
  .object({
    agentId: z.string().uuid(),
    targetAccountId: z.string().uuid(),
    /** `disable` (the safe default) tears the messaging binding down; `keep` retains a Slack binding. */
    slack: z.enum(["disable", "keep"]).default("disable"),
  })
  .strict();

/**
 * Environment-shaped input: every field may be absent, and the schema decides what is required, so a
 * missing variable fails with the same validation the programmatic caller gets.
 */
export interface TransferAgentRawInput {
  agentId?: string | undefined;
  slack?: string | undefined;
  targetAccountId?: string | undefined;
}

export async function transferAgent(
  database: DatabaseClient,
  rawInput: TransferAgentRawInput,
  options: { logger?: ServiceLogger; now?: () => Date } = {},
): Promise<AgentTransferResult> {
  const input = TransferAgentInputSchema.parse(rawInput);
  try {
    const result = await new AgentService(database, { now: options.now }).transferToAccount(input);
    options.logger?.info(
      {
        agentId: result.agentId,
        sourceAccountId: result.sourceAccountId,
        targetAccountId: result.targetAccountId,
        slack: input.slack,
        imBinding: result.imBinding,
        previousComputerId: result.previousComputerId,
        revision: result.revision,
        runtimeConfigReset: result.runtimeConfigReset,
        schedulesPaused: result.schedulesPaused,
      },
      "Agent transferred to another Account",
    );
    return result;
  } catch (error) {
    if (error instanceof AgentTransferError) {
      options.logger?.warn(
        {
          agentId: input.agentId,
          targetAccountId: input.targetAccountId,
          slack: input.slack,
          reason: error.reason,
        },
        "Agent transfer rejected",
      );
    }
    throw error;
  }
}
