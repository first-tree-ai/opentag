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
