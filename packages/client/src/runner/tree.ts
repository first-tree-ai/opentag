import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveContextTreePackage, runContextTreeCli } from "../runtime/context-tree.js";
import { type AssembledContextTreeSkills, assembleContextTreeSkills } from "./skills.js";

export interface DisposableContextTree {
  readonly accountHome: string;
  readonly assembled: AssembledContextTreeSkills;
  /** Removes the disposable account home (with the tree) and the seed project. Never canonical. */
  readonly cleanup: () => Promise<void>;
  readonly skillArguments: readonly string[];
  readonly treePath: string;
  readonly verified: unknown;
}

export async function prepareDisposableContextTree(options: {
  readonly workspace: string;
  readonly home: string;
}): Promise<DisposableContextTree> {
  const assembled = await assembleContextTreeSkills();
  const accountHome = await mkdtemp(join(tmpdir(), "opentag-runner-ct-"));
  let seed: string | undefined;
  const cleanup = async () => {
    await Promise.all([
      rm(accountHome, { force: true, recursive: true }),
      ...(seed ? [rm(seed, { force: true, recursive: true })] : []),
    ]);
  };
  try {
    await writeFile(
      join(accountHome, ".gitconfig"),
      "[user]\n\tname = OpenTag Runner\n\temail = opentag-runner@localhost\n[init]\n\tdefaultBranch = master\n",
      "utf8",
    );
    const environment = { HOME: accountHome, PATH: process.env.PATH ?? "/usr/bin:/bin" };
    seed = await mkdtemp(join(tmpdir(), "opentag-runner-ct-seed-"));
    const created = await runContextTreeCli(assembled.package, ["create", "--project-path", seed, "--json"], {
      env: environment,
    });
    if (created.failureCode) throw new Error(`context-tree create failed: ${created.failureCode}`);
    // The CLI reports a flat payload: { created, branch, commitSha, treePath, ... }.
    const treePath = (created.payload as { treePath?: string } | undefined)?.treePath;
    if (!treePath) throw new Error("context-tree create did not return a tree path");
    const connected = await runContextTreeCli(
      assembled.package,
      ["connect", basename(treePath), "--as", "diagnostic", "--project-path", options.workspace, "--json"],
      { env: environment },
    );
    if (connected.failureCode) throw new Error(`Context Tree connect failed: ${connected.failureCode}`);
    const verified = await runContextTreeCli(assembled.package, ["verify", "--tree-path", treePath, "--json"], {
      env: environment,
    });
    if (verified.failureCode) throw new Error(`context-tree verify failed: ${verified.failureCode}`);
    return {
      accountHome,
      assembled,
      cleanup,
      skillArguments: assembled.skillPaths.flatMap((path) => ["--skill", path]),
      treePath,
      verified: verified.payload,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function contextTreePackageOrThrow() {
  const pack = resolveContextTreePackage();
  if (!pack) throw new Error("Context Tree package is not resolvable");
  return pack;
}
