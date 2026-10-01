import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isBlockedAddress, isLoopbackHostname } from "@opentag/shared";
import { Agent, type Dispatcher, Dispatcher1Wrapper } from "undici";

const AVATAR_DESTINATION_BLOCKED = "IM_AVATAR_DESTINATION_BLOCKED";

type AvatarAddressResolver = (
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
  return new Dispatcher1Wrapper(
    new Agent({
      connect: { lookup: createAvatarLookup(resolve) },
      maxCachedSessions: 0,
    }),
  );
}

/** Shared dispatcher for authenticated avatar fetches. */
export const avatarDispatcher = createAvatarDispatcher();
