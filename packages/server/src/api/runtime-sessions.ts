import {
  HTTP_PATHS,
  SESSION_CLI_PROOF_HEADER,
  SessionCliCommandResponseSchema,
  SessionCliCreateRequestSchema,
  SessionCliListQuerySchema,
  SessionCliListResponseSchema,
  SessionCliSendRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import type { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import type { SessionService } from "../services/sessions/session-service.js";
import { parseRequest } from "./request-validation.js";

export interface RuntimeSessionRoutesOptions {
  collaboration: Pick<SessionCollaborationService, "create" | "send">;
  proofs: Pick<SessionCliProofService, "authenticate">;
  sessions: Pick<SessionService, "listInternalSessions">;
}

export function registerRuntimeSessionRoutes(app: FastifyInstance, options: RuntimeSessionRoutesOptions): void {
  app.post(HTTP_PATHS.runtimeInternalSessions, async (request, reply) => {
    const source = await authenticate(request, options.proofs);
    const input = parseRequest(SessionCliCreateRequestSchema, request.body);
    const result = SessionCliCommandResponseSchema.parse(await options.collaboration.create(input, source));
    return reply.code(200).send(result);
  });

  app.post(HTTP_PATHS.runtimeSessionMessages, async (request, reply) => {
    const source = await authenticate(request, options.proofs);
    const input = parseRequest(SessionCliSendRequestSchema, request.body);
    const result = SessionCliCommandResponseSchema.parse(await options.collaboration.send(input, source));
    return reply.code(200).send(result);
  });

  app.get(HTTP_PATHS.runtimeSessions, async (request, reply) => {
    const source = await authenticate(request, options.proofs);
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const query = parseRequest(SessionCliListQuerySchema, {
      recursive:
        raw.recursive === undefined
          ? undefined
          : raw.recursive === "true" || raw.recursive === true
            ? true
            : raw.recursive === "false" || raw.recursive === false
              ? false
              : raw.recursive,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      cursor: raw.cursor,
      since: raw.since,
    });
    const result = SessionCliListResponseSchema.parse(
      await options.sessions.listInternalSessions(source.sessionId, query),
    );
    return reply.code(200).send(result);
  });
}

async function authenticate(request: FastifyRequest, proofs: RuntimeSessionRoutesOptions["proofs"]) {
  const header = request.headers[SESSION_CLI_PROOF_HEADER];
  if (typeof header !== "string") return proofs.authenticate("");
  return proofs.authenticate(header);
}
