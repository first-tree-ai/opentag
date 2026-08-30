import { normalizeServerUrl } from "../api.js";
import { readMachineCredentialsStrict, type StoredMachineCredentials } from "../auth/machine-credentials.js";
import { type ComputerIdentity, readComputerIdentity } from "./computer-identity.js";

export type LocalConfigurationStatus = "valid" | "missing" | "invalid";

export interface LocalComputerConfigurationInspection {
  identity: {
    status: LocalConfigurationStatus;
    value?: ComputerIdentity;
    detail?: string;
  };
  credentials: {
    status: LocalConfigurationStatus;
    value?: StoredMachineCredentials;
    detail?: string;
  };
  binding: {
    status: LocalConfigurationStatus;
    credentialCount: number;
    serverUrl?: string;
    detail?: string;
  };
}

/** Strict, read-only inspection of the Computer identity and stored Computer credential. */
export async function inspectLocalComputerConfiguration(home: string): Promise<LocalComputerConfigurationInspection> {
  const [identityResult, credentialsResult] = await Promise.allSettled([
    readComputerIdentity(home),
    readMachineCredentialsStrict(home),
  ]);

  const identity = inspectIdentity(identityResult);
  const credentials = inspectCredentials(credentialsResult);
  if (identity.status !== "valid" || credentials.status !== "valid") {
    return {
      identity,
      credentials,
      binding: {
        status: "invalid",
        credentialCount: credentials.value ? 1 : 0,
        detail: "A valid identity and Computer credential are required before their binding can be verified",
      },
    };
  }

  const identityValue = identity.value;
  const credentialsValue = credentials.value;
  if (!identityValue || !credentialsValue) {
    return {
      identity,
      credentials,
      binding: { status: "invalid", credentialCount: 0, detail: "Validated local configuration is incomplete" },
    };
  }

  const stored = credentialsValue.computer;
  if (stored.computerId !== identityValue.computerId) {
    return {
      identity,
      credentials,
      binding: {
        status: "invalid",
        credentialCount: 1,
        detail: "Stored Computer credentials do not belong to the local Computer identity",
      },
    };
  }
  try {
    if (normalizeServerUrl(stored.serverUrl) !== stored.serverUrl) {
      return {
        identity,
        credentials,
        binding: {
          status: "invalid",
          credentialCount: 1,
          detail: "The stored Computer credential contains a non-canonical Server origin",
        },
      };
    }
  } catch {
    return {
      identity,
      credentials,
      binding: {
        status: "invalid",
        credentialCount: 1,
        detail: "The stored Computer credential contains an invalid Server origin",
      },
    };
  }
  if (identityValue.serverUrl !== stored.serverUrl) {
    return {
      identity,
      credentials,
      binding: {
        status: "invalid",
        credentialCount: 1,
        detail: "The Computer identity and stored credential refer to different Server origins",
      },
    };
  }

  return {
    identity,
    credentials,
    binding: { status: "valid", credentialCount: 1, serverUrl: stored.serverUrl },
  };
}

function inspectIdentity(
  result: PromiseSettledResult<ComputerIdentity | undefined>,
): LocalComputerConfigurationInspection["identity"] {
  if (result.status === "rejected") {
    return { status: "invalid", detail: safeErrorDetail(result.reason, "Computer identity could not be read") };
  }
  if (!result.value) return { status: "missing", detail: "Computer identity is not configured" };
  try {
    if (normalizeServerUrl(result.value.serverUrl) !== result.value.serverUrl) {
      return { status: "invalid", detail: "Computer identity contains a non-canonical Server origin" };
    }
  } catch {
    return { status: "invalid", detail: "Computer identity contains an invalid Server origin" };
  }
  return { status: "valid", value: result.value };
}

function inspectCredentials(
  result: PromiseSettledResult<StoredMachineCredentials | undefined>,
): LocalComputerConfigurationInspection["credentials"] {
  if (result.status === "rejected") {
    return { status: "invalid", detail: safeErrorDetail(result.reason, "Computer credentials could not be read") };
  }
  if (!result.value) {
    return { status: "missing", detail: "No Computer credentials are configured" };
  }
  try {
    if (normalizeServerUrl(result.value.computer.serverUrl) !== result.value.computer.serverUrl) {
      return { status: "invalid", detail: "A stored Computer credential contains a non-canonical Server origin" };
    }
  } catch {
    return { status: "invalid", detail: "A stored Computer credential contains an invalid Server origin" };
  }
  return { status: "valid", value: result.value };
}

function safeErrorDetail(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return error.message.slice(0, 300);
}
