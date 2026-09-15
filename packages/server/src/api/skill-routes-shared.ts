import { SKILL_ARCHIVE_MAX_BYTES } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type OpenedSkillArchive,
  type SkillAssignmentService,
  type SkillChangeNotifier,
  type SkillService,
  skillArchiveTooLarge,
  skillArchiveUnsupportedMediaType,
  skillStorageUnavailable,
} from "../services/skills/index.js";

/** Services the skill routes need. Any of them may be absent when storage is not configured: routes then answer 503. */
export interface SkillRouteServices {
  skills?: SkillService;
  assignments?: SkillAssignmentService;
  notifier?: SkillChangeNotifier;
}

export interface ResolvedSkillServices {
  skills: SkillService;
  assignments: SkillAssignmentService;
}

const ZIP_MEDIA_TYPE = "application/zip";

export function requireSkillServices(services: SkillRouteServices): ResolvedSkillServices {
  if (!services.skills || !services.assignments) throw skillStorageUnavailable();
  return { skills: services.skills, assignments: services.assignments };
}

/** Runs before body parsing so a non-zip upload is refused with the skill error code rather than a generic 415. */
export async function requireZipContentType(request: FastifyRequest): Promise<void> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== ZIP_MEDIA_TYPE) throw skillArchiveUnsupportedMediaType();
}

/**
 * Buffers an `application/zip` body up to the archive limit. Registered once per app: both the account upload and the
 * in-session push share it, and a second registration would fail.
 */
export function registerZipContentTypeParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser(ZIP_MEDIA_TYPE)) return;
  app.addContentTypeParser(ZIP_MEDIA_TYPE, (request, payload, done) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > SKILL_ARCHIVE_MAX_BYTES) {
      done(skillArchiveTooLarge(`Skill archives must be at most ${SKILL_ARCHIVE_MAX_BYTES} bytes`, 413));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (error: Error | null, body?: Buffer) => {
      if (settled) return;
      settled = true;
      done(error, body);
    };
    payload.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > SKILL_ARCHIVE_MAX_BYTES) {
        chunks.length = 0;
        settle(skillArchiveTooLarge(`Skill archives must be at most ${SKILL_ARCHIVE_MAX_BYTES} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });
    payload.on("end", () => settle(null, Buffer.concat(chunks)));
    payload.on("error", (error: Error) => settle(error));
  });
}

export function zipBody(request: FastifyRequest): Uint8Array {
  if (!Buffer.isBuffer(request.body)) throw skillArchiveUnsupportedMediaType();
  return new Uint8Array(request.body.buffer, request.body.byteOffset, request.body.byteLength);
}

function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  return raw
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

/** Streams a skill archive with the headers both the browser download and the daemon sync rely on. */
export async function sendSkillArchive(
  request: FastifyRequest,
  reply: FastifyReply,
  archive: OpenedSkillArchive,
): Promise<FastifyReply> {
  const etag = `"${archive.archiveSha256}"`;
  reply.header("etag", etag);
  reply.header("cache-control", "private, no-cache");
  reply.header("x-content-type-options", "nosniff");
  if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) return reply.code(304).send();
  const opened = await archive.open();
  reply.header("content-type", ZIP_MEDIA_TYPE);
  reply.header("content-length", String(opened.contentLength));
  reply.header("content-disposition", `attachment; filename="${archive.name}.zip"`);
  return reply.code(200).send(opened.stream);
}

/** Notification is best effort: a daemon that misses the frame converges on its next reconcile. */
export async function notifySkillChange(
  request: FastifyRequest,
  notifier: SkillChangeNotifier | undefined,
  agentIds: readonly string[],
): Promise<void> {
  if (!notifier || agentIds.length === 0) return;
  try {
    await notifier.notifyAgents(agentIds);
  } catch (error) {
    request.log.warn({ err: error, agentCount: agentIds.length }, "Skill change notification failed");
  }
}
