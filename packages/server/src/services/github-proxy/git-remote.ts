import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitHubRepositoryFullNameSchema } from "@opentag/shared";
import { GitPublicationError, type GitRefUpdate } from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit, runTrustedProcess } from "./git-process.js";

export interface PublicationRemote {
  seed(repository: string, options: GitProcessOptions, allowedRefs?: readonly string[]): Promise<void>;
  publish(repository: string, updates: GitRefUpdate[], options: GitProcessOptions): Promise<void>;
  refs(repository: string, refs: string[], options: GitProcessOptions): Promise<Map<string, string>>;
}

/** Credentials reach only this trusted Git process environment, never URLs, argv, or persisted config. */
export class GitHubPublicationRemote implements PublicationRemote {
  readonly #fullName: string;
  readonly #token: string;
  constructor(input: { fullName: string; token: string }) {
    const name = GitHubRepositoryFullNameSchema.safeParse(input.fullName);
    if (!name.success || !/^[a-zA-Z0-9_.-]{1,4096}$/.test(input.token))
      throw new GitPublicationError("invalid_request");
    this.#fullName = name.data;
    this.#token = input.token;
  }

  async #options(options: GitProcessOptions): Promise<GitProcessOptions> {
    const helper = join(options.cwd, "askpass.sh");
    await writeFile(
      helper,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$OPENTAG_GIT_TOKEN" ;; esac\n',
      { mode: 0o700 },
    );
    return { ...options, environment: { ...options.environment, GIT_ASKPASS: helper, OPENTAG_GIT_TOKEN: this.#token } };
  }

  async seed(repository: string, options: GitProcessOptions, allowedRefs?: readonly string[]): Promise<void> {
    await runTrustedGit(
      ["-C", repository, "remote", "add", "origin", `https://github.com/${this.#fullName}.git`],
      options,
    );
    let refspecs = ["+refs/heads/*:refs/heads/*"];
    if (allowedRefs) {
      const refs = await runTrustedGit(
        ["-c", "http.followRedirects=false", "-C", repository, "ls-remote", "--heads", "origin", ...allowedRefs],
        await this.#options(options),
      );
      refspecs = refs
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", ref = ""] = line.split("\t");
          if (!/^[a-f0-9]{40}$/.test(sha) || !ref.startsWith("refs/heads/"))
            throw new GitPublicationError("unavailable");
          return `+${ref}:${ref}`;
        });
      if (!refspecs.length) return;
    }
    await runTrustedGit(
      [
        "-c",
        "http.followRedirects=false",
        "-C",
        repository,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        ...refspecs,
      ],
      await this.#options(options),
    );
  }

  async publish(repository: string, updates: GitRefUpdate[], options: GitProcessOptions): Promise<void> {
    const result = await runTrustedProcess(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "http.followRedirects=false",
        "-C",
        repository,
        "push",
        "--atomic",
        "--porcelain",
        ...updates.map(
          (update) => `--force-with-lease=${update.ref}:${update.oldSha === "0".repeat(40) ? "" : update.oldSha}`,
        ),
        "origin",
        ...updates.map((update) => `${update.newSha}:${update.ref}`),
      ],
      await this.#options(options),
    );
    if (result.code !== 0) throw new GitPublicationError("remote_conflict");
  }

  async refs(repository: string, refs: string[], options: GitProcessOptions): Promise<Map<string, string>> {
    const output = await runTrustedGit(
      ["-c", "http.followRedirects=false", "-C", repository, "ls-remote", "--heads", "origin", ...refs],
      await this.#options(options),
    );
    const result = new Map<string, string>();
    for (const line of output.toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const [sha = "", ref = ""] = line.split("\t");
      if (!/^[a-f0-9]{40}$/.test(sha) || !refs.includes(ref)) throw new GitPublicationError("unavailable");
      result.set(ref, sha);
    }
    return result;
  }
}
