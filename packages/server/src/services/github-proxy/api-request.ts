import type { ProviderProxyRequest } from "../../runtime-credentials/provider-proxy-adapter.js";
import { readBoundedBody } from "./api-transport.js";
import type { GitHubExecutionRepository } from "./execution-policy.js";
import { GitPublicationError } from "./git-packets.js";

export function safeRequestUrl(path: string): URL {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\s#]/.test(path) ||
    /%2e|%2f|%5c/i.test(path) ||
    path.includes("..")
  )
    throw new GitPublicationError("invalid_request");
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com" || url.pathname + url.search !== path)
    throw new GitPublicationError("invalid_request");
  return url;
}
export function findRepository(repositories: GitHubExecutionRepository[], fullName: string): GitHubExecutionRepository {
  const repository = repositories.find((item) => item.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repository) throw new GitPublicationError("scope_denied");
  return repository;
}
export async function parseBody(request: ProviderProxyRequest): Promise<unknown> {
  try {
    return JSON.parse((await readBoundedBody(request.body, 262144, request.signal)).toString("utf8"));
  } catch {
    throw new GitPublicationError("invalid_request");
  }
}
