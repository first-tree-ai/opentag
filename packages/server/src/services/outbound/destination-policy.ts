import { lookup } from "node:dns/promises";
import { isBlockedAddress, isIpLiteral, isLoopbackHostname } from "@opentag/shared";

/**
 * The address-resolution half of the outbound rules.
 *
 * The pure URL rules live in `@opentag/shared` (`mcp-outbound-url.ts`), because build-time tooling
 * applies the same ones to a catalog without depending on a built Server. What cannot live there is
 * resolution: only a process with a resolver can decide whether a *name* points somewhere private,
 * and a shared module that imported `node:dns` would stop being usable from the browser build.
 *
 * Two server features need that decision — the MCP gate and the Skill source transport — so it lives
 * here once and both call it. The verdict carries the address to dial so a caller that wants the
 * judgement to hold connects to *that* address instead of resolving again. The MCP fetcher is the one
 * caller that ignores the pin, and its own notes say why and what that costs.
 */

/**
 * Every address a hostname holds, A and AAAA together.
 *
 * `all: true` because a single-record lookup would make the verdict depend on resolver order: a name
 * with one public and one private address must be refused, and checking only the first would admit it
 * whenever the public record came back first.
 */
export async function resolveAllAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** The address a caller should dial, when the URL named a host rather than a literal. */
export interface OutboundDestinationPin {
  address: string;
  family: number;
}

/**
 * Why a destination was refused. `unreachable` is separated from `blocked` because the first is a
 * missing peer — worth retrying — and the second is a decision about the address.
 */
export type OutboundDestinationFailure =
  | { kind: "blocked"; host: string }
  | { kind: "unreachable"; host: string; cause?: string };

export type OutboundDestinationVerdict =
  | { ok: true; pin?: OutboundDestinationPin }
  | { ok: false; failure: OutboundDestinationFailure };

/** A literal needs no pin: the URL already names the address it wants dialed. */
function familyOf(address: string): number {
  return address.includes(":") ? 6 : 4;
}

/**
 * Refuse a hostname that resolves to a private address.
 *
 * The URL rules can only judge what a URL spells, and a hostname spells nothing about where it
 * points: `localtest.me` is public DNS that answers `127.0.0.1`, `metadata.google.internal` is a
 * split-horizon name, and a renamed `*.localhost` still lands on loopback. Since a probe or a fetch
 * stores and displays whatever answers, admitting these would make the promise "non-public
 * destinations are refused" untrue for the common case of a name rather than a literal.
 *
 * Every A and AAAA record is checked, not just the first: a name with one public and one private
 * address would otherwise be admitted or refused depending on resolver order.
 */
export async function classifyOutboundDestination(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<string[]> = resolveAllAddresses,
): Promise<OutboundDestinationVerdict> {
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  // A literal was already judged by the URL rules, and a loopback literal only got here because the
  // deployment opted into loopback.
  if (isIpLiteral(bare)) return { ok: true };
  if (isLoopbackHostname(bare)) return { ok: true };
  let addresses: string[];
  try {
    addresses = await resolveAddresses(bare);
  } catch (error) {
    // A name that does not resolve is an unreachable endpoint, not a blocked one: the caller's URL is
    // fine, the peer is missing. Reported as such so the UI says "could not be reached".
    return {
      ok: false,
      failure: { kind: "unreachable", host: bare, cause: error instanceof Error ? error.name : typeof error },
    };
  }
  const [first] = addresses;
  if (first === undefined) return { ok: false, failure: { kind: "unreachable", host: bare } };
  for (const address of addresses) {
    if (isBlockedAddress(address)) return { ok: false, failure: { kind: "blocked", host: bare } };
  }
  return { ok: true, pin: { address: first, family: familyOf(first) } };
}
