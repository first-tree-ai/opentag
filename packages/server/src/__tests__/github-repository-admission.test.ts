import { describe, expect, it, vi } from "vitest";
import type {
  GitHubApiClient,
  GitHubInstallationRepository,
  GitHubUserInstallation,
} from "../services/github/github-api-client.js";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import {
  GITHUB_TEST_APP_ID,
  installation,
  installationsPage,
  repositoriesPage,
  repository,
  stubGitHubApi,
} from "./support/github-fixtures.js";

function fixture() {
  const repository: GitHubInstallationRepository = {
    repositoryId: "100001",
    fullName: "acme/requested",
    private: true,
    defaultBranch: "main",
    permissions: { pull: true, push: true, admin: false },
  };
  const installation: GitHubUserInstallation = {
    installationId: "77",
    appId: "88",
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "selected",
    suspended: false,
    permissions: { contents: "write", pull_requests: "write" },
  };
  const getRepository = vi.fn(async () => repository);
  const repositoryInstallation = vi.fn(async () => installation);
  const listInstallationRepositories = vi.fn();
  const assertUserInstallationAccess = vi.fn(async () => undefined);
  const service = new GitHubRepositoryAdmissionService({
    appId: "88",
    api: { getRepository, listInstallationRepositories, assertUserInstallationAccess } as unknown as GitHubApiClient,
    installations: { repositoryInstallation },
  });
  return {
    service,
    repository,
    installation,
    getRepository,
    repositoryInstallation,
    listInstallationRepositories,
    assertUserInstallationAccess,
  };
}
const request = { accessToken: "user-secret", fullName: "acme/requested", access: "read" as const };
describe("GitHub per-target admission", () => {
  it("resolves the explicit repository without walking or storing a repository catalog", async () => {
    const f = fixture();
    expect(await f.service.resolveRepository(request)).toEqual({
      installationId: "77",
      repositoryId: "100001",
      fullName: request.fullName,
      defaultBranch: "main",
    });
    expect(f.getRepository).toHaveBeenCalledWith(request);
    expect(f.repositoryInstallation).toHaveBeenCalledWith(request.fullName, undefined);
    expect(f.listInstallationRepositories).not.toHaveBeenCalled();
    expect(f.assertUserInstallationAccess).toHaveBeenCalledWith({
      accessToken: request.accessToken,
      installationId: "77",
    });
  });
  it.each(["contents", "pull_requests"] as const)(
    "rejects an installation lacking %s write permission",
    async (permission) => {
      const f = fixture();
      f.installation.permissions[permission] = "read";
      await expect(
        f.service.resolveRepository({ ...request, access: "write", publish: "pull_request" }),
      ).rejects.toMatchObject({ statusCode: 403 });
    },
  );
  it("checks the user's own access even when the App has write permission", async () => {
    const f = fixture();
    f.repository.permissions.push = false;
    await expect(f.service.resolveRepository({ ...request, access: "write" })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(f.repositoryInstallation).not.toHaveBeenCalled();
    expect(await f.service.resolveRepository(request)).toHaveProperty("repositoryId", "100001");
  });
  it("rejects removed user access, suspension and repository identity changes", async () => {
    const f = fixture();
    f.repository.permissions = { pull: false, push: false, admin: false };
    await expect(f.service.resolveRepository(request)).rejects.toMatchObject({ statusCode: 403 });
    f.repository.permissions.pull = true;
    f.installation.suspended = true;
    await expect(f.service.resolveRepository(request)).rejects.toMatchObject({ statusCode: 409 });
    f.installation.suspended = false;
    f.repository.fullName = "other/redirected";
    await expect(f.service.resolveRepository(request)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("propagates removal and transport failure without falling back to App authority", async () => {
    const f = fixture();
    f.getRepository.mockRejectedValue(new Error("denied"));
    await expect(f.service.resolveRepository(request)).rejects.toThrow("denied");
    expect(f.repositoryInstallation).not.toHaveBeenCalled();
  });
});

it("denies a user token that cannot reach this App's exact installation", async () => {
  const f = fixture();
  f.assertUserInstallationAccess.mockRejectedValue(new Error("wrong App or inaccessible installation"));
  await expect(f.service.resolveRepository(request)).rejects.toThrow("wrong App or inaccessible installation");
});

describe("GitHub discovery completeness", () => {
  function discovery() {
    const api = stubGitHubApi();
    api.listUserInstallations.mockResolvedValue(installationsPage([]));
    api.listInstallationRepositories.mockResolvedValue(repositoriesPage([]));
    return { api, service: new GitHubRepositoryAdmissionService({ api: api.asClient(), appId: GITHUB_TEST_APP_ID }) };
  }

  it("attests a fully read empty installation list", async () => {
    const f = discovery();
    expect(await f.service.discoverRepositories({ accessToken: "user-token" })).toEqual({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
      installationsTruncated: false,
    });
  });

  it("exposes the 500-installation bound instead of silently claiming completeness", async () => {
    const f = discovery();
    f.api.listUserInstallations.mockImplementation(async ({ page }: { page: number }) =>
      installationsPage(
        Array.from({ length: 100 }, (_, i) => installation({ installationId: String((page - 1) * 100 + i + 1) })),
        600,
      ),
    );
    const result = await f.service.discoverRepositories({ accessToken: "user-token" });
    expect(result.installations).toHaveLength(500);
    expect(result.installationsTruncated).toBe(true);
    expect(f.api.listUserInstallations).toHaveBeenCalledTimes(5);
  });

  it("does not treat a premature empty provider page as complete", async () => {
    const f = discovery();
    f.api.listUserInstallations.mockResolvedValue(installationsPage([], 1));
    expect((await f.service.discoverRepositories({ accessToken: "user-token" })).installationsTruncated).toBe(true);
  });

  it("skips a suspended installation and continues to the next installation", async () => {
    const f = discovery();
    f.api.listUserInstallations.mockResolvedValue(
      installationsPage([
        installation({ installationId: "1", suspended: true }),
        installation({ installationId: "2" }),
      ]),
    );
    f.api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository()]));
    const first = await f.service.discoverRepositories({ accessToken: "user-token" });
    expect(first.repositories).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    expect(f.api.listInstallationRepositories).not.toHaveBeenCalled();
    const second = await f.service.discoverRepositories({
      accessToken: "user-token",
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.repositories).toHaveLength(1);
    expect(second.repositories[0]?.installationId).toBe("2");
    expect(second.nextCursor).toBeNull();
  });
});
