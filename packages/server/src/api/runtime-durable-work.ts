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
  RuntimeDurableWorkCursorError,
  RuntimeDurableWorkPayloadTooLargeError,
  RuntimeDurableWorkQuotaExceededError,
  RuntimeDurableWorkStaleWriteError,
  RuntimeDurableWorkTimestampError,
  RuntimeDurableWorkTransitionError,
} from "../runtime/runtime-durable-work-store.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

const QuerySchema = z
  .object({
    kind: RuntimeDurableWorkKindSchema,
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(1024).optional(),
  })
  .strict();
const ParamsSchema = z.object({ kind: RuntimeDurableWorkKindSchema, key: z.string().min(1).max(128) }).strict();

export interface RuntimeDurableWorkRoutesOptions {
  machineAuth: ComputerAuthVerifier;
  store: Pick<PostgresRuntimeDurableWorkStore, "list" | "write">;
}

function computerId(request: FastifyRequest): string {
  const value = request.computerAuthContext?.computerId;
  if (!value) throw new Error("Authenticated Computer context is missing");
  return value;
}

export function registerRuntimeDurableWorkRoutes(app: FastifyInstance, options: RuntimeDurableWorkRoutesOptions): void {
  const preHandler = createComputerAuthPreHandler(options.machineAuth);
  app.get(HTTP_PATHS.runtimeDurableWork, { preHandler }, async (request, reply) => {
    const query = parseRequest(QuerySchema, request.query);
    try {
      const page =
        query.cursor || query.limit !== undefined
          ? await options.store.list(computerId(request), query.kind, {
              ...(query.cursor ? { cursor: query.cursor } : {}),
              ...(query.limit !== undefined ? { limit: query.limit } : {}),
            })
          : await options.store.list(computerId(request), query.kind);
      return reply.header("Cache-Control", "no-store").code(200).send(RuntimeDurableWorkListResponseSchema.parse(page));
    } catch (error) {
      if (error instanceof RuntimeDurableWorkCursorError) {
        return reply.code(400).send(errorEnvelope("VALIDATION_ERROR", "validation", error.message, request.id));
      }
      throw error;
    }
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
      const response = writeErrorResponse(error, request.id);
      if (response) return reply.code(response.statusCode).send(response.body);
      throw error;
    }
    return reply.header("Cache-Control", "no-store").code(204).send();
  });
}

function errorEnvelope(
  code: "RATE_LIMITED" | "VALIDATION_ERROR",
  category: "rate_limit" | "validation" | "deterministic",
  message: string,
  requestId: string,
) {
  return { error: { code, category, message, requestId } };
}

function writeErrorResponse(
  error: unknown,
  requestId: string,
): { statusCode: number; body: ReturnType<typeof errorEnvelope> } | undefined {
  if (
    error instanceof RuntimeDurableWorkConflictError ||
    error instanceof RuntimeDurableWorkStaleWriteError ||
    error instanceof RuntimeDurableWorkTransitionError
  ) {
    return { statusCode: 409, body: errorEnvelope("VALIDATION_ERROR", "deterministic", error.message, requestId) };
  }
  if (error instanceof RuntimeDurableWorkQuotaExceededError) {
    return { statusCode: 429, body: errorEnvelope("RATE_LIMITED", "rate_limit", error.message, requestId) };
  }
  if (error instanceof RuntimeDurableWorkPayloadTooLargeError || error instanceof RuntimeDurableWorkTimestampError) {
    return {
      statusCode: error instanceof RuntimeDurableWorkPayloadTooLargeError ? 413 : 400,
      body: errorEnvelope("VALIDATION_ERROR", "validation", error.message, requestId),
    };
  }
  return undefined;
}
