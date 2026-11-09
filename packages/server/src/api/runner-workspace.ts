import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES,
  RUNNER_WORKSPACE_PATH,
  RUNNER_WORKSPACE_TIMEOUT_MS,
  RunnerWorkspaceObjectSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  RUNNER_WORKSPACE_ERROR_CODES,
  type RunnerWorkspaceContext,
  RunnerWorkspaceError,
  type RunnerWorkspaceService,
} from "../services/sandboxes/runner-workspace-service.js";

/**
 * E5 Runner workspace HTTP API. Runners restore and save their workspace archives through these
 * streaming endpoints; the WSS control channel carries only small frames. Every route
 * authenticates the allocation-scoped bootstrap bearer token in `onRequest` — before any content
 * parser runs — and the service derives the storage identity from the database, so a caller can
 * never supply a path, a URI, or another Session's storage. The archive body is streamed straight
 * into the object store (never whole-body buffered), bounded by the shared 512 MiB ceiling and an
 * exact Content-Length contract. Errors are stable and redacted: no credential, header, body, or
 * upstream Google response content is logged or echoed.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the workspace onRequest hook; authentication precedes body parsing. */
    runnerWorkspaceContext?: RunnerWorkspaceContext;
  }
}

const OCTET_STREAM = "application/octet-stream";

const ArchiveQuerySchema = z
  .object({
    generation: RunnerWorkspaceObjectSchema.shape.generation,
    metageneration: RunnerWorkspaceObjectSchema.shape.metageneration,
  })
  .strict();

async function fail(reply: FastifyReply, statusCode: number, code: string, message: string): Promise<FastifyReply> {
  if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.headersSent) return reply;
  reply.header("cache-control", "no-store");
  return reply.code(statusCode).send({ error: { code, message } });
}

function failWith(reply: FastifyReply, error: RunnerWorkspaceError): Promise<FastifyReply> {
  return fail(reply, error.statusCode, error.code, error.message);
}

function badRequest(message: string): RunnerWorkspaceError {
  return new RunnerWorkspaceError(400, RUNNER_WORKSPACE_ERROR_CODES.badRequest, message);
}

function requireContext(request: FastifyRequest): RunnerWorkspaceContext {
  const context = request.runnerWorkspaceContext;
  if (!context) {
    // The onRequest hook always resolves or rejects first; reaching here is a wiring defect.
    throw new RunnerWorkspaceError(503, RUNNER_WORKSPACE_ERROR_CODES.unavailable, "The request was not authenticated");
  }
  return context;
}

const ClaimBodySchema = z
  .object({
    fence: z.literal(true).optional(),
    upload: ArchiveQuerySchema.extend({ id: z.uuidv4() }).optional(),
  })
  .strict()
  .refine((body) => !(body.fence && body.upload));

function requireSingleHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`The ${name} header is required`);
  }
  return value;
}

function parsePinnedHeader(name: string, value: string, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(`The ${name} header is invalid`);
  return parsed.data;
}

/** Validate every upload precondition header before one byte of the body is consumed. */
function parseUploadHeaders(request: FastifyRequest): {
  generation: string;
  metageneration: string;
  sha256: string;
  md5: string;
  sealed: boolean;
  bytes: number;
  writeId?: string;
} {
  const contentType = request.headers["content-type"];
  if (contentType !== OCTET_STREAM) throw badRequest("The archive body must be application/octet-stream");
  if (request.headers["transfer-encoding"] !== undefined) {
    throw badRequest("The archive upload requires an exact Content-Length");
  }
  const contentLength = requireSingleHeader(request, "content-length");
  if (!/^[0-9]{1,10}$/.test(contentLength)) throw badRequest("The Content-Length header is invalid");
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES) {
    throw badRequest("The archive size is outside the allowed bounds");
  }
  const generation = parsePinnedHeader(
    "x-opentag-storage-generation",
    requireSingleHeader(request, "x-opentag-storage-generation"),
    RunnerWorkspaceObjectSchema.shape.generation,
  );
  const metageneration = parsePinnedHeader(
    "x-opentag-storage-metageneration",
    requireSingleHeader(request, "x-opentag-storage-metageneration"),
    RunnerWorkspaceObjectSchema.shape.metageneration,
  );
  const sha256 = parsePinnedHeader(
    "x-opentag-workspace-sha256",
    requireSingleHeader(request, "x-opentag-workspace-sha256"),
    RunnerWorkspaceObjectSchema.shape.sha256,
  );
  const md5 = parsePinnedHeader(
    "content-md5",
    requireSingleHeader(request, "content-md5"),
    RunnerWorkspaceObjectSchema.shape.md5,
  );
  const sealedHeader = requireSingleHeader(request, "x-opentag-workspace-sealed");
  if (sealedHeader !== "true" && sealedHeader !== "false") {
    throw badRequest("The x-opentag-workspace-sealed header must be true or false");
  }
  const writeId = request.headers["x-opentag-workspace-write-id"];
  if (writeId !== undefined && !z.uuidv4().safeParse(writeId).success) {
    throw badRequest("The workspace write identity is invalid");
  }
  return {
    generation,
    metageneration,
    sha256,
    md5,
    sealed: sealedHeader === "true",
    bytes,
    ...(typeof writeId === "string" ? { writeId } : {}),
  };
}

