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
 */
export function sendSkillBundle(reply: FastifyReply, bundle: SkillBundle): FastifyReply {
  reply.header("cache-control", "no-store");
  reply.header("content-type", SKILL_UPLOAD_CONTENT_TYPE);
  reply.header("content-length", String(bundle.bytes));
  reply.header(SKILL_SHA256_HEADER, bundle.sha256);
  return reply.send(Readable.fromWeb(bundle.stream as WebReadableStream<Uint8Array>));
}
