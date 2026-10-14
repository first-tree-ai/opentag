import { Kind, parse } from "graphql";
import type { GitHubGraphqlRequest } from "./graphql-policy.js";

/**
 * Older native gh recognizes missing read:project but not GitHub App's FORBIDDEN wording.
 * Keep an explicit denial for this optional metadata preread, in the stable scope-error
 * vocabulary gh understands. Never mint Projects permission, invent empty data, or hide a
 * mixed/repository/credential error. The normal execution fence still runs before return.
 */
export function normalizeNativeProjectRead(request: GitHubGraphqlRequest, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.errors) || row.errors.length === 0 || !row.errors.every(projectAccessDenied)) return value;
  const document = parse(request.query, { maxTokens: 10000 });
  const operation = document.definitions.find(
    (item) =>
      item.kind === Kind.OPERATION_DEFINITION &&
      item.name?.value === (request.operationName ?? "PullRequestProjectItems"),
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION || operation.name?.value !== "PullRequestProjectItems")
    return value;
  return {
    ...row,
    errors: row.errors.map((error) => ({
      ...error,
      message: "The projectItems field requires one of the following scopes: ['read:project']",
    })),
  };
}
function projectAccessDenied(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return (
    ["FORBIDDEN", "INSUFFICIENT_SCOPES"].includes(String(error.type)) &&
    Array.isArray(error.path) &&
    error.path.at(-1) === "projectItems"
  );
}
