import { lookup } from "node:dns/promises";
import { isBlockedAddress } from "@opentag/shared";

export type HostLookup = (hostname: string) => Promise<readonly string[]>;

export const lookupAddresses: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((record) => record.address);

/**
 * Refuse a hostname that resolves to a private or loopback address. `checkOutboundUrl` is lexical and
 * cannot see DNS, so a public-looking name pointing inside the network would pass it. This is a
 * pre-flight check for an operator's CLI, not the Server's pinned outbound gate: the later request
 * resolves the name again.
 */
export async function assertPublicDestination(hostname: string, resolve: HostLookup): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new Error(`cannot resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new Error(`${hostname} resolved to no address`);
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked !== undefined) throw new Error(`${hostname} resolves to a non-public address (${blocked})`);
}
