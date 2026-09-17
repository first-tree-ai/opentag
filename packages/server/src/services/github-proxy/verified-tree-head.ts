import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { GitPublicationError } from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit } from "./git-process.js";
import { assertDirectoryBudget } from "./git-publication.js";
import type { PublicationRemote } from "./git-remote.js";
import type { GitWorkspace } from "./git-workspace.js";
import { verifyPublishedContextTree } from "./tree-verifier.js";

export class VerifiedTreeHead {
  #active = 0;
  constructor(readonly options: { workspace: GitWorkspace }) {}
  async verify(input: {
    repositoryId: string;
    ref: string;
    remote: PublicationRemote;
    signal: AbortSignal;
    recheck(): Promise<void>;
  }): Promise<string> {
    if (this.#active >= 4) throw new GitPublicationError("resource_limit");
    this.#active++;
    let directory: string | undefined;
    const abort = new AbortController();
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || !directory) return;
      checking = true;
      void assertDirectoryBudget(directory, 512 * 1024 * 1024)
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 500);
    monitor.unref();
    try {
      await input.recheck();
      directory = await this.options.workspace.stagingDirectory("tree-head-");
      const home = join(directory, "home");
      await mkdir(home, { mode: 0o700 });
      const options: GitProcessOptions = {
        cwd: directory,
        signal: AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(120_000)]),
        environment: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ATTR_NOSYSTEM: "1",
          LC_ALL: "C",
        },
      };
      const repository = join(directory, "repository.git");
      await runTrustedGit(["-c", "init.templateDir=", "init", "--bare", repository], options);
      await input.remote.seed(repository, options, [input.ref]);
      await assertDirectoryBudget(directory, 512 * 1024 * 1024);
      const sha = (await runTrustedGit(["-C", repository, "rev-parse", "--verify", `${input.ref}^{commit}`], options))
        .toString("utf8")
        .trim();
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitPublicationError("tree_invalid");
      await verifyPublishedContextTree(repository, sha, options);
      await input.recheck();
      const current = await input.remote.refs(repository, [input.ref], options);
      if (current.get(input.ref) !== sha) throw new GitPublicationError("remote_conflict");
      return sha;
    } finally {
      clearInterval(monitor);
      abort.abort();
      this.#active--;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
