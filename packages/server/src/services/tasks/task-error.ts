import { DomainServiceError } from "../domain-service-error.js";

/**
 * A Task read rejected the request itself — a malformed cursor or an option outside the contract.
 * It is a caller error, not a server fault, so the route answers 400 with the same code.
 */
export class TaskQueryError extends DomainServiceError<string, "validation", number> {
  constructor(code: string, message: string, statusCode: number) {
    super({ code, category: "validation", message, statusCode });
    this.name = "TaskQueryError";
  }
}
