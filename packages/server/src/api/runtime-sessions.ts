import {
  HTTP_PATHS,
  SESSION_CLI_PROOF_HEADER,
  SessionCliCommandResponseSchema,
  SessionCliCreateRequestSchema,
  SessionCliListQuerySchema,
  SessionCliListResponseSchema,
  SessionCliSendRequestSchema,
  SessionCliStopRequestSchema,
  SessionCliStopResponseSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import type { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import type { SessionService } from "../services/sessions/session-service.js";
import { parseRequest } from "./request-validation.js";

export interface RuntimeSessionRoutesOptions {
  collaboration: Pick<SessionCollaborationService, "create" | "send" | "stop">;
  proofs: Pick<SessionCliProofService, "authenticate">;
  sessions: Pick<SessionService, "listInternalSessions">;
}

export function registerRuntimeSessionRoutes(app: FastifyInstance, options: RuntimeSessionRoutesOptions): void {
  app.post(HTTP_PATHS.runtimeInternalSessions, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const source = await authenticate(request, options.proofs);
    const input = parseRequest(SessionCliCreateRequestSchema, request.body);
    const result = SessionCliCommandResponseSchema.parse(await options.collaboration.create(input, source));
    return reply.header("Cache-Control", "no-store").code(200).send(result);
  });

  app.post(HTTP_PATHS.runtimeSessionMessages, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const source = await authenticate(request, options.proofs);
    const input = parseRequest(SessionCliSendRequestSchema, request.body);
    const result = SessionCliCommandResponseSchema.parse(await options.collaboration.send(input, source));
    return reply.header("Cache-Control", "no-store").code(200).send(result);
  });

  app.post(HTTP_PATHS.runtimeSessionStop, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const source = await authenticate(request, options.proofs);
    const input = parseRequest(SessionCliStopRequestSchema, request.body);
    const result = SessionCliStopResponseSchema.parse(await options.collaboration.stop(input, source));
    return reply.header("Cache-Control", "no-store").code(200).send(result);
  });

  app.get(HTTP_PATHS.runtimeSessions, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const source = await authenticate(request, options.proofs);
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = parseRequest(SessionCliListQuerySchema, {
      recursive: queryFlag(raw.recursive),
      includeStopped: queryFlag(raw.includeStopped),
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      cursor: raw.cursor,
      since: raw.since,
    });
    const result = SessionCliListResponseSchema.parse(
      await options.sessions.listInternalSessions(source.sessionId, query),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(result);
  });
}

/** A query string carries a flag as text; anything else stays as it came, for the schema to refuse. */
function queryFlag(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

async function authenticate(request: FastifyRequest, proofs: RuntimeSessionRoutesOptions["proofs"]) {
  const header = request.headers[SESSION_CLI_PROOF_HEADER];
  if (typeof header !== "string") return proofs.authenticate("");
  const execution = request.headers["x-opentag-execution-id"];
  return typeof execution === "string" ? proofs.authenticate(header, execution) : proofs.authenticate(header);
}
