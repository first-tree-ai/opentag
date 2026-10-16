import { RUNTIME_PROVIDER_ORIGIN_HEADER } from "@opentag/shared";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type {
  ProviderProxyAdapter,
  ProviderProxyRequest,
  ProviderProxyResponse,
} from "../../runtime-credentials/provider-proxy-adapter.js";
import type { GitHubManagementService } from "../github/github-management-service.js";
import { GitPublicationError } from "./git-packets.js";
import { githubRequestTarget } from "./http-target.js";
import { GitHubHttpTransport, GitHubProxyError } from "./http-transport.js";

/** GitHub owns API semantics; OpenTag owns the current execution and connected-user credential. */
export class GitHubProviderAdapter implements ProviderProxyAdapter {
  readonly #transport: Pick<GitHubHttpTransport, "request">;
  constructor(
    readonly options: {
      management: Pick<GitHubManagementService, "getExecutionUserCredential">;
      transport?: Pick<GitHubHttpTransport, "request">;
    },
  ) {
    this.#transport = options.transport ?? new GitHubHttpTransport();
  }

  async handle(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    if (
      request.provider !== "github" ||
      authorization.provider !== "github" ||
      authorization.purpose !== "execution" ||
      request.executionId !== authorization.executionId ||
      request.sessionId !== authorization.sessionId ||
      request.bindingId !== authorization.bindingId
    )
      throw new GitPublicationError("scope_denied");
    const url = githubRequestTarget(request.headers[RUNTIME_PROVIDER_ORIGIN_HEADER], request.path, request.method);
    const credential = await this.options.management
      .getExecutionUserCredential({
        accountId: authorization.accountId,
        connectionId: authorization.bindingId,
        authorizationRevision: authorization.authorizationRevision,
      })
      .catch(() => {
        throw new GitHubProxyError("github_credential_failed");
      });
    await authorization.recheck(request.signal);
    request.signal.throwIfAborted();
    if (!credential) throw new GitHubProxyError("github_credential_unavailable");
    return this.#transport.request({ ...request, url, token: credential.accessToken });
  }
}
