import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_FORMAT_HEADER,
  SKILL_REPLACE_HEADER,
  SKILL_SHA256_HEADER,
  SKILL_UPLOAD_CONTENT_TYPE,
  type SkillArchiveFormat,
  SkillArchiveFormatSchema,
  SkillArchiveSha256Schema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { skillArchiveInvalid, skillArchiveTooLarge } from "../services/skills/index.js";

/**
 * Shared octet-stream upload transport for the Account and Agent CLI POSTs.
 *
 * The archive streams through the Server rather than via a presigned URL, so the bucket stays
 * private and authorization stays in one place. Each route is its own encapsulated Fastify scope:
 * an `application/octet-stream` pass-through parser hands the raw request stream to the handler, and
 * authentication runs as an `onRequest` hook — before the parser, and therefore before any body byte
 * is consumed. Header preconditions are validated before reading, the body read is byte-counted and
 * aborts past the exact declared length, and a transfer deadline destroys a peer that stalls.
 */

export interface SkillUploadFrame {
  bytes: Uint8Array;
  format: SkillArchiveFormat;
  declaredSha256: string;
  replace: boolean;
}

export interface SkillUploadRouteOptions {
  path: string;
  /** Authentication, run in `onRequest` before the body parser. */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Validated as the raw frame; the caller adds the surface-specific source and service call. */
  upload: (request: FastifyRequest, frame: SkillUploadFrame) => Promise<unknown>;
  transferTimeoutMs?: number;
}

const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
const CONTENT_LENGTH_PATTERN = /^[0-9]{1,10}$/;

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Every precondition is checked here, before a single body byte is read. */
function parseUploadHeaders(request: FastifyRequest): {
  declaredBytes: number;
  declaredSha256: string;
  format: SkillArchiveFormat;
  replace: boolean;
} {
  if (singleHeader(request, "content-type") !== SKILL_UPLOAD_CONTENT_TYPE) {
    throw skillArchiveInvalid(`The Skill archive body must be ${SKILL_UPLOAD_CONTENT_TYPE}`);
  }
  if (request.headers["transfer-encoding"] !== undefined) {
    throw skillArchiveInvalid("The Skill archive upload requires an exact Content-Length");
  }
  const contentLength = singleHeader(request, "content-length");
  if (contentLength === undefined || !CONTENT_LENGTH_PATTERN.test(contentLength)) {
    throw skillArchiveInvalid("The Content-Length header is required and must be a decimal length");
  }
  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
    throw skillArchiveInvalid("The Skill archive size is outside the allowed bounds");
  }
  if (declaredBytes > SKILL_ARCHIVE_MAX_BYTES) throw skillArchiveTooLarge();
  const sha256 = singleHeader(request, SKILL_SHA256_HEADER);
  if (sha256 === undefined || !SkillArchiveSha256Schema.safeParse(sha256).success) {
    throw skillArchiveInvalid(`The ${SKILL_SHA256_HEADER} header is required and must be a lowercase hex sha256`);
  }
  const rawFormat = singleHeader(request, SKILL_FORMAT_HEADER);
  const format = SkillArchiveFormatSchema.safeParse(rawFormat ?? "tar.gz");
  if (!format.success) throw skillArchiveInvalid(`The ${SKILL_FORMAT_HEADER} header is invalid`);
  const rawReplace = singleHeader(request, SKILL_REPLACE_HEADER);
  if (rawReplace !== undefined && rawReplace !== "true") {
    throw skillArchiveInvalid(`The ${SKILL_REPLACE_HEADER} header must be true when present`);
  }
  return { declaredBytes, declaredSha256: sha256, format: format.data, replace: rawReplace === "true" };
}

/** Reads exactly `declaredBytes` from the raw stream, aborting on overrun or truncation. */
async function readExactBody(request: FastifyRequest, declaredBytes: number): Promise<Uint8Array> {
  const body: unknown = request.body;
  if (body === null || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw skillArchiveInvalid("The Skill archive body stream is required");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > declaredBytes) throw skillArchiveInvalid("The Skill archive body exceeded its declared length");
    chunks.push(Buffer.from(chunk));
  }
  if (total !== declaredBytes) throw skillArchiveInvalid("The Skill archive body was shorter than its declared length");
  return new Uint8Array(Buffer.concat(chunks));
}

export function registerSkillUploadRoute(app: FastifyInstance, options: SkillUploadRouteOptions): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(SKILL_UPLOAD_CONTENT_TYPE, (_request, payload, done) => {
      done(null, payload);
    });
    scope.addHook("onRequest", async (request, reply) => {
      await options.authenticate(request, reply);
    });
    scope.post(options.path, async (request, reply) => {
      // Bound elapsed transfer time, including a peer that sends no bytes, and destroy its stream so
      // a stalled read cannot pin the request open.
      const timer = setTimeout(
        () => request.raw.destroy(new Error("Skill archive upload deadline exceeded")),
        options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
      );
      timer.unref();
      const onStreamError = () => undefined;
      request.raw.on("error", onStreamError);
      try {
        const headers = parseUploadHeaders(request);
        const bytes = await readExactBody(request, headers.declaredBytes);
        const frame: SkillUploadFrame = {
          bytes,
          format: headers.format,
          declaredSha256: headers.declaredSha256,
          replace: headers.replace,
        };
        const response = await options.upload(request, frame);
        return reply.code(200).send(response);
      } finally {
        clearTimeout(timer);
        request.raw.off("error", onStreamError);
      }
    });
  });
}
