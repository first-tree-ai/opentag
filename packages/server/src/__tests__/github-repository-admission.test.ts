/*
 * GitHub repository admission verification: the hard total page budget one verification may walk.
 *
 * A bindings write or recheck re-verifies every bound repository against live GitHub state. The
 * verification walks at most ten repository pages per installation and a hard total across all
 * installations; configurations that cannot be verified inside the budget are rejected with a
 * controlled error — never silently half-verified, and never granted an unbounded upstream walk.
 */

import { randomUUID } from "node:crypto";
import type { GitHubRepositoryBinding } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { hashGitHubRepositoryBindings } from "../services/github/bindings-proof.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "../services/github/errors.js";
import { GitHubRepositoryAdmissionService } from "../services/github/repository-admission.js";
import {
  GITHUB_TEST_APP_ID,
  installation,
  installationsPage,
  repositoriesPage,
  repository,
  stubGitHubApi,
} from "./support/github-fixtures.js";

const NOW = new Date("2026-09-16T00:00:00.000Z");

function serviceFor(api: ReturnType<typeof stubGitHubApi>) {
  return new GitHubRepositoryAdmissionService({ api: api.asClient(), appId: GITHUB_TEST_APP_ID, now: () => NOW });
}

/** Bindings spanning `count` distinct installations, one repository scope each. */
function spanningBindings(count: number): GitHubRepositoryBinding[] {
  return Array.from({ length: count }, (_, index) => ({
    bindingId: randomUUID(),
    installationId: String(1_000 + index),
    repositoryId: "111",
    fullNameDisplay: "octocat/hello-world",
    agentScopes: [{ agentId: randomUUID(), role: "code" as const, access: "read" as const }],
  }));
}

function installationsOf(count: number) {
  return installationsPage(
    Array.from({ length: count }, (_, index) => installation({ installationId: String(1_000 + index) })),
  );
}

describe("GitHubRepositoryAdmissionService verification budget", () => {
  it("verifies a configuration inside the hard total page budget", async () => {
    const api = stubGitHubApi();
    api.listUserInstallations.mockResolvedValue(installationsOf(6));
    // Each installation lists far more repositories than one page holds, forcing full-depth walks.
    api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository({ repositoryId: "111" })], 10_000));
    const bindings = spanningBindings(6);
    const proof = await serviceFor(api).verifyAdmission({
      accessToken: "ghu_token",
      connectionId: randomUUID(),
      authorizationVersion: 1n,
      githubUserId: "42",
      bindings,
    });
    expect(proof.bindingsHash).toBe(hashGitHubRepositoryBindings(bindings));
    // Six installations at the ten-page per-installation bound: inside the total budget.
    expect(api.listInstallationRepositories).toHaveBeenCalledTimes(60);
  });

  it("rejects a configuration that exceeds the hard total page budget instead of walking past it", async () => {
    const api = stubGitHubApi();
    api.listUserInstallations.mockResolvedValue(installationsOf(8));
    api.listInstallationRepositories.mockResolvedValue(repositoriesPage([repository({ repositoryId: "111" })], 10_000));
    const attempt = serviceFor(api).verifyAdmission({
      accessToken: "ghu_token",
      connectionId: randomUUID(),
      authorizationVersion: 1n,
      githubUserId: "42",
      bindings: spanningBindings(8),
    });
    await expect(attempt).rejects.toMatchObject({
      code: GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
      statusCode: 400,
    });
    await expect(attempt).rejects.toBeInstanceOf(GitHubConnectionServiceError);
    // The budget is hard: six full installations (60) plus the partial seventh (4), and not one
    // page more — the eighth installation is never opened.
    expect(api.listInstallationRepositories).toHaveBeenCalledTimes(64);
  });
});
