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

/**
 * A push whose own porcelain report shows every pushed ref rejected (`!` flag) by the remote.
 * That is definitive server-acknowledged non-application evidence, unlike a bare transport
 * failure, which proves nothing about whether the update landed.
 */
export class GitPushRejectedError extends GitPublicationError {
  constructor(readonly rejectedRefs: readonly string[]) {
    super("remote_conflict");
    this.name = "GitPushRejectedError";
  }
}

/**
 * Parses `git push --porcelain` stdout for definitive all-refs rejection evidence. The report
 * is only trusted when it is complete (`Done` trailer), every line is well-formed, no pushed
 * ref carries an applied/no-change flag, and every pushed ref appears with the `!` flag.
 * Anything else returns undefined: transport failures, truncated reports, and mixed outcomes
 * remain ambiguous and must keep the conservative unknown classification.
 */
export function parseRejectedPushRefs(stdout: string, updates: readonly GitRefUpdate[]): string[] | undefined {
  const lines = stdout.split("\n").filter((line) => line !== "" && !line.startsWith("To "));
  // A missing `Done` trailer means a truncated report, which can hide further ref lines.
  if (lines.at(-1) !== "Done") return undefined;
  const parsed = lines.slice(0, -1).map(parsePorcelainRefLine);
  if (parsed.length === 0 || parsed.some((line) => !line)) return undefined;
  const rejected = new Set<string>();
  for (const line of parsed as { flag: string; to: string }[]) {
    // An applied, forced, new, deleted, or up-to-date flag on any pushed ref contradicts
    // all-refs rejection; the outcome cannot be proven from this report.
    if (line.flag !== "!" && updates.some((update) => update.ref === line.to)) return undefined;
    if (line.flag === "!") rejected.add(line.to);
  }
  if (rejected.size === 0 || !updates.every((update) => rejected.has(update.ref))) return undefined;
  return updates.map((update) => update.ref);
}

/** One machine-readable ref status line: `<flag>\t<from>:<to>\t<reason>`; anything else is unproven. */
function parsePorcelainRefLine(line: string): { flag: string; to: string } | undefined {
  const match = /^([ +\-*!=])\t([^\t]+)\t(.+)$/.exec(line);
  if (!match) return undefined;
  const [, flag, summary] = match;
  return { flag: flag as string, to: (summary as string).slice((summary as string).indexOf(":") + 1) };
}

/**
 * Selects fetch refspecs from ls-remote output for a ref-restricted snapshot. Remote pattern
 * matching is never the authority: its documented tail-glob semantics return attacker-planted
 * refs such as `refs/heads/x/refs/heads/main` for the exact pattern `refs/heads/main` (proven
 * locally against git 2.50). Only an exact authorized ref or a Session task-prefix (`.../*`)
 * match may enter the trusted snapshot; anything else the remote offers is skipped.
 */
export function seedRefspecsForAllowedRefs(lsRemoteOutput: string, allowedRefs: readonly string[]): string[] {
  const exact = new Set(allowedRefs.filter((ref) => !ref.endsWith("*")));
  const prefixes = allowedRefs.filter((ref) => ref.endsWith("*")).map((ref) => ref.slice(0, -1));
  const granted = (ref: string) => exact.has(ref) || prefixes.some((prefix) => ref.startsWith(prefix));
  const refspecs: string[] = [];
  for (const line of lsRemoteOutput.trim().split("\n")) {
    if (!line) continue;
    const [sha = "", ref = ""] = line.split("\t");
    if (!/^[a-f0-9]{40}$/.test(sha) || !ref.startsWith("refs/heads/")) throw new GitPublicationError("unavailable");
    if (granted(ref)) refspecs.push(`+${ref}:${ref}`);
  }
  return refspecs;
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
      refspecs = seedRefspecsForAllowedRefs(refs.toString("utf8"), allowedRefs);
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
    if (result.code !== 0) {
      const rejectedRefs = parseRejectedPushRefs(result.stdout.toString("utf8"), updates);
      if (rejectedRefs) throw new GitPushRejectedError(rejectedRefs);
      throw new GitPublicationError("remote_conflict");
    }
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
