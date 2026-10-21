import { describe, expect, it } from "vitest";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import { repository, stubGitHubApi } from "./support/github-fixtures.js";

function fixture() {
  const api = stubGitHubApi();
  return { api, service: new GitHubRepositoryAdmissionService({ api: api.asClient() }) };
}
describe("OAuth repository admission", () => {
  it("discovers directly from the connected user with bounded pagination", async () => {
    const { api, service } = fixture();
    api.listUserRepositories.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => repository({ repositoryId: String(i + 1) })),
    );
    expect(await service.discoverRepositories({ accessToken: "gho_test" })).toMatchObject({
      nextCursor: "2",
      truncated: false,
    });
    expect(api.listUserRepositories).toHaveBeenCalledWith({ accessToken: "gho_test", page: 1 });
    expect(await service.discoverRepositories({ accessToken: "gho_test", cursor: "100" })).toMatchObject({
      nextCursor: null,
      truncated: true,
    });
    api.listUserRepositories.mockResolvedValue([]);
    expect(await service.discoverRepositories({ accessToken: "gho_test", cursor: "2" })).toEqual({
      repositories: [],
      nextCursor: null,
      truncated: false,
    });
  });
  it.each(["0", "101", "-1", "1.5", "01", "1e1", "", "https://evil.test", " 2"])(
    "rejects cursor %s before network",
    async (cursor) => {
      const { api, service } = fixture();
      await expect(service.discoverRepositories({ accessToken: "gho_test", cursor })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(api.listUserRepositories).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["read", true, false, false, true],
    ["read", false, true, false, true],
    ["read", false, false, true, true],
    ["read", false, false, false, false],
    ["write", true, false, false, false],
    ["write", false, true, false, true],
    ["write", false, false, true, true],
  ] as const)("checks %s against live pull=%s push=%s admin=%s", async (access, pull, push, admin, allowed) => {
    const { api, service } = fixture();
    api.getRepository.mockResolvedValue(repository({ permissions: { pull, push, admin } }));
    const result = service.resolveRepository({ accessToken: "gho_test", fullName: "octocat/hello-world", access });
    if (allowed) await expect(result).resolves.toMatchObject({ repositoryId: "987654321" });
    else await expect(result).rejects.toMatchObject({ code: "GITHUB_ADMISSION_PERMISSION_INSUFFICIENT" });
  });
  it("refuses renamed or foreign repository identity and propagates cancellation", async () => {
    const { api, service } = fixture();
    const signal = new AbortController().signal;
    api.getRepository.mockResolvedValue(repository({ fullName: "other/repository" }));
    await expect(
      service.resolveRepository({ accessToken: "gho_test", fullName: "octocat/hello-world", access: "read", signal }),
    ).rejects.toMatchObject({ code: "GITHUB_ADMISSION_REPOSITORY_MISSING" });
    expect(api.getRepository).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });
});
