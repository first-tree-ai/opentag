import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fakeCliScript } from "./provider-cli.js";

/**
 * Test-only helpers for Provider CLI product integration coverage. These fixtures
 * never touch the real account home, public network, or staging credentials.
 */

export interface FileTreeSnapshotEntry {
  readonly hash: string;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly rel: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Recursively snapshot regular files under `root` by relative path, digest, mode, and mtime. */
export async function snapshotFileTree(root: string): Promise<readonly FileTreeSnapshotEntry[]> {
  const entries: FileTreeSnapshotEntry[] = [];
  async function walk(path: string): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) await walk(join(path, child.name));
      return;
    }
    if (!info.isFile()) return;
    entries.push({
      hash: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      mode: info.mode,
      mtimeMs: info.mtimeMs,
      rel: relative(root, path) || ".",
    });
  }
  await walk(root);
  return entries.sort((left, right) => left.rel.localeCompare(right.rel));
}

/** Slack fixture CLI: version/surface probes plus the fixed validation argv, with an invocation log. */
export function slackProductCliScript(options: {
  readonly invocationLog: string;
  readonly version: string;
  readonly teamId?: string;
  readonly botUserId?: string;
  readonly botId?: string;
}): string {
  const payload = JSON.stringify({
    ok: true,
    team_id: options.teamId ?? "T1",
    user_id: options.botUserId ?? "U1",
    bot_id: options.botId ?? "B1",
  });
  return fakeCliScript("slack", { version: options.version })
    .replace("#!/bin/sh\n", `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(options.invocationLog)}\n`)
    .replace(
      '  "api --help")\n    echo surface-ok',
      `  "api auth.test")\n    printf '%s\\n' ${shellQuote(payload)}\n    exit 0 ;;\n  "api --help")\n    echo surface-ok`,
    );
}