/** The streaming parser must have surfaced the raw request stream; never a buffered body. */
function requireUploadStream(request: FastifyRequest): AsyncIterable<Uint8Array> {
  const body: unknown = request.body;
  if (body === null || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw badRequest("The archive body stream is required");
  }
  return body as AsyncIterable<Uint8Array>;
}

export function registerRunnerWorkspaceRoutes(
  app: FastifyInstance,
  workspace: RunnerWorkspaceService,
  options: { transferTimeoutMs?: number } = {},
): void {
  void app.register(async (scope) => {
    // Stream the archive body through untouched: the parser hands the request stream itself to
    // the handler, so up to 512 MiB never buffers in this process.
    scope.addContentTypeParser(OCTET_STREAM, (_request, payload, done) => {
      done(null, payload);
    });

    const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        request.runnerWorkspaceContext = await workspace.authenticate(request.headers.authorization);
      } catch (error) {
        if (error instanceof RunnerWorkspaceError) {
          await failWith(reply, error);
          return;
        }
        throw error;
      }
    };

    scope.post(
      `${RUNNER_WORKSPACE_PATH}/claim`,
      { bodyLimit: 1_024, onRequest: authenticate },
      async (request, reply) => {
        try {
          const context = requireContext(request);
          const options = ClaimBodySchema.safeParse(request.body === undefined ? {} : request.body);
          if (!options.success) throw badRequest("The workspace claim payload is invalid");
          const object = await workspace.claim(context, options.data);
          reply.header("cache-control", "no-store");
          return await reply.code(200).send(object);
        } catch (error) {
          if (error instanceof RunnerWorkspaceError) return failWith(reply, error);
          throw error;
        }
      },
    );

    scope.post(
      `${RUNNER_WORKSPACE_PATH}/seal`,
      { bodyLimit: 1_024, onRequest: authenticate },
      async (request, reply) => {
        try {
          const context = requireContext(request);
          const pins = ArchiveQuerySchema.safeParse(request.body);
          if (!pins.success) throw badRequest("The workspace seal pins are invalid");
          const object = await workspace.sealArchive(context, pins.data);
          reply.header("cache-control", "no-store");
          return await reply.code(200).send(object);
        } catch (error) {
          if (error instanceof RunnerWorkspaceError) return failWith(reply, error);
          throw error;
        }
      },
    );

    scope.get(`${RUNNER_WORKSPACE_PATH}/archive`, { onRequest: authenticate }, async (request, reply) => {
      try {
        const context = requireContext(request);
        const pins = ArchiveQuerySchema.safeParse(request.query);
        if (!pins.success) throw badRequest("The archive pin query is invalid");
        const { object, stream } = await workspace.openArchive(context, pins.data);
        reply.header("cache-control", "no-store");
        reply.header("content-type", OCTET_STREAM);
        reply.header("content-length", String(object.bytes));
        reply.header("x-opentag-storage-generation", object.generation);
        reply.header("x-opentag-storage-metageneration", object.metageneration);
        reply.header("x-opentag-workspace-sha256", object.sha256);
        reply.header("content-md5", object.md5);
        return await reply.send(Readable.fromWeb(stream as WebReadableStream<Uint8Array>));
      } catch (error) {
        if (error instanceof RunnerWorkspaceError) return failWith(reply, error);
        throw error;
      }
    });

    scope.put(`${RUNNER_WORKSPACE_PATH}/archive`, { onRequest: authenticate }, async (request, reply) => {
      // The raw parser bypasses Fastify's buffered body limits. Bound elapsed transfer time,
      // including a peer that sends no body bytes, and destroy its stream to unblock store I/O.
      const timer = setTimeout(
        () => request.raw.destroy(new Error("Workspace upload deadline exceeded")),
        options.transferTimeoutMs ?? RUNNER_WORKSPACE_TIMEOUT_MS,
      );
      timer.unref();
      const onStreamError = () => undefined;
      request.raw.on("error", onStreamError);
      try {
        const context = requireContext(request);
        const headers = parseUploadHeaders(request);
        const object = await workspace.saveArchive(context, { ...headers, body: requireUploadStream(request) });
        reply.header("cache-control", "no-store");
        return await reply.code(200).send(object);
      } catch (error) {
        if (error instanceof RunnerWorkspaceError) return failWith(reply, error);
        throw error;
      } finally {
        clearTimeout(timer);
        request.raw.off("error", onStreamError);
      }
    });
  });
}
