import {
  HTTP_PATHS,
  RuntimeDurableWorkKindSchema,
  RuntimeDurableWorkListResponseSchema,
  RuntimeDurableWorkRecordSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import {
  type PostgresRuntimeDurableWorkStore,
  RuntimeDurableWorkConflictError,
} from "../runtime/runtime-durable-work-store.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

const QuerySchema = z.object({ kind: RuntimeDurableWorkKindSchema }).strict();
const ParamsSchema = z.object({ kind: RuntimeDurableWorkKindSchema, key: z.string().min(1).max(128) }).strict();

export interface RuntimeDurableWorkRoutesOptions {
  machineAuth: ComputerAuthVerifier;
  store: Pick<PostgresRuntimeDurableWorkStore, "list" | "write">;
}

function computerId(request: FastifyRequest): string {
  const value = request.computerAuthContext?.workspaceComputerId;
  if (!value) throw new Error("Authenticated Computer context is missing");
  return value;
}

export function registerRuntimeDurableWorkRoutes(app: FastifyInstance, options: RuntimeDurableWorkRoutesOptions): void {
  const preHandler = createComputerAuthPreHandler(options.machineAuth);
  app.get(HTTP_PATHS.runtimeDurableWork, { preHandler }, async (request, reply) => {
    const query = parseRequest(QuerySchema, request.query);
    const items = await options.store.list(computerId(request), query.kind);
    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send(RuntimeDurableWorkListResponseSchema.parse({ items }));
  });

  app.put(`${HTTP_PATHS.runtimeDurableWork}/:kind/:key`, { preHandler }, async (request, reply) => {
    const params = parseRequest(ParamsSchema, request.params);
    const record = parseRequest(RuntimeDurableWorkRecordSchema, request.body);
    if (record.kind !== params.kind || record.key !== params.key) {
      return reply.code(409).send({
        error: {
          code: "VALIDATION_ERROR",
          category: "deterministic",
          message: "The durable Runtime record identity does not match the path",
          requestId: request.id,
        },
      });
    }
    try {
      await options.store.write(computerId(request), record);
    } catch (error) {
      if (error instanceof RuntimeDurableWorkConflictError) {
        return reply.code(409).send({
          error: {
            code: "VALIDATION_ERROR",
            category: "deterministic",
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
    return reply.header("Cache-Control", "no-store").code(204).send();
  });
}
