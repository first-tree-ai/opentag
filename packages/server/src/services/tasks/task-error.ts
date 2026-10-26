/**
 * A Task read rejected the request itself — a malformed cursor or an option outside the contract.
 * It is a caller error, not a server fault, so the route answers 400 with the same code.
 */
export class TaskQueryError extends Error {
  readonly code: string;
  readonly category = "validation" as const;

  constructor(
    code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "TaskQueryError";
    this.code = code;
  }
}
