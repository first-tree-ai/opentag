import { type ErrorCategory, GITHUB_CONNECTION_ERROR_CODES, type GitHubConnectionErrorCode } from "@opentag/shared";
import { DomainServiceError } from "../domain-service-error.js";

/*
 * The controlled GitHub failure vocabulary lives in @opentag/shared so the Account HTTP error
 * envelope accepts exactly the codes the MCP-backed Context Tree integration reports.
 */
export { GITHUB_CONNECTION_ERROR_CODES, type GitHubConnectionErrorCode };

/**
 * A controlled failure of the GitHub MCP-backed Context Tree integration. Messages never carry secret
 * material — no ciphertext, OAuth state, session values, or token payloads.
 */
export class GitHubConnectionServiceError extends DomainServiceError<GitHubConnectionErrorCode, ErrorCategory, number> {
  constructor(
    code: GitHubConnectionErrorCode,
    statusCode: number,
    message: string,
    category: ErrorCategory = "deterministic",
    options?: ErrorOptions,
  ) {
    super({ code, category, message, statusCode, cause: options?.cause });
    this.name = "GitHubConnectionServiceError";
  }
}
