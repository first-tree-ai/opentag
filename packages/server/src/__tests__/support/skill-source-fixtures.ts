import { SKILL_SOURCE_DOWNLOAD_MAX_BYTES } from "@opentag/shared";
import { skillSourceTooLarge } from "../../services/skills/index.js";
import { SkillSourceFetcher } from "../../services/skills/source/source-fetcher.js";
import type { SkillSourceTransport } from "../../services/skills/source/source-transport.js";
import { bytesOf } from "./skill-archive-fixtures.js";

/**
 * The source-side test doubles.
 *
 * The transport, not `fetch`, is the seam: the production transport exists precisely because `fetch`
 * cannot pin the address it dials, so a double that answered `fetch` would not exercise the code
 * under test. A stub can also assert what it was asked to dial, which is how the address pin is
 * covered.
 */

export const PUBLIC_ADDRESS = "93.184.216.34";

export interface StubAnswer {
  status: number;
  body?: Uint8Array | string;
}

/** A transport that answers from a route map keyed by the exact URL; a missing route is a 404. */
export function staticTransport(routes: Record<string, () => StubAnswer | undefined>): SkillSourceTransport {
  return async (input) => {
    const answer = routes[input.url.toString()]?.();
    if (answer === undefined) return { status: 404, bytes: new Uint8Array() };
    // Mirrors the production transport: an error response carries no body to the caller.
    if (answer.status < 200 || answer.status >= 300) return { status: answer.status, bytes: new Uint8Array() };
    const bytes =
      answer.body === undefined
        ? new Uint8Array()
        : typeof answer.body === "string"
          ? bytesOf(answer.body)
          : answer.body;
    if (bytes.byteLength > input.maxBytes) throw skillSourceTooLarge();
    return { status: answer.status, bytes };
  };
}

export interface StubFetcherOptions {
  allowLoopback?: boolean;
  maxBytes?: number;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  requests?: { url: string; maxBytes: number }[];
}

/**
 * A fetcher whose only dial is the stub. Every request is recorded, so a test can assert both the URL
 * and the per-request byte allowance — the allowance is what bounds a multi-file Skill.
 */
export function stubFetcher(
  routes: Record<string, () => StubAnswer | undefined>,
  options: StubFetcherOptions = {},
): SkillSourceFetcher {
  const transport = staticTransport(routes);
  return new SkillSourceFetcher({
    allowLoopback: options.allowLoopback === true,
    resolveAddresses: options.resolveAddresses ?? (async () => [PUBLIC_ADDRESS]),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    transport: (request) => {
      options.requests?.push({ url: request.url.toString(), maxBytes: request.maxBytes });
      return transport(request);
    },
  });
}

/** A fetcher whose transport must never be reached, for the refusal cases. */
export function unreachableFetcher(options: StubFetcherOptions = {}): SkillSourceFetcher {
  return stubFetcher({}, options);
}

export const DEFAULT_DOWNLOAD_LIMIT = SKILL_SOURCE_DOWNLOAD_MAX_BYTES;
