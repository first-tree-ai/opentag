/**
 * Explicit metadata windows for actor/user/owner/reviewer references, cross-repository references,
 * and the native gh repository `parent` preread. Content fields (pullRequests, repositories,
 * issues, refs, commits, …) are deliberately absent: a User's user-wide connections would escape
 * the single authorized repository, so only identity/display/email metadata and connection
 * pagination are reachable here.
 */

export const ParentRepositoryMetadata = new Set([
  "id",
  "databaseId",
  "__typename",
  "name",
  "hasIssuesEnabled",
  "description",
  "hasWikiEnabled",
  "viewerPermission",
  "owner",
  "defaultBranchRef",
]);
export const ParentOwnerMetadata = new Set(["login", "__typename"]);
export const ParentDefaultBranchRefMetadata = new Set(["name", "__typename"]);
export const CrossRepositoryMetadata = new Set([
  "id",
  "databaseId",
  "name",
  "nameWithOwner",
  "owner",
  "login",
  "url",
  "__typename",
  "isFork",
  "isPrivate",
]);
/**
 * Identity/display/email metadata shared by User, Organization, and actor selections. These
 * subtrees are deliberately closed: a User's `pullRequests`/`repositories`/`issues`/`gists` are
 * user-wide and would escape the authorized repository, so only handle/display fields are listed.
 */
export const ActorIdentityMetadata = new Set([
  "id",
  "databaseId",
  "__typename",
  "login",
  "name",
  "email",
  "avatarUrl",
  "url",
  "resourcePath",
]);
/** GitActor (commit author) adds commit-author fields and the `user` identity reference. */
export const ActorMetadata = new Set([...ActorIdentityMetadata, "date", "user"]);
/** Team handles may appear as requested reviewers; content connections (members/repositories) are not listed. */
export const RequestedReviewerMetadata = new Set([...ActorIdentityMetadata, "slug"]);
/** ReviewRequest nodes only reference the requested reviewer; they expose no repository content. */
export const ReviewRequestMetadata = new Set(["__typename", "requestedReviewer"]);
export const ConnectionFields = new Set(["__typename", "totalCount", "nodes", "edges", "pageInfo"]);
export const EdgeFields = new Set(["__typename", "cursor", "node"]);
export const PageInfoFields = new Set(["__typename", "hasNextPage", "hasPreviousPage", "startCursor", "endCursor"]);
/** Connections whose node type is an actor/user/reviewer; their nodes never inherit ReadFields. */
export const MetadataConnectionNodes: Readonly<Record<string, ReadonlySet<string>>> = {
  assignees: ActorIdentityMetadata,
  participants: ActorIdentityMetadata,
  users: ActorIdentityMetadata,
  authors: ActorMetadata,
  reviewRequests: ReviewRequestMetadata,
};
// NOTE: keys above are exact field names; the lookup uses Object.hasOwn, never prototype access.

/** Cross-repository/actor subtrees that must never inherit the parent content allowlist. */
export function metadataChildSet(name: string): ReadonlySet<string> | undefined {
  switch (name) {
    case "owner":
    case "headRepositoryOwner":
      return ActorIdentityMetadata;
    case "author":
      return ActorMetadata;
    case "user":
      return ActorIdentityMetadata;
    case "requestedReviewer":
      return RequestedReviewerMetadata;
    case "headRepository":
    case "subject":
    case "project":
      return CrossRepositoryMetadata;
    default:
      return undefined;
  }
}
