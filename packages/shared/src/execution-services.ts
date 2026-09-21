import { z } from "zod";
import { RUNTIME_MCP_SERVICE, RuntimeMcpServiceScopeSchema } from "./mcp-gateway.js";
import { RUNTIME_WEB_SERVICE, RuntimeWebServiceScopeSchema } from "./web-tools.js";

/**
 * Platform services a Client may opt into when it opens an execution.
 *
 * This module exists so no single service owns the union. The two schemas below started inside
 * `web-tools.ts`, which was correct while `web` was the only service; adding `mcp` there would have
 * parked the MCP contract permanently inside the Tavily module and made every future service
 * import from it.
 *
 * A grant is a pure authorization statement — the service and its exact scopes. It carries no
 * secret: a service whose runtime needs a credential hands it over through its own frame in
 * `./runtime-credentials.ts`, which is the invariant every other secret in that protocol already
 * follows.
 */

/** Services a Client may request at execution open. Each is gated by its own negotiated capability. */
export const RuntimeExecutionServiceRequestSchema = z.enum([RUNTIME_WEB_SERVICE, RUNTIME_MCP_SERVICE]);
export type RuntimeExecutionServiceRequest = z.infer<typeof RuntimeExecutionServiceRequestSchema>;

export const RuntimeWebExecutionServiceSchema = z
  .object({
    service: z.literal(RUNTIME_WEB_SERVICE),
    scopes: z.array(RuntimeWebServiceScopeSchema).min(1).max(2),
  })
  .strict();
export type RuntimeWebExecutionService = z.infer<typeof RuntimeWebExecutionServiceSchema>;

export const RuntimeMcpExecutionServiceSchema = z
  .object({
    service: z.literal(RUNTIME_MCP_SERVICE),
    scopes: z.array(RuntimeMcpServiceScopeSchema).min(1).max(1),
  })
  .strict();
export type RuntimeMcpExecutionService = z.infer<typeof RuntimeMcpExecutionServiceSchema>;

/**
 * One service grant attached to an opened execution.
 *
 * Discriminated on `service` rather than flattened, so each service states its own scope vocabulary
 * and a reader that narrows on `service === "web"` cannot silently accept an `mcp` grant's scopes.
 */
export const RuntimeExecutionServiceSchema = z.discriminatedUnion("service", [
  RuntimeWebExecutionServiceSchema,
  RuntimeMcpExecutionServiceSchema,
]);
export type RuntimeExecutionService = z.infer<typeof RuntimeExecutionServiceSchema>;
