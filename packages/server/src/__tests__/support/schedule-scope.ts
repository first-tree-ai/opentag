import { randomUUID } from "node:crypto";
import type { AgentScheduleScope } from "../../services/schedules/service.js";
import type { SessionCliSourceContext } from "../../services/sessions/session-cli-proof-service.js";

// Schedule timing/dispatch fixtures stub proof authority; source revocation tests use actual stored proofs.
export function stubScheduleScope<
  T extends Pick<AgentScheduleScope, "accountId" | "agentId" | "sessionId" | "sessionKind">,
>(scope: T): T & { source: SessionCliSourceContext } {
  return {
    ...scope,
    source: {
      proofId: randomUUID(),
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      sessionKind: scope.sessionKind,
      computerId: randomUUID(),
      connectionInstanceId: randomUUID(),
      installationId: randomUUID(),
      placementGeneration: 1,
    },
  };
}
