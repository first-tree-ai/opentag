export type EffectiveRuntimeSnapshotAssemblerErrorCode =
  | "SESSION_NOT_FOUND"
  | "AUTHORITY_INACTIVE"
  | "RUNTIME_CONFIG_MISSING"
  | "UNSUPPORTED_PROVIDER"
  | "INVALID_STORED_CONFIG"
  | "DATABASE_FAILURE"
  | "SNAPSHOT_INVALID";

const messages: Record<EffectiveRuntimeSnapshotAssemblerErrorCode, string> = {
  SESSION_NOT_FOUND: "The Session runtime authority does not exist",
  AUTHORITY_INACTIVE: "The Session runtime authority is inactive",
  RUNTIME_CONFIG_MISSING: "The Agent runtime configuration is missing",
  UNSUPPORTED_PROVIDER: "The Agent runtime provider is unsupported",
  INVALID_STORED_CONFIG: "The stored Agent runtime configuration is invalid",
  DATABASE_FAILURE: "The Session runtime authority could not be read",
  SNAPSHOT_INVALID: "The effective runtime snapshot is invalid",
};

export class EffectiveRuntimeSnapshotAssemblerError extends Error {
  readonly code: EffectiveRuntimeSnapshotAssemblerErrorCode;

  constructor(code: EffectiveRuntimeSnapshotAssemblerErrorCode, options: { cause?: unknown } = {}) {
    super(messages[code], options);
    this.name = "EffectiveRuntimeSnapshotAssemblerError";
    this.code = code;
  }
}
