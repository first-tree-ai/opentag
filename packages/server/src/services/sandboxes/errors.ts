import type { ErrorCategory, ErrorCode } from "@opentag/shared";

export class SandboxServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "SandboxServiceError";
  }
}

export function sandboxNotFound(): SandboxServiceError {
  return new SandboxServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}

export function sandboxScopeInvalid(): SandboxServiceError {
  return new SandboxServiceError("VALIDATION_ERROR", "validation", "The request payload is invalid", 400);
}

/** Which admission ceiling rejected a new physical reservation. */
export type CloudCapacityScope = "account" | "platform";

/**
 * Stable capacity signal (429, transient): the Account or platform environment ceiling is full.
 * The typed scope is internal diagnostics only; no resource names, UIDs, or provider detail.
 */
export class CloudCapacityExceededError extends SandboxServiceError {
  readonly scope: CloudCapacityScope;

  constructor(scope: CloudCapacityScope) {
    super(
      "CLOUD_CAPACITY_EXCEEDED",
      "transient",
      scope === "account"
        ? "This Account already occupies its Cloud environment capacity; retry after an environment is released"
        : "The Cloud platform is at its environment capacity; retry shortly",
      429,
    );
    this.name = "CloudCapacityExceededError";
    this.scope = scope;
  }
}

/** The current environment could not prove a final workspace save; retain its allocation. */
export class WorkspaceSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSaveError";
  }
}

export class WorkspaceRestoreRequiredError extends SandboxServiceError {
  constructor() {
    super(
      "SANDBOX_RUNNER_CONFLICT",
      "deterministic",
      "The saved workspace is missing; restore it before allocating an environment",
      409,
    );
    this.name = "WorkspaceRestoreRequiredError";
  }
}
