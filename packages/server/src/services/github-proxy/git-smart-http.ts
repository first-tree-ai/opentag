import { randomUUID } from "node:crypto";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type { ProviderProxyRequest, ProviderProxyResponse } from "../../runtime-credentials/provider-proxy-adapter.js";
import { type GitHubExecutionRepository, publicationScopes, treeReadRefs } from "./execution-policy.js";
import { GitPublicationError } from "./git-packets.js";
import { GitHubPublicationRemote } from "./git-remote.js";
import type { GitHubProviderAdapterOptions } from "./github-provider-adapter.js";

export async function handleGitSmartHttp(
  options: Pick<GitHubProviderAdapterOptions, "leases" | "reads" | "publication"> & {
    metadata(
      repository: GitHubExecutionRepository,
      token: string,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>;
  },
  request: ProviderProxyRequest,
  authorization: RuntimeProxyAuthorization,
  url: URL,
  repositories: GitHubExecutionRepository[],
): Promise<ProviderProxyResponse> {
  const { repository, advertise, service } = parseGitRequest(request, url, repositories);
  const scopes = publicationScopes(repository, authorization.sessionId);
  if (service === "git-receive-pack" && !scopes.length) throw new GitPublicationError("scope_denied");
  const lease = await options.leases.acquire(request.executionId, {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    permissions: { contents: service === "git-receive-pack" && !advertise ? "write" : "read" },
    signal: request.signal,
  });
  const recheck = () => authorization.recheck(request.signal);
  try {
    await recheck();
    const metadata = await options.metadata(repository, lease.token, request.signal);
    const remote = new GitHubPublicationRemote({ fullName: repository.fullName, token: lease.token });
    if (service === "git-receive-pack" && !advertise) {
      const result = await options.publication.receive({
        sessionId: authorization.sessionId,
        executionId: request.executionId,
        operationId: randomUUID(),
        repositoryId: repository.repositoryId,
        policyRevision: authorization.scopeHash,
        scopes,
        protectedTreeRefs: repository.protectedTreeRefs,
        body: request.body,
        signal: request.signal,
        remote,
        revalidate: recheck,
      });
      await lease.release();
      return {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" },
        body: bytesBody(result),
      };
    }
    const response = await options.reads.handle({
      sessionId: authorization.sessionId,
      repositoryId: repository.repositoryId,
      policyRevision: authorization.scopeHash,
      service,
      advertise,
      protocol: request.headers["git-protocol"],
      defaultRef: repository.scopes.some((scope) => scope.role === "code")
        ? `refs/heads/${metadata.default_branch}`
        : (repository.scopes[0]?.branch ?? "refs/heads/master"),
      allowedRefs: treeReadRefs(repository, authorization.sessionId),
      body: request.body,
      remote,
      signal: request.signal,
      revalidate: recheck,
    });
    return { ...response, body: releaseBody(response.body, lease.release, request.signal) };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

async function* bytesBody(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
async function* releaseBody(
  body: AsyncIterable<Uint8Array>,
  release: () => Promise<void>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const onAbort = () => {
    void release();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    yield* body;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await release();
  }
}

function parseGitRequest(request: ProviderProxyRequest, url: URL, repositories: GitHubExecutionRepository[]) {
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname,
  );
  if (!match) throw new GitPublicationError("invalid_request");
  const repository = repositories.find(
    (entry) => entry.fullName.toLowerCase() === `${match[1]}/${match[2]}`.toLowerCase(),
  );
  if (!repository) throw new GitPublicationError("scope_denied");
  const advertise = match[3] === "info/refs";
  const service = advertise ? url.searchParams.get("service") : match[3];
  if (
    (service !== "git-upload-pack" && service !== "git-receive-pack") ||
    (advertise
      ? request.method !== "GET" || url.search !== `?service=${service}`
      : request.method !== "POST" || !!url.search)
  )
    throw new GitPublicationError("invalid_request");
  return { repository, advertise, service: service as "git-upload-pack" | "git-receive-pack" };
}
