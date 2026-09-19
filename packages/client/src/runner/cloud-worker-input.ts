import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_DEFAULT_MAX_DURATION_MS, type RunnerCloudWorkerRequest } from "@opentag/shared";
import type { AgentInput } from "../agent-runtime/types.js";
import { buildAgentInput, turnTimeoutMs } from "../runtime/agent-turn-runner.js";
import { buildSessionMessageInput } from "../runtime/session-message-inbox.js";

export function cloudWorkerRuntime(request: RunnerCloudWorkerRequest) {
  return request.kind === "turn" ? request.delivery.runtime : request.message.runtime;
}

export function cloudWorkerInput(request: RunnerCloudWorkerRequest): AgentInput {
  if (request.kind === "turn") return buildAgentInput(request.delivery);
  if (request.sessionKind === "internal") return buildSessionMessageInput(request.message);
  if (!request.outboxContext) throw new Error("Visible Cloud Session collaboration requires outbox context");
  return buildSessionMessageInput(request.message, "opentag", {
    sessionKind: "visible",
    outboxContext: request.outboxContext,
  });
}

export function cloudWorkerTimeout(request: RunnerCloudWorkerRequest, now: number): number {
  return request.kind === "turn"
    ? turnTimeoutMs(request.delivery, now)
    : Math.max(1, request.message.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS);
}

/** Proofs and endpoint discovery belong to execution scratch, never restored Session storage. */
export async function cloudSessionCliEnvironment(
  request: RunnerCloudWorkerRequest,
  scratch: string,
): Promise<Record<string, string>> {
  const material = request.sessionCollaboration;
  if (!material) return {};
  const directory = join(scratch, "session-cli");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proofPath = join(directory, "proof.json");
  await writeFile(proofPath, `${JSON.stringify(material.proof)}\n`, { mode: 0o600 });
  return {
    OPENTAG_SESSION_PROOF_FILE: proofPath,
    OPENTAG_SESSION_SERVER_URL: material.serverUrl,
  };
}
