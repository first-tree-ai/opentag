import {
  ProvisionSlackAgentRequestSchema,
  ProvisionSlackAgentResponseSchema,
  RUNTIME_AGENT_SLACK_PROVISION_PATH,
  SESSION_CLI_PROOF_HEADER,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { AgentSlackProvisionService } from "../services/agents/agent-slack-provision-service.js";
import { parseRequest } from "./request-validation.js";

export interface RuntimeAgentSlackProvisionOptions {
  service: Pick<AgentSlackProvisionService, "authenticate" | "provision">;
}

export function registerRuntimeAgentSlackProvision(
  app: FastifyInstance,
  { service }: RuntimeAgentSlackProvisionOptions,
): void {
  app.post(RUNTIME_AGENT_SLACK_PROVISION_PATH, { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const header = request.headers[SESSION_CLI_PROOF_HEADER];
    const scope = await service.authenticate(typeof header === "string" ? header : "");
    const input = parseRequest(ProvisionSlackAgentRequestSchema, request.body);
    const response = await service.provision(scope, input);
    return reply.header("Cache-Control", "no-store").send(ProvisionSlackAgentResponseSchema.parse(response));
  });
}
