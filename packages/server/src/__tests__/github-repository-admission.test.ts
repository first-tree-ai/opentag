import { describe, expect, it } from "vitest";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import { repository, stubGitHubApi } from "./support/github-fixtures.js";

function fixture() {
  const api = stubGitHubApi();
  return { api, service: new GitHubRepositoryAdmissionService({ api: api.asClient() }) };
}
describe("OAuth repository admission", () => {
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
