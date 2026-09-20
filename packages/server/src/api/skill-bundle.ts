import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { SKILL_SHA256_HEADER, SKILL_UPLOAD_CONTENT_TYPE } from "@opentag/shared";
import type { FastifyReply } from "fastify";
import type { SkillBundle } from "../services/skills/index.js";

/**
 * Sends a stored Skill bundle as a streamed `application/octet-stream` response.
 *
 * `cache-control: no-store` keeps a bundle out of shared caches, the exact `content-length` lets a
 * reader bound the transfer, and the sha256 header lets the Computer verify the bytes against the
 * manifest entry it fetched, so a truncated or corrupted body never materializes as a Skill.
 *
 * `content-disposition` names the saved file. Without it a non-browser client — curl, the CLI,
 * another tool — saves an extensionless file that its own upload pre-check then rejects.
 */

const SAFE_SKILL_NAME = /^[a-z0-9-]{1,64}$/;
const FALLBACK_SKILL_NAME = "skill";

/**
 * The `content-disposition` value for one Skill bundle.
 *
 * `SkillNameSchema` already constrains a name to `[a-z0-9-]`, so this is defence in depth: the
 * header is built through one guard that refuses anything outside that set, and a future loosening
 * of the name rule can therefore never turn a name into a quoted filename with separators or a
 * newline (header injection). A rejected name yields `skill.tar.gz`.
 */
export function skillBundleDisposition(name: string): string {
  const safe = SAFE_SKILL_NAME.test(name) ? name : FALLBACK_SKILL_NAME;
  return `attachment; filename="${safe}.tar.gz"`;
}

export function sendSkillBundle(reply: FastifyReply, bundle: SkillBundle): FastifyReply {
  reply.header("cache-control", "no-store");
  reply.header("content-type", SKILL_UPLOAD_CONTENT_TYPE);
  reply.header("content-length", String(bundle.bytes));
  reply.header("content-disposition", skillBundleDisposition(bundle.skill.name));
  reply.header(SKILL_SHA256_HEADER, bundle.sha256);
  return reply.send(Readable.fromWeb(bundle.stream as WebReadableStream<Uint8Array>));
}
