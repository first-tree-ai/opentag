import { createHmac, hkdfSync } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";

/**
 * Recognizing a machine after its local identity was lost.
 *
 * The Client sends a SHA-256 of its machine ID, OS user, and openTag home, so the raw identifier never
 * leaves the machine. The Server stores only an HMAC of that value keyed per Account, so the stored
 * value cannot be reversed or correlated across Accounts. The key is derived from the login secret:
 * rotating that secret makes recorded fingerprints stop matching until each computer connects once,
 * and a lost-identity reconnect in that window creates a new Computer, as it did before fingerprints.
 */
const KEY_INFO = "opentag-computer-fingerprint-v1";

export type MachineFingerprintKey = Buffer;

export function deriveMachineFingerprintKey(secret: string): MachineFingerprintKey {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32));
}

export function accountMachineFingerprint(key: MachineFingerprintKey, accountId: string, clientHash: string): string {
  return createHmac("sha256", key).update(`${accountId}\0${clientHash}`).digest("hex");
}

export interface FingerprintCandidateInput {
  readonly displayName: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: string;
}

/**
 * The one offline Computer a lost-identity reconnect may repair, or `undefined` to create a new one.
 *
 * Exactly one live Local Computer in the Account may carry the fingerprint, and it must be offline and
 * report the same name, platform, and architecture. An online match is a clone running from the same
 * image; several matches are ambiguous; a different name is most likely a different machine built from
 * the same image. In each of those cases taking over an existing Computer would be wrong, so nothing is
 * repaired. Candidates are locked after the Account and code locks, keeping the exchange's lock order.
 */
export async function lockFingerprintRepairTarget(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string;
    readonly fingerprint: string;
    readonly machine: FingerprintCandidateInput;
    readonly onlineSince: Date;
  },
): Promise<string | undefined> {
  const matches = await transaction
    .select({
      id: computers.id,
      displayName: computers.displayName,
      platform: computers.platform,
      arch: computers.arch,
      disconnectedAt: computers.disconnectedAt,
      currentInstanceId: computers.currentInstanceId,
      lastSeenAt: computers.lastSeenAt,
    })
    .from(computers)
    .where(
      and(
        eq(computers.ownerAccountId, input.accountId),
        eq(computers.machineFingerprint, input.fingerprint),
        eq(computers.kind, "local"),
        isNull(computers.deletedAt),
      ),
    )
    .orderBy(computers.id)
    .limit(2)
    .for("update");
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  if (!match) return undefined;
  const online =
    match.disconnectedAt === null &&
    match.currentInstanceId !== null &&
    (match.lastSeenAt?.getTime() ?? 0) >= input.onlineSince.getTime();
  if (online) return undefined;
  const sameMachine =
    match.displayName === input.machine.displayName &&
    match.platform === input.machine.platform &&
    match.arch === input.machine.arch;
  return sameMachine ? match.id : undefined;
}
