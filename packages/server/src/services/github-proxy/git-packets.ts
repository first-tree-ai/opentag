export class GitPublicationError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "scope_denied"
      | "resource_limit"
      | "invalid_objects"
      | "remote_conflict"
      | "tree_invalid"
      | "unavailable",
  ) {
    super(`Git publication failed: ${code}`);
    this.name = "GitPublicationError";
  }
}
export interface GitRefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}
