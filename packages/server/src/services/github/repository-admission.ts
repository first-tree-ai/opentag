/*
 * Authoritative GitHub user-admission verification and repository discovery.
 *
 * Every answer here comes from the live GitHub API through the connected user's UAT: which
 * installations of the configured App the user can reach, what permission set each installation
 * grants, and whether the user personally can read or push each exact repository ID. Nothing is
 * trusted from a query parameter, a stored display name, or a caller-supplied proof — the only
 * output of a successful verification is the typed `GitHubRepositoryAdmissionProof` the bindings
 * write path requires, minted here and bound to the exact requested bindings.
 */

import {
  GITHUB_REPOSITORY_DISCOVERY_MAX_INSTALLATIONS,
  type GitHubDiscoveredInstallation,
  type GitHubDiscoveredRepository,
  type GitHubRepositoryBinding,
  type GitHubRepositoryDiscoveryPage,
} from "@opentag/shared";
import { createGitHubRepositoryAdmissionProof, type GitHubRepositoryAdmissionProof } from "./bindings-proof.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import {
  GITHUB_INSTALLATION_REPOSITORIES_PER_PAGE,
  type GitHubApiClient,
  type GitHubUserInstallation,
} from "./github-api-client.js";

/** Discovery returns at most five upstream installation pages (500 installations) per call. */
const MAX_INSTALLATION_PAGES = Math.ceil(GITHUB_REPOSITORY_DISCOVERY_MAX_INSTALLATIONS / 100);
/** One installation's repositories are searched at most ten pages deep (1000 repositories). */
const MAX_REPOSITORY_PAGES_PER_INSTALLATION = 10;
/**
 * A full verification never walks more than this many repository pages in total. The budget is
 * hard: a configuration that cannot be verified inside it is rejected with a controlled error —
 * never silently half-verified, and never granted an unbounded upstream walk.
 */
const MAX_TOTAL_REPOSITORY_PAGES_PER_VERIFICATION = 64;

const PERMISSION_LEVELS: Readonly<Record<string, number>> = { read: 1, write: 2 };

interface DiscoveryCursor {
  v: 1;
  /** Ordinal of the current installation in the ascending-ID installation list. */
  i: number;
  /** Next repository page within that installation. */
  p: number;
}

/** The live admission requirement of one binding, derived from its Agent scopes. */
export interface GitHubBindingRequirement {
  contents: "read" | "write";
  pullRequestsWrite: boolean;
  userAccess: "read" | "write";
}

/**
 * Maps one binding's Agent scopes to the exact rights GitHub must attest: contents read or write,
 * pull-request write when any write scope publishes via PR, and the connected user's own read or
 * write access to the repository.
 */
export function requiredBindingAdmission(binding: GitHubRepositoryBinding): GitHubBindingRequirement {
  let write = false;
  let pullRequestsWrite = false;
  for (const scope of binding.agentScopes) {
    if (scope.access === "write") {
      write = true;
      if (scope.publish === "pull_request") pullRequestsWrite = true;
    }
  }
  return { contents: write ? "write" : "read", pullRequestsWrite, userAccess: write ? "write" : "read" };
}

function encodeCursor(cursor: DiscoveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): DiscoveryCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new GitHubConnectionServiceError(GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID, 400, "The cursor is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as DiscoveryCursor).v !== 1 ||
    !Number.isSafeInteger((value as DiscoveryCursor).i) ||
    (value as DiscoveryCursor).i < 0 ||
    (value as DiscoveryCursor).i > GITHUB_REPOSITORY_DISCOVERY_MAX_INSTALLATIONS ||
    !Number.isSafeInteger((value as DiscoveryCursor).p) ||
    (value as DiscoveryCursor).p < 1 ||
    (value as DiscoveryCursor).p > MAX_REPOSITORY_PAGES_PER_INSTALLATION
  ) {
    throw new GitHubConnectionServiceError(GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID, 400, "The cursor is invalid");
  }
  return value as DiscoveryCursor;
}

function toDiscoveredInstallation(installation: GitHubUserInstallation): GitHubDiscoveredInstallation {
  return {
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    suspended: installation.suspended,
  };
}

/**
 * Verifies GitHub App identity, installation permission sets, and per-user repository admission for
 * the configured deployment App, and produces the paginated discovery stream the UI consumes.
 */
export class GitHubRepositoryAdmissionService {
  readonly #api: GitHubApiClient;
  readonly #appId: string;
  readonly #now: () => Date;

