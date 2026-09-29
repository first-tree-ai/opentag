import {
  checkOutboundUrl,
  type McpOutboundUrlFailure,
  SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
  SKILL_SOURCE_HTTP_TIMEOUT_MS,
} from "@opentag/shared";
import { classifyOutboundDestination, resolveAllAddresses } from "../../outbound/destination-policy.js";
import type { SkillServiceError } from "../errors.js";
import { skillSourceBlocked, skillSourceInvalid, skillSourceUnreachable } from "../errors.js";
import { nodeSkillSourceTransport, type SkillSourceTransport } from "./source-transport.js";

/**
 * The only place the remote-install feature dials a URL.
 *
 * It applies the shared outbound address rules to every request — including the URLs a well-known
 * index or an artifact points at — and then hands the approved address to the transport, which dials
 * *that* address. A name that resolves differently after the check therefore cannot redirect the
 * connection; the check and the connection speak about the same address.
 *
 * Each failure is mapped to the Skill source vocabulary. The shared verdict's own wording is not
 * forwarded: it describes internal concepts, and a caller pasting a URL needs to know what about
 * their source could not be used, not where the address check happened to fail.
 *
 * `services/skills/source/**` must not dial anywhere else; a test scans the directory.
 */

export interface SkillSourceFetcherOptions {
  /**
   * Whether plain HTTP to a loopback host is allowed. Set only by a local-development opt-in,
   * exactly as the MCP gate does; false in a hosted deployment.
   */
  allowLoopback: boolean;
  transport?: SkillSourceTransport;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SkillSourceFetchResult {
  /** The URL that answered. Redirects are refused, so this is always the requested URL. */
  url: string;
  status: number;
  bytes: Uint8Array;
}

function sourceFailure(failure: McpOutboundUrlFailure): SkillServiceError {
  return failure.kind === "invalid" ? skillSourceInvalid() : skillSourceBlocked();
}

export class SkillSourceFetcher {
  readonly #maxBytes: number;
  readonly #options: SkillSourceFetcherOptions;
  readonly #resolveAddresses: (hostname: string) => Promise<string[]>;
  readonly #timeoutMs: number;
  readonly #transport: SkillSourceTransport;

  constructor(options: SkillSourceFetcherOptions) {
    this.#options = options;
    this.#transport = options.transport ?? nodeSkillSourceTransport;
    this.#resolveAddresses = options.resolveAddresses ?? resolveAllAddresses;
    this.#timeoutMs = options.timeoutMs ?? SKILL_SOURCE_HTTP_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? SKILL_SOURCE_DOWNLOAD_MAX_BYTES;
  }

  /**
   * Fetches one document or artifact. `maxBytes` may narrow the fetcher's own cap for a caller that
   * knows it is reading something small — a well-known index, or one file of a Skill whose budget is
   * nearly spent.
   */
  async fetchBytes(url: string, maxBytes = this.#maxBytes): Promise<SkillSourceFetchResult> {
    const result = await this.#request(url, maxBytes);
    if (result.status >= 400) throw skillSourceUnreachable(`That source returned HTTP ${result.status}`);
    return result;
  }

  /**
   * Fetches without treating a 4xx as a failure, for a probe that is allowed to come back empty: a
   * well-known index is *allowed* not to exist, and that absence selects the fallback path rather
   * than reporting an error. Transport failures, redirects, and the byte cap still fail.
   */
  async fetchBytesAllowMissing(url: string, maxBytes = this.#maxBytes): Promise<SkillSourceFetchResult> {
    return this.#request(url, maxBytes);
  }

  async #request(url: string, maxBytes: number): Promise<SkillSourceFetchResult> {
    const policy = { allowLoopback: this.#options.allowLoopback };
    const target = checkOutboundUrl(url, policy);
    if ("failure" in target) throw sourceFailure(target.failure);
    const destination = await classifyOutboundDestination(target.url, this.#resolveAddresses);
    if (!destination.ok) {
      throw destination.failure.kind === "blocked" ? skillSourceBlocked() : skillSourceUnreachable();
    }
    if (maxBytes > this.#maxBytes) maxBytes = this.#maxBytes;
    const response = await this.#transport({
      url: target.url,
      ...(destination.pin === undefined ? {} : { pin: destination.pin }),
      maxBytes,
      timeoutMs: this.#timeoutMs,
    });
    if (response.status >= 300 && response.status < 400) {
      // The `Location` header is never read: the gate cannot approve a destination the peer chose.
      throw skillSourceBlocked("That source redirected to another address");
    }
    return { url: target.url.toString(), status: response.status, bytes: response.bytes };
  }
}
