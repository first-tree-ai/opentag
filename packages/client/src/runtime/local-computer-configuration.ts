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
  enrollments: {
    status: LocalConfigurationStatus;
    value?: StoredMachineCredentials;
    detail?: string;
  };
  binding: {
    status: LocalConfigurationStatus;
    enrollmentCount: number;
    serverUrl?: string;
    detail?: string;
  };
}

/** Strict, read-only inspection of the Computer identity and every stored enrollment. */
export async function inspectLocalComputerConfiguration(home: string): Promise<LocalComputerConfigurationInspection> {
  const [identityResult, credentialsResult] = await Promise.allSettled([
    readComputerIdentity(home),
    readMachineCredentialsStrict(home),
  ]);

  const identity = inspectIdentity(identityResult);
  const enrollments = inspectEnrollments(credentialsResult);
  if (identity.status !== "valid" || enrollments.status !== "valid") {
    return {
      identity,
      enrollments,
      binding: {
        status: "invalid",
        enrollmentCount: enrollments.value?.enrollments.length ?? 0,
        detail: "A valid identity and enrollment set are required before their binding can be verified",
      },
    };
  }

  const identityValue = identity.value;
  const credentialsValue = enrollments.value;
  if (!identityValue || !credentialsValue) {
    return {
      identity,
      enrollments,
      binding: { status: "invalid", enrollmentCount: 0, detail: "Validated local configuration is incomplete" },
    };
  }

  const stored = credentialsValue.enrollments;
  const servers = new Set(stored.map((entry) => entry.serverUrl));
  const computers = new Set(stored.map((entry) => entry.computerId));
  if (servers.size !== 1) {
    return {
      identity,
      enrollments,
      binding: {
        status: "invalid",
        enrollmentCount: stored.length,
        detail: "Stored enrollments refer to more than one Server origin",
      },
    };
  }
  if (computers.size !== 1 || !computers.has(identityValue.computerId)) {
    return {
      identity,
      enrollments,
      binding: {
        status: "invalid",
        enrollmentCount: stored.length,
        detail: "Stored enrollments do not belong to the local Computer identity",
      },
    };
  }
  const [serverUrl] = servers;
  if (!serverUrl || identityValue.serverUrl !== serverUrl) {
    return {
      identity,
      enrollments,
      binding: {
        status: "invalid",
        enrollmentCount: stored.length,
        detail: "The Computer identity and stored enrollments refer to different Server origins",
      },
    };
  }

  return {
    identity,
    enrollments,
    binding: { status: "valid", enrollmentCount: stored.length, serverUrl },
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

function inspectEnrollments(
  result: PromiseSettledResult<StoredMachineCredentials | undefined>,
): LocalComputerConfigurationInspection["enrollments"] {
  if (result.status === "rejected") {
    return { status: "invalid", detail: safeErrorDetail(result.reason, "Computer enrollments could not be read") };
  }
  if (!result.value || result.value.enrollments.length === 0) {
    return { status: "missing", detail: "No Computer enrollments are configured" };
  }
  for (const entry of result.value.enrollments) {
    try {
      if (normalizeServerUrl(entry.serverUrl) !== entry.serverUrl) {
        return { status: "invalid", detail: "A stored enrollment contains a non-canonical Server origin" };
      }
    } catch {
      return { status: "invalid", detail: "A stored enrollment contains an invalid Server origin" };
    }
  }
  return { status: "valid", value: result.value };
}

function safeErrorDetail(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return error.message.slice(0, 300);
}
