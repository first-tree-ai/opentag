import {
  machineCredentialsPath,
  readMachineCredentialsStrict,
  storeBoundAccountComputer,
  writeComputerIdentityAtomically,
} from "@opentag/client";
import { CommandError } from "../command/policy.js";

/**
 * Recover only the local files of an already-consumed exchange, never exchange a code or start a
 * daemon. The expected installation prevents accidentally reviving an older, revoked credential.
 * Rewriting the credential also retries durability/permissions after a post-rename write error.
 */
export async function repairLocalComputerConnection(options: { home: string; installationId: string }) {
  const credential = (
    await readMachineCredentialsStrict(options.home).catch((error: unknown) => {
      throw unavailableCredential(error);
    })
  )?.computer;
  if (!credential || credential.installationId !== options.installationId) {
    throw unavailableCredential();
  }
  try {
    await storeBoundAccountComputer(credential, options.home);
    await writeComputerIdentityAtomically(options.home, {
      version: 2,
      computerId: credential.installationId,
      serverUrl: credential.serverUrl,
    });
  } catch (error) {
    throw new CommandError(
      { code: "COMPUTER_LOCAL_PERSISTENCE_FAILED", category: "dependency", retryability: "never", phase: "startup" },
      "Local repair could not persist the Computer files. Fix storage permissions/free space, then retry repair-local. Do not reuse the consumed connect code.",
      { cause: error },
    );
  }
  return {
    computerId: credential.computerId,
    installationId: credential.installationId,
    credentialsPath: machineCredentialsPath(options.home),
    localPersistenceReady: true,
  };
}

function unavailableCredential(cause?: unknown): CommandError {
  return new CommandError(
    { code: "COMPUTER_CREDENTIAL_UNAVAILABLE", category: "dependency", retryability: "never", phase: "validation" },
    "The credential for this exchange is missing, unreadable, or belongs to another installation. Fix local storage and retry repair-local; if unavailable, request a NEW connect/repair code in OpenTag Web. Do not reuse the consumed code or assume previous credentials still work.",
    { cause },
  );
}
