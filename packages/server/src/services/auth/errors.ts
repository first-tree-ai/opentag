import type { ErrorCategory, ErrorCode } from "@opentag/shared";
import { DomainServiceError } from "../domain-service-error.js";

export class AuthServiceError extends DomainServiceError<ErrorCode, ErrorCategory, number> {
  constructor(code: ErrorCode, category: ErrorCategory, message: string, statusCode: number) {
    super({ code, category, message, statusCode });
    this.name = "AuthServiceError";
  }
}

export function invalidCredential(code: ErrorCode, message: string): AuthServiceError {
  return new AuthServiceError(code, "credential", message, 401);
}
