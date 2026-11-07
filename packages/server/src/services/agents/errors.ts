import type { ErrorCategory, ErrorCode } from "@opentag/shared";
import { DomainServiceError } from "../domain-service-error.js";

export class AgentServiceError extends DomainServiceError<ErrorCode, ErrorCategory, number> {
  constructor(code: ErrorCode, category: ErrorCategory, message: string, statusCode: number) {
    super({ code, category, message, statusCode });
    this.name = "AgentServiceError";
  }
}

export function resourceNotFound(): AgentServiceError {
  return new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
