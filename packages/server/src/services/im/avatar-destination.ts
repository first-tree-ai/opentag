import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";
import { isBlockedAddress, isLoopbackHostname } from "@opentag/shared";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";
import type { ExternalCallTransport } from "./external-call-policy.js";

const AVATAR_DESTINATION_BLOCKED = "IM_AVATAR_DESTINATION_BLOCKED";
const AVATAR_REDIRECT_REJECTED = "IM_AVATAR_REDIRECT_REJECTED";
const MAX_AVATAR_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type AvatarAddressResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

function resolveAllAddresses(
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
): void {
  dnsLookup(hostname, options, callback);
}

function blockedDestination(hostname: string): NodeJS.ErrnoException {
  const error = new Error(`Avatar destination is not public: ${hostname}`) as NodeJS.ErrnoException;
  error.code = AVATAR_DESTINATION_BLOCKED;
  return error;
}

function redirectRejectedError(message: string, cause?: unknown): NodeJS.ErrnoException {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as NodeJS.ErrnoException;
  error.code = AVATAR_REDIRECT_REJECTED;
  return error;
}

function isIpLiteral(hostname: string): boolean {
  const candidate = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(candidate) !== 0) return true;
  try {
    return isIP(decodeURIComponent(candidate)) !== 0;
  } catch {
    return true;
  }
}

function hasEncodedAuthority(input: string): boolean {
  const authority = /^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/i.exec(input)?.[1];
  if (!authority) return false;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPort.includes("%");
}

function admitAvatarRedirectUrl(location: string, currentUrl: string | URL): URL {
  if (hasEncodedAuthority(location)) {
    throw redirectRejectedError("Encoded avatar redirect hosts are not allowed");
  }
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch (error) {
    throw redirectRejectedError("Avatar redirect target URL is invalid", error);
  }
  if (target.protocol !== "https:" || target.port !== "") {
    throw redirectRejectedError("Avatar redirect target must use HTTPS and its default port");
  }
  if (target.username !== "" || target.password !== "") {
    throw redirectRejectedError("Avatar redirect target must not include credentials");
  }
  const hostname = target.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!bareHost || isIpLiteral(bareHost) || isLoopbackHostname(hostname)) {
    throw blockedDestination(hostname || target.toString());
  }
  const asciiHost = domainToASCII(bareHost.replace(/\.+$/, ""));
  if (!asciiHost) {
    throw redirectRejectedError("Avatar redirect target hostname is invalid");
  }
  return target;
}

async function cancelResponseBody(response: { body: ReadableStream<Uint8Array> | null }): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: intermediate redirect responses are never relayed.
  }
}

function isUnsafeAddress(address: string): boolean {
  return isIP(address) === 0 || isBlockedAddress(address);
}

/**
 * Lookup used by the avatar dispatcher. Every DNS answer is checked before the socket is opened;
 * a mixed public/private result is rejected rather than depending on resolver order.
 */
export function createAvatarLookup(resolve: AvatarAddressResolver = resolveAllAddresses): LookupFunction {
  return (hostname, options, callback) => {
    if (isLoopbackHostname(hostname)) {
      callback(blockedDestination(hostname), "", 0);
      return;
    }
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeAddress(address))) {
        callback(blockedDestination(hostname), "", 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      if (!first) {
        callback(blockedDestination(hostname), "", 0);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** Create a dispatcher whose connection-time DNS lookup refuses non-public destinations. */
export function createAvatarDispatcher(resolve: AvatarAddressResolver = resolveAllAddresses): Dispatcher {
  return new Agent({
    connect: { lookup: createAvatarLookup(resolve) },
    maxCachedSessions: 0,
  });
}

export type AvatarTransport = ExternalCallTransport & { close(): Promise<void> };
type AvatarDispatcherFactory = (resolve: AvatarAddressResolver) => Dispatcher;

/** Create an avatar transport that always uses this package's fetch and connection-filtering Agent. */
export function createAvatarTransport(
  resolve: AvatarAddressResolver = resolveAllAddresses,
  dispatcherFactory: AvatarDispatcherFactory = createAvatarDispatcher,
): AvatarTransport {
  const dispatcher = dispatcherFactory(resolve);
  const transport: ExternalCallTransport = async (input, init = {}) => {
    let currentUrl: string | URL = input;
    let requestHeaders = init.headers === undefined ? undefined : Array.from(new Headers(init.headers).entries());
    let response = await undiciFetch(currentUrl, {
      headers: requestHeaders,
      redirect: "manual",
      signal: init.signal,
      dispatcher,
    });

    for (let redirects = 0; REDIRECT_STATUSES.has(response.status); ) {
      const location = response.headers.get("location")?.trim();
      await cancelResponseBody(response);
      redirects += 1;
      if (redirects > MAX_AVATAR_REDIRECTS) {
        throw redirectRejectedError(`Avatar redirect limit (${MAX_AVATAR_REDIRECTS}) exceeded`);
      }
      if (!location) {
        throw redirectRejectedError("Avatar redirect is missing a Location header");
      }
      currentUrl = admitAvatarRedirectUrl(location, currentUrl);
      requestHeaders = [["accept", "image/*"]];
      response = await undiciFetch(currentUrl, {
        headers: requestHeaders,
        redirect: "manual",
        signal: init.signal,
        dispatcher,
      });
    }

    const responseHeaders = Array.from(response.headers.entries()).filter(
      ([name]) => name !== "content-length" && name !== "content-encoding",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
  return Object.assign(transport, { close: () => dispatcher.close() });
}

let sharedAvatarTransport: AvatarTransport | undefined;

/** Create the shared avatar transport only when an authenticated avatar is fetched. */
export function getAvatarTransport(): AvatarTransport {
  sharedAvatarTransport ??= createAvatarTransport();
  return sharedAvatarTransport;
}