  constructor(options: { api: GitHubApiClient; appId: string; now?: () => Date }) {
    this.#api = options.api;
    this.#appId = options.appId;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * One page of the repository discovery stream. Each call re-reads the bounded installation list
   * (so install state is always current) and one repository page; the opaque cursor continues.
   * One installation is walked at most ten pages deep; when it holds more repositories than the
   * bound can list, the stream moves on to the next installation and names the truncation in
   * `truncatedInstallations` — discovery never silently claims an exhaustive listing.
   */
  async discoverRepositories(input: {
    accessToken: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GitHubRepositoryDiscoveryPage> {
    const installations = await this.#listVerifiedInstallations(input.accessToken, input.signal);
    const cursor = input.cursor === undefined ? { v: 1 as const, i: 0, p: 1 } : decodeCursor(input.cursor);
    const summaries = installations.map(toDiscoveredInstallation);
    if (installations.length === 0 || cursor.i >= installations.length) {
      return { installations: summaries, repositories: [], nextCursor: null, truncatedInstallations: [] };
    }
    const installation = installations[cursor.i] as GitHubUserInstallation;
    const page = await this.#api.listInstallationRepositories({
      accessToken: input.accessToken,
      installationId: installation.installationId,
      page: cursor.p,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const repositories: GitHubDiscoveredRepository[] = page.repositories.map((repository) => ({
      installationId: installation.installationId,
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      private: repository.private,
      defaultBranch: repository.defaultBranch,
      permissions: {
        pull: repository.permissions.pull || repository.permissions.push || repository.permissions.admin,
        push: repository.permissions.push || repository.permissions.admin,
      },
    }));
    const unlistedBeyondBound = cursor.p * GITHUB_INSTALLATION_REPOSITORIES_PER_PAGE < page.totalCount;
    const canAdvanceWithinBound = cursor.p < MAX_REPOSITORY_PAGES_PER_INSTALLATION;
    const truncated = unlistedBeyondBound && !canAdvanceWithinBound;
    const hasMoreInstallations = cursor.i + 1 < installations.length;
    const nextCursor =
      unlistedBeyondBound && canAdvanceWithinBound
        ? encodeCursor({ v: 1, i: cursor.i, p: cursor.p + 1 })
        : hasMoreInstallations
          ? encodeCursor({ v: 1, i: cursor.i + 1, p: 1 })
          : null;
    return {
      installations: summaries,
      repositories,
      nextCursor,
      truncatedInstallations: truncated ? [installation.installationId] : [],
    };
  }

  /**
   * Authoritative admission for a bindings write: every requested binding is verified against live
   * GitHub state — configured App identity, installation presence/permission set, suspension, exact
   * repository ID reachability, and the connected user's own read/write rights. The returned proof
   * is the only object the bindings CAS accepts, and it is bound to the exact requested bindings.
   */
  async verifyAdmission(input: {
    accessToken: string;
    connectionId: string;
    authorizationVersion: bigint;
    githubUserId: string;
    bindings: GitHubRepositoryBinding[];
    signal?: AbortSignal;
  }): Promise<GitHubRepositoryAdmissionProof> {
    const installations = await this.#listVerifiedInstallations(input.accessToken, input.signal);
    const byInstallationId = new Map(installations.map((installation) => [installation.installationId, installation]));
    let repositoryPagesRead = 0;
    const repositoriesByInstallation = new Map<
      string,
      Map<string, Awaited<ReturnType<GitHubApiClient["listInstallationRepositories"]>>["repositories"][number]>
    >();
    for (const binding of input.bindings) {
      const installation = byInstallationId.get(binding.installationId);
      if (!installation) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.ADMISSION_INSTALLATION_MISSING,
          409,
          "A requested installation is not accessible to the connected GitHub user",
        );
      }
      const requirement = requiredBindingAdmission(binding);
      this.#assertInstallationPermissions(installation, requirement);
      let repositories = repositoriesByInstallation.get(binding.installationId);
      if (!repositories) {
        const remainingBudget = MAX_TOTAL_REPOSITORY_PAGES_PER_VERIFICATION - repositoryPagesRead;
        if (remainingBudget < 1) {
          throw new GitHubConnectionServiceError(
            GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
            400,
            "The requested bindings span more GitHub repository pages than one admission verification can cover",
          );
        }
        const listed = await this.#listReachableRepositories(
          input.accessToken,
          installation.installationId,
          Math.min(MAX_REPOSITORY_PAGES_PER_INSTALLATION, remainingBudget),
          input.signal,
        );
        repositoryPagesRead += listed.pagesRead;
        repositories = listed.repositories;
        repositoriesByInstallation.set(binding.installationId, repositories);
      }
      const repository = repositories.get(binding.repositoryId);
      if (!repository) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING,
          409,
          "A requested repository is not accessible to the connected GitHub user through its installation",
        );
      }
      this.#assertUserRepositoryPermission(repository.permissions, requirement.userAccess);
    }
    return createGitHubRepositoryAdmissionProof({
      connectionId: input.connectionId,
      authorizationVersion: input.authorizationVersion,
      githubUserId: input.githubUserId,
      bindings: input.bindings,
      verifiedAt: this.#now(),
    });
  }

  /**
   * Re-verifies one exact repository admission right now, for the Server-side runtime broker: the
   * installation must belong to the configured App, grant the permission set the role needs, and
   * the connected user must personally hold the requested access. Throws on failure; never logs
   * the token it verifies with.
   */
  async verifyCurrentRepositoryAdmission(input: {
    accessToken: string;
    installationId: string;
    repositoryId: string;
    access: "read" | "write";
    publish?: "direct" | "pull_request";
    signal?: AbortSignal;
  }): Promise<void> {
    const installations = await this.#listVerifiedInstallations(input.accessToken, input.signal);
    const installation = installations.find((entry) => entry.installationId === input.installationId);
    if (!installation) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_INSTALLATION_MISSING,
        409,
        "The installation is not accessible to the connected GitHub user",
      );
    }
    this.#assertInstallationPermissions(installation, {
      contents: input.access,
      pullRequestsWrite: input.access === "write" && input.publish === "pull_request",
      userAccess: input.access,
    });
    const { repositories } = await this.#listReachableRepositories(
      input.accessToken,
      installation.installationId,
      MAX_REPOSITORY_PAGES_PER_INSTALLATION,
      input.signal,
    );
    const repository = repositories.get(input.repositoryId);
    if (!repository) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING,
        409,
        "The repository is not accessible to the connected GitHub user through its installation",
      );
    }
    this.#assertUserRepositoryPermission(repository.permissions, input.access);
  }

  /**
   * Every installation page, verified: each entry must belong to the configured App — a mismatch is
   * upstream integrity failure, never a silently skipped row. Bounded at five pages.
   */
  async #listVerifiedInstallations(accessToken: string, signal?: AbortSignal): Promise<GitHubUserInstallation[]> {
    const installations: GitHubUserInstallation[] = [];
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const result = await this.#api.listUserInstallations({
        accessToken,
        page,
        ...(signal ? { signal } : {}),
      });
      for (const installation of result.installations) {
        if (installation.appId !== this.#appId) {
          throw new GitHubConnectionServiceError(
            GITHUB_CONNECTION_ERROR_CODES.APP_IDENTITY_MISMATCH,
            502,
            "GitHub returned an installation of a different App than the configured one",
            "transient",
          );
        }
        installations.push(installation);
      }
      if (installations.length >= result.totalCount || result.installations.length === 0) break;
    }
    installations.sort((left, right) => {
      const delta = BigInt(left.installationId) - BigInt(right.installationId);
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
    return installations;
  }

  /** Lists up to `maxPages` of one installation's reachable repositories, reporting the actual walk depth. */
  async #listReachableRepositories(
    accessToken: string,
    installationId: string,
    maxPages: number,
    signal?: AbortSignal,
  ): Promise<{
    repositories: Map<
      string,
      Awaited<ReturnType<GitHubApiClient["listInstallationRepositories"]>>["repositories"][number]
    >;
    pagesRead: number;
  }> {
    const repositories = new Map<
      string,
      Awaited<ReturnType<GitHubApiClient["listInstallationRepositories"]>>["repositories"][number]
    >();
    let pagesRead = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.#api.listInstallationRepositories({
        accessToken,
        installationId,
        page,
        ...(signal ? { signal } : {}),
      });
      pagesRead += 1;
      for (const repository of result.repositories) {
        repositories.set(repository.repositoryId, repository);
      }
      if (repositories.size >= result.totalCount || result.repositories.length === 0) break;
    }
    return { repositories, pagesRead };
  }

  #assertInstallationPermissions(installation: GitHubUserInstallation, requirement: GitHubBindingRequirement): void {
    if (installation.suspended) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_INSTALLATION_MISSING,
        409,
        "A requested installation is suspended on GitHub",
      );
    }
    const contentsLevel = PERMISSION_LEVELS[installation.permissions.contents ?? ""] ?? 0;
    if (contentsLevel < (PERMISSION_LEVELS[requirement.contents] ?? 0)) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
        403,
        "The GitHub App installation does not grant the repository contents access a binding requires",
      );
    }
    if (requirement.pullRequestsWrite) {
      const pullRequestsLevel = PERMISSION_LEVELS[installation.permissions.pull_requests ?? ""] ?? 0;
      if (pullRequestsLevel < (PERMISSION_LEVELS.write ?? 0)) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
          403,
          "The GitHub App installation does not grant the pull request write access a binding requires",
        );
      }
    }
  }

  #assertUserRepositoryPermission(
    permissions: { admin: boolean; pull: boolean; push: boolean },
    access: "read" | "write",
  ): void {
    const canRead = permissions.pull || permissions.push || permissions.admin;
    const canWrite = permissions.push || permissions.admin;
    if ((access === "read" && !canRead) || (access === "write" && !canWrite)) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
        403,
        "The connected GitHub user does not personally hold the repository access a binding requires",
      );
    }
  }
}
