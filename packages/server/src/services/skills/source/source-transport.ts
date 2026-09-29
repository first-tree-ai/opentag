import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { SKILL_SOURCE_HTTP_TIMEOUT_MS } from "@opentag/shared";
import type { OutboundDestinationPin } from "../../outbound/destination-policy.js";
import { skillSourceTooLarge, skillSourceUnreachable } from "../errors.js";

/**
 * The HTTP transport for a Skill source: one request, to one already-approved address.
 *
 * `fetch` cannot express "connect here, but speak to this hostname": it resolves the URL's hostname
 * itself, which is exactly the rebinding step the address policy cannot see. So the request is built
 * by hand and the resolver is replaced with the approved address. The hostname stays on the request,
 * so the `Host` header, the TLS SNI, and the certificate check are all the URL's own: the address the
 * policy judged is the address that is dialed, and the peer's identity is still verified.
 *
 * Redirects are never followed — a 3xx is returned to the caller, which refuses it — because a
 * `Location` names a destination the policy never saw. `agent: false` keeps a pooled socket from
 * being reused for a different pin.
 */

export interface SkillSourceResponse {
  status: number;
  bytes: Uint8Array;
}

export interface SkillSourceTransportRequest {
  url: URL;
  /** The address to dial, from the address policy. Absent for a URL that names a literal. */
  pin?: OutboundDestinationPin;
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type SkillSourceTransport = (request: SkillSourceTransportRequest) => Promise<SkillSourceResponse>;

/**
 * A resolver that answers with the approved address, in both of the shapes `net.connect` asks for.
 *
 * Node calls `lookup` with `{{ all: true }}` when it is willing to try every address a name holds; the
 * pinned answer is a single address, so either shape resolves to it. Returning it here — rather than
 * connecting to it directly — keeps the hostname on the request, and with it the SNI, the certificate
 * check, and the `Host` header the peer routes on.
 */
function pinnedLookup(pin: OutboundDestinationPin): NonNullable<RequestOptions["lookup"]> {
  const lookup = (_hostname: string, options: { all?: boolean } | undefined, callback: unknown): void => {
    const done = callback as (error: null, ...rest: unknown[]) => void;
    if (options?.all === true) {
      done(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    done(null, pin.address, pin.family);
  };
  // The hostname is deliberately ignored: answering *any* name with the approved address is the
  // point, and the request still carries the name for `Host` and TLS.
  return lookup as NonNullable<RequestOptions["lookup"]>;
}

function requestOptions(input: SkillSourceTransportRequest, port: number, hostname: string): RequestOptions {
  return {
    method: "GET",
    host: hostname,
    port,
    path: `${input.url.pathname}${input.url.search}`,
    headers: { accept: "*/*", host: input.url.host },
    agent: false,
    ...(input.pin === undefined ? {} : { lookup: pinnedLookup(input.pin) }),
  };
}

function merge(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** The production transport: `node:http`/`node:https` with the address pinned. */
export const nodeSkillSourceTransport: SkillSourceTransport = (input) => {
  const secure = input.url.protocol === "https:";
  const port = input.url.port === "" ? (secure ? 443 : 80) : Number(input.url.port);
  const hostname = input.url.hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = input.timeoutMs ?? SKILL_SOURCE_HTTP_TIMEOUT_MS;

  return new Promise<SkillSourceResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = (secure ? httpsRequest : httpRequest)(requestOptions(input, port, hostname), (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        /*
         * An error body is neither buffered nor drained. The status is known from the headers, so the
         * response is destroyed there and then: draining it would keep consuming inbound bandwidth for
         * as long as the peer chose to send, up to the deadline, for a request the caller refuses
         * anyway. Destroying it closes the socket, so the peer cannot keep writing either.
         */
        response.destroy();
        settled = true;
        resolve({ status, bytes: new Uint8Array() });
        return;
      }
      // The declared length is checked first so an oversized body is refused without buffering it.
      const declared = Number(response.headers["content-length"] ?? "");
      if (Number.isFinite(declared) && declared > input.maxBytes) {
        response.destroy();
        fail(skillSourceTooLarge());
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > input.maxBytes) {
          response.destroy();
          fail(skillSourceTooLarge());
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => fail(skillSourceUnreachable()));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, bytes: merge(chunks, total) });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("deadline exceeded")), timeoutMs);
    timer.unref();
    const abort = () => request.destroy(new Error("aborted"));
    input.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", () => fail(skillSourceUnreachable()));
    request.on("close", () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    });
    request.end();
  });
};
