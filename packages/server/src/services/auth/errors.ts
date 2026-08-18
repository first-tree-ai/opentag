import type { ErrorCategory, ErrorCode } from "@opentag/shared";

export class AuthServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export function invalidCredential(code: ErrorCode, message: string): AuthServiceError {
  return new AuthServiceError(code, "credential", message, 401);
}
