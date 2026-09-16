import { GitBranchRefSchema, type GitHubAgentScope } from "@opentag/shared";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import { GitPublicationError } from "./git-packets.js";
import type { GitPublicationScope } from "./git-publication.js";

export interface GitHubExecutionRepository {
  installationId: string;
  repositoryId: string;
  fullName: string;
  scopes: GitHubAgentScope[];
  /** Includes every configured Tree ref, including other Agents' Tree grants. */
  protectedTreeRefs: string[];
}
export interface GitHubExecutionPolicy {
  resolve(authorization: RuntimeProxyAuthorization, signal: AbortSignal): Promise<GitHubExecutionRepository[]>;
}

export function taskBranchPrefix(sessionId: string, role: "code" | "context_tree"): string {
  return `refs/heads/opentag/${sessionId}/${role}/`;
}

export function publicationScopes(repository: GitHubExecutionRepository, sessionId: string): GitPublicationScope[] {
  return repository.scopes
    .filter((scope) => scope.access === "write")
    .map((scope) =>
      scope.role === "context_tree" && scope.publish === "direct"
        ? { role: scope.role, exactRef: scope.branch }
        : { role: scope.role, refPrefix: taskBranchPrefix(sessionId, scope.role) },
    );
}

export function treeReadRefs(repository: GitHubExecutionRepository, sessionId: string): string[] | undefined {
  if (repository.scopes.some((scope) => scope.role === "code")) return undefined;
  return repository.scopes.flatMap((scope) => [
    ...(scope.branch ? [scope.branch] : []),
    ...(scope.access === "write" && scope.publish === "pull_request"
      ? [`${taskBranchPrefix(sessionId, "context_tree")}*`]
      : []),
  ]);
}

/** PR writes can only publish a task branch belonging to this Session and its configured purpose. */
export function assertPullRequestRefs(input: {
  repository: GitHubExecutionRepository;
  sessionId: string;
  head: string;
  base: string;
  defaultBranch: string;
}): void {
  if (
    !GitBranchRefSchema.safeParse(`refs/heads/${input.head}`).success ||
    !GitBranchRefSchema.safeParse(`refs/heads/${input.base}`).success
  )
    throw new GitPublicationError("scope_denied");
  const allowed = input.repository.scopes.some((scope) => {
    if (scope.access !== "write" || scope.publish !== "pull_request") return false;
    const head = `refs/heads/${input.head}`;
    const base = `refs/heads/${input.base}`;
    if (!head.startsWith(taskBranchPrefix(input.sessionId, scope.role))) return false;
    return scope.role === "context_tree"
      ? base === scope.branch
      : input.base === input.defaultBranch && !input.repository.protectedTreeRefs.includes(base);
  });
  if (!allowed) throw new GitPublicationError("scope_denied");
}
