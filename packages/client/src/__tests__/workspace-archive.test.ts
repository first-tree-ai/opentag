import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename as renamePath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceArchive,
  restoreWorkspaceArchive,
  WORKSPACE_ARCHIVE_MAX_BYTES,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_ENTRIES,
  WorkspaceArchiveError,
  type WorkspaceArchiveErrorCode,
  type WorkspaceArchiveInfo,
} from "../runner/workspace-archive.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opentag-workspace-archive-"));
  roots.push(dir);
  return dir;
}

async function expectArchiveError(action: () => Promise<unknown>, code: WorkspaceArchiveErrorCode): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceArchiveError);
    expect((error as WorkspaceArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkspaceArchiveError(${code})`);
}

function infoOf(archive: Buffer): WorkspaceArchiveInfo {
  return {
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
    md5: createHash("md5").update(archive).digest("base64"),
  };
}

interface MemberSpec {
  readonly name: string;
  readonly content?: string | Buffer;
  readonly mode?: number;
  readonly type?: "file" | "directory" | "symlink" | "link" | "fifo";
  readonly linkname?: string;
}

const TYPE_FLAGS: Record<NonNullable<MemberSpec["type"]>, number> = {
  file: 0x30, // '0'
  link: 0x31, // '1'
  symlink: 0x32, // '2'
  directory: 0x35, // '5'
  fifo: 0x36, // '6'
};

function writeString(block: Uint8Array, offset: number, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value);
  block.set(encoded.subarray(0, Math.min(encoded.length, length)), offset);
}

function octal(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  writeString(out, 0, value.toString(8).padStart(length - 1, "0"), length - 1);
  return out;
}

/**
 * Hand-built ustar fixtures: streaming libraries refuse (or silently rewrite) several of
 * these shapes — mode 0, traversal names, hard-link members — which is exactly why the
 * restore path must defend against them. Octal fields are written verbatim.
 */
function fixtureContent(content: MemberSpec["content"]): Uint8Array {
  return content instanceof Uint8Array ? content : new TextEncoder().encode(content ?? "");
}

function makeTarGz(members: readonly MemberSpec[]): Buffer {
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const body = fixtureContent(member.content);
    const type = member.type ?? "file";
    const size = type === "file" ? body.length : 0;
    const header = new Uint8Array(512);
    writeString(header, 0, member.name, 100);
    header.set(octal(member.mode ?? (type === "directory" ? 0o755 : 0o644), 8), 100);
    header.set(octal(0, 8), 108); // uid
    header.set(octal(0, 8), 116); // gid
    header.set(octal(size, 12), 124);
    header.set(octal(0, 12), 136); // mtime
    header.fill(0x20, 148, 156); // checksum computed with spaces
    header[156] = TYPE_FLAGS[type];
    writeString(header, 157, member.linkname ?? "", 100);
    writeString(header, 257, "ustar", 6);
    header[263] = 0x30;
    header[264] = 0x30;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(octal(checksum, 7), 148);
    header[155] = 0;
    blocks.push(header);
    if (size > 0) {
      const padded = new Uint8Array(Math.ceil(size / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks.map((block) => Buffer.from(block))));
}

/** PAX preserves long UTF-8 fields that cannot fit in the hand-built ustar headers. */
async function makePaxTarGz(members: readonly MemberSpec[]): Promise<Buffer> {
  const archive = tarPack();
  for (const member of members) {
    archive.entry({ name: member.name, type: member.type ?? "file", linkname: member.linkname }, member.content ?? "");
  }
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

async function writeArchive(root: string, archive: Buffer): Promise<string> {
  const archivePath = join(root, "crafted.tar.gz");
  await writeFile(archivePath, archive);
  return archivePath;
}

/** Recursive descriptor map of a tree: rel -> "dir:<mode>" | "file:<mode>:<hex>" | "link:<target>". */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    const absDir = rel === "" ? root : join(root, ...rel.split("/"));
    const names = (await readdir(absDir)).sort();
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = join(absDir, name);
      const stats = await lstat(childAbs);
      const mode = (stats.mode & 0o777).toString(8);
      if (stats.isSymbolicLink()) {
        entries.set(childRel, `link:${await readlink(childAbs)}`);
      } else if (stats.isDirectory()) {
        entries.set(childRel, `dir:${mode}`);
        await walk(childRel);
      } else {
        const content = await readFile(childAbs);
        entries.set(childRel, `file:${mode}:${content.toString("hex")}`);
      }
    }
  };
  await walk("");
  return entries;
}

async function stagingLeftovers(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.includes(".opentag-restore-"));
}

async function populateWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src", "nested"), { recursive: true });
  await mkdir(join(workspace, ".git", "objects", "ab"), { recursive: true });
  await mkdir(join(workspace, ".opentag", "pi-session", "9f86d081"), { recursive: true });
  await mkdir(join(workspace, "bin"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# workspace\n");
  await writeFile(join(workspace, "src", "nested", "deep.ts"), "export const deep = true;\n");
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(workspace, ".git", "config"), "[core]\n\tbare = false\n");
  await writeFile(join(workspace, ".git", "objects", "ab", "cdef"), randomBytes(64));
  await writeFile(join(workspace, ".env"), "USER_DOTFILE_SECRET=kept\n");
  await writeFile(
    join(workspace, ".opentag", "pi-session", "9f86d081", "binding.json"),
    JSON.stringify({ sessionId: "9f86d081", workspaceFingerprint: "abc123" }),
  );
  await writeFile(join(workspace, ".opentag", "pi-session", "9f86d081", "history.jsonl"), '{"turn":1}\n{"turn":2}\n');
  await writeFile(join(workspace, "bin", "run.sh"), "#!/bin/sh\nexec node worker.mjs\n");
  await chmod(join(workspace, "bin", "run.sh"), 0o755);
  await writeFile(join(workspace, "bin", "notes.txt"), "not executable\n");
}

describe("workspace archive limits", () => {
  it("exposes the documented safety ceilings", () => {
    expect(WORKSPACE_ARCHIVE_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(WORKSPACE_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(WORKSPACE_MAX_ENTRIES).toBe(50_000);
  });
});

describe("createWorkspaceArchive + restoreWorkspaceArchive roundtrip", () => {
  it("round-trips nested files, dotfiles, executable modes, and Pi session state", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await populateWorkspace(workspace);

    const archivePath = join(root, "workspace.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);

    const archive = await readFile(archivePath);
    expect(info).toEqual(infoOf(archive));
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.md5).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    // The archive may hold user secrets: exclusively created, owner-only.
    expect((await lstat(archivePath)).mode & 0o777).toBe(0o600);

    // Restore onto a pre-existing EMPTY destination.
    const restored = join(root, "restored");
    await mkdir(restored);
    await restoreWorkspaceArchive(archivePath, restored, info);

    expect(await snapshotTree(restored)).toEqual(await snapshotTree(workspace));
    const runMode = (await stat(join(restored, "bin", "run.sh"))).mode;
    expect(runMode & 0o111).not.toBe(0);
    const notesMode = (await stat(join(restored, "bin", "notes.txt"))).mode;
    expect(notesMode & 0o111).toBe(0);
    const binding = await readFile(join(restored, ".opentag", "pi-session", "9f86d081", "binding.json"), "utf8");
    expect(JSON.parse(binding)).toEqual({ sessionId: "9f86d081", workspaceFingerprint: "abc123" });
  });

  it("round-trips safe relative symlinks, including chained node_modules layouts", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "lib", "tool", "bin"), { recursive: true });
    await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(workspace, "lib", "tool", "package.json"), '{"name":"tool"}');
    await writeFile(join(workspace, "lib", "tool", "bin", "tool.js"), "#!/usr/bin/env node\n");
    await chmod(join(workspace, "lib", "tool", "bin", "tool.js"), 0o755);
    // pnpm layout: package entry is a link, and .bin shims resolve THROUGH that link.
    await symlink(join("..", "lib", "tool"), join(workspace, "node_modules", "tool"));
    await symlink(join("..", "tool", "bin", "tool.js"), join(workspace, "node_modules", ".bin", "tool"));
    await symlink(join("later", "file.txt"), join(workspace, "dangling-but-contained"));

    const archivePath = join(root, "links.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);
    const restored = join(root, "restored");
    // Restore onto a MISSING destination.
    await restoreWorkspaceArchive(archivePath, restored, info);

    expect(await readlink(join(restored, "node_modules", "tool"))).toBe(join("..", "lib", "tool"));
    expect(await readlink(join(restored, "node_modules", ".bin", "tool"))).toBe(join("..", "tool", "bin", "tool.js"));
    expect(await readlink(join(restored, "dangling-but-contained"))).toBe(join("later", "file.txt"));
    expect(await readFile(join(restored, "node_modules", "tool", "package.json"), "utf8")).toBe('{"name":"tool"}');
    // The .bin shim resolves through the package link to the real file.
    expect(await readFile(join(restored, "node_modules", ".bin", "tool"), "utf8")).toBe("#!/usr/bin/env node\n");
    expect(await snapshotTree(restored)).toEqual(await snapshotTree(workspace));
  });

  it("round-trips dot-prefixed siblings and rejects names that would fail later restoration", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "..normal"), "valid local name");
    const archive = join(root, "state.tar.gz");
    const info = await createWorkspaceArchive(workspace, archive);
    await restoreWorkspaceArchive(archive, join(root, "restored"), info);
    expect(await readFile(join(root, "restored", "..normal"), "utf8")).toBe("valid local name");
    await writeFile(join(workspace, "C:ambiguous"), "cannot be restored portably");
    await expectArchiveError(() => createWorkspaceArchive(workspace, archive), "unsafe-entry");
  });

  it("counts root entries toward the entry limit and rejects payload disguised as the root", async () => {
    const root = await makeRoot();
    for (const [members, code] of [
      [[{ name: ".", content: "hidden bytes" }], "unsafe-member"],
      [
        [
          { name: ".", type: "directory" },
          { name: "./", type: "directory" },
        ],
        "too-many-entries",
      ],
    ] as const) {
      const bytes = makeTarGz(members);
      const archive = join(root, "state.tar.gz");
      await writeFile(archive, bytes);
      await expectArchiveError(
        () => restoreWorkspaceArchive(archive, join(root, "restored"), infoOf(bytes), { maxEntries: 1 }),
        code,
      );
    }
  });

  it("round-trips an empty workspace", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const archivePath = join(root, "empty.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);
    expect(info.bytes).toBeGreaterThan(0);

    const restored = join(root, "restored");
    await restoreWorkspaceArchive(archivePath, restored, info);
    expect((await lstat(restored)).isDirectory()).toBe(true);
    expect(await readdir(restored)).toEqual([]);
  });

  it("restores symlinks that reference members declared later in the archive", async () => {
    const root = await makeRoot();
    const archive = makeTarGz([
      { name: "fwd", type: "symlink", linkname: "target/file.txt" },
      { name: "target", type: "directory" },
      { name: "target/file.txt", content: "later\n" },
    ]);
    const archivePath = await writeArchive(root, archive);
    const restored = join(root, "restored");
    await restoreWorkspaceArchive(archivePath, restored, infoOf(archive));

    expect(await readlink(join(restored, "fwd"))).toBe("target/file.txt");
    expect(await readFile(join(restored, "fwd"), "utf8")).toBe("later\n");
  });

  it("restores restrictive directory modes only after their children", async () => {
    const root = await makeRoot();
    const archive = makeTarGz([
      { name: "locked", type: "directory", mode: 0o500 },
      { name: "locked/file.txt", content: "inside\n", mode: 0o400 },
      { name: "sealed", type: "directory", mode: 0o000 },
      { name: "sealed/inner.txt", content: "deep\n" },
    ]);
    const archivePath = await writeArchive(root, archive);
    const restored = join(root, "restored");
    await restoreWorkspaceArchive(archivePath, restored, infoOf(archive));

    try {
      expect((await lstat(join(restored, "locked"))).mode & 0o777).toBe(0o500);
      expect((await lstat(join(restored, "sealed"))).mode & 0o777).toBe(0o000);
      expect((await lstat(join(restored, "locked", "file.txt"))).mode & 0o777).toBe(0o400);
      expect(await readFile(join(restored, "locked", "file.txt"), "utf8")).toBe("inside\n");
    } finally {
      // Unwind the restrictive modes so fixture cleanup can remove the tree as a non-root user.
      await chmod(join(restored, "locked"), 0o700);
      await chmod(join(restored, "sealed"), 0o700);
    }
  });
});

describe("createWorkspaceArchive validation", () => {
  it("rejects a workspace root that is a symlink or a plain file", async () => {
    const root = await makeRoot();
    const real = join(root, "real");
    await mkdir(real);
    const linked = join(root, "linked");
    await symlink(real, linked);
    const file = join(root, "file.txt");
    await writeFile(file, "x");

    await expectArchiveError(() => createWorkspaceArchive(linked, join(root, "a.tar.gz")), "invalid-workspace");
    await expectArchiveError(() => createWorkspaceArchive(file, join(root, "b.tar.gz")), "invalid-workspace");
  });

  it("rejects an archive path inside the workspace, including beneath dot-prefixed children", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "..private"), { recursive: true });
    // A child named "..private" is INSIDE the workspace even though its name starts with "..".
    await expectArchiveError(
      () => createWorkspaceArchive(workspace, join(workspace, "..private", "a.tar.gz")),
      "unsafe-archive-path",
    );
    await expectArchiveError(
      () => createWorkspaceArchive(workspace, join(workspace, "self.tar.gz")),
      "unsafe-archive-path",
    );
    // A sibling whose name starts with ".." is genuinely outside and allowed.
    const info = await createWorkspaceArchive(workspace, join(root, "..sibling-archive.tar.gz"));
    expect(info.bytes).toBeGreaterThan(0);
  });

  it("rejects absolute, escaping, and chained symlink escapes at creation time", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await symlink("/etc/passwd", join(workspace, "absolute-link"));
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "a.tar.gz")), "unsafe-entry");
    await rm(join(workspace, "absolute-link"));

    await symlink(join("..", "..", "outside"), join(workspace, "escaping-link"));
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "b.tar.gz")), "unsafe-entry");
    await rm(join(workspace, "escaping-link"));

    // Chain escape: "pivot" resolves to the workspace root, so "pivot/../x" leaves the root.
    // Each link passes a lexical stack test; only real component semantics catches it.
    // Link targets are verbatim strings (path.join would lexically collapse the "..").
    await symlink(".", join(workspace, "pivot"));
    await symlink("pivot/../parent-secret", join(workspace, "chained"));
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "c.tar.gz")), "unsafe-entry");
    await rm(join(workspace, "chained"));

    // Nested chain: sub/pivot resolves inside sub, then "sub/pivot/../.." still escapes.
    await symlink(".", join(workspace, "sub", "pivot"));
    await symlink("sub/pivot/../../parent-secret", join(workspace, "nested-chain"));
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "d.tar.gz")), "unsafe-entry");
    await rm(join(workspace, "nested-chain"));

    // Link cycles fail closed instead of looping resolution forever.
    await symlink("cycle-b", join(workspace, "cycle-a"));
    await symlink("cycle-a", join(workspace, "cycle-b"));
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "e.tar.gz")), "unsafe-entry");

    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects workspace hard links to parent files instead of archiving their bytes", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    // Trusted Runner state lives OUTSIDE the workspace; linking to it must never leak its bytes.
    const journal = join(root, "runner-journal.log");
    await writeFile(journal, "trusted-runner-state\n");
    await link(journal, join(workspace, "hard-linked.txt"));
    await writeFile(join(workspace, "plain.txt"), "plain\n");
    expect((await lstat(join(workspace, "hard-linked.txt"))).nlink).toBe(2);

    const archivePath = join(root, "hard.tar.gz");
    await expectArchiveError(() => createWorkspaceArchive(workspace, archivePath), "unsafe-entry");
    await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await readFile(journal, "utf8")).toBe("trusted-runner-state\n");
  });

  it("rejects even intra-workspace hard links under the initial fail-closed policy", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "original.txt"), "shared inode\n");
    await link(join(workspace, "original.txt"), join(workspace, "alias.txt"));

    await expectArchiveError(() => createWorkspaceArchive(workspace, join(root, "intra.tar.gz")), "unsafe-entry");
  });

  it("rejects non-regular workspace entries (sockets) and leaves no partial archive", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(join(workspace, "control.sock"), () => resolveListen());
    });

    const archivePath = join(root, "sock.tar.gz");
    try {
      // The socket file exists while the server is listening; it must never be archived.
      expect((await lstat(join(workspace, "control.sock"))).isSocket()).toBe(true);
      await expectArchiveError(() => createWorkspaceArchive(workspace, archivePath), "unsupported-entry");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }

    await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("enforces the entry, payload, and compressed ceilings (injected lower limits)", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.bin"), randomBytes(64));
    await writeFile(join(workspace, "b.bin"), randomBytes(64));
    await writeFile(join(workspace, "c.bin"), randomBytes(64));

    await expectArchiveError(
      () => createWorkspaceArchive(workspace, join(root, "entries.tar.gz"), { maxEntries: 2 }),
      "too-many-entries",
    );
    await expectArchiveError(
      () => createWorkspaceArchive(workspace, join(root, "bytes.tar.gz"), { maxBytes: 100 }),
      "workspace-too-large",
    );
    await expectArchiveError(
      () => createWorkspaceArchive(workspace, join(root, "archive.tar.gz"), { maxArchiveBytes: 64 }),
      "archive-too-large",
    );
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp") || name.endsWith(".tar.gz"))).toEqual([]);
  });
});

describe("workspace archive limit validation", () => {
  it("rejects a non-positive or non-integer injected limit", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    for (const limits of [
      { maxArchiveBytes: 0 },
      { maxArchiveBytes: 1.5 },
      { maxBytes: -1 },
      { maxBytes: Number.NaN },
      { maxEntries: 0 },
      { maxEntries: 2.5 },
    ]) {
      await expectArchiveError(
        () => createWorkspaceArchive(workspace, join(root, "limits.tar.gz"), limits),
        "invalid-limits",
      );
    }
    // A valid injection still archives normally.
    const info = await createWorkspaceArchive(workspace, join(root, "ok.tar.gz"), { maxEntries: 8 });
    expect(info.bytes).toBeGreaterThan(0);
  });

  it("rejects a workspace root that is missing and an archive path that cannot be canonicalized", async () => {
    const root = await makeRoot();
    // A workspace root that does not exist reports an invalid workspace rather than crashing.
    await expectArchiveError(
      () => createWorkspaceArchive(join(root, "missing"), join(root, "missing.tar.gz")),
      "invalid-workspace",
    );
    // An archive destination whose deepest existing ancestor is a FILE cannot be canonicalized.
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    const blocker = join(root, "blocker");
    await writeFile(blocker, "not a directory");
    await expectArchiveError(() => createWorkspaceArchive(workspace, join(blocker, "nested", "a.tar.gz")), "io-failed");
  });

  it("fails closed when the archive publish step cannot complete", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    // A directory already sitting at the final archive path makes the real rename fail after the
    // temp archive was fully written and fsynced.
    const archivePath = join(root, "blocked.tar.gz");
    await mkdir(archivePath);
    await expectArchiveError(() => createWorkspaceArchive(workspace, archivePath), "io-failed");
    // The temp archive never leaks next to the blocked destination.
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("restoreWorkspaceArchive integrity", () => {
  it("rejects corrupted, truncated, and hash-mismatched archives without touching the destination", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await populateWorkspace(workspace);
    const archivePath = join(root, "workspace.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);
    const archive = await readFile(archivePath);

    // Corrupted body: gzip framing/data checks fail before any swap.
    const corrupted = Buffer.from(archive);
    corrupted.writeUInt8(
      corrupted.readUInt8(Math.floor(corrupted.length / 2)) ^ 0xff,
      Math.floor(corrupted.length / 2),
    );
    const corruptedPath = await writeArchive(root, corrupted);
    const destA = join(root, "dest-a");
    await expectArchiveError(() => restoreWorkspaceArchive(corruptedPath, destA, info), "invalid-archive");
    await expect(lstat(destA)).rejects.toMatchObject({ code: "ENOENT" });

    // Truncated with the original expectation: exact-length check fails first.
    const truncated = archive.subarray(0, archive.length - 64);
    const truncatedPath = await writeArchive(root, Buffer.from(truncated));
    await expectArchiveError(() => restoreWorkspaceArchive(truncatedPath, join(root, "dest-b"), info), "size-mismatch");

    // Truncated with recomputed expectation: gzip stream still ends unexpectedly.
    await expectArchiveError(
      () => restoreWorkspaceArchive(truncatedPath, join(root, "dest-c"), infoOf(Buffer.from(truncated))),
      "invalid-archive",
    );

    // Hash mismatches (sha256 or md5) fail closed.
    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest-d"), { ...info, sha256: "0".repeat(64) }),
      "hash-mismatch",
    );
    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest-e"), { ...info, md5: `${"A".repeat(22)}==` }),
      "hash-mismatch",
    );

    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("rejects malformed expected integrity metadata and over-limit expectations", async () => {
    const root = await makeRoot();
    const archive = makeTarGz([{ name: "a.txt", content: "a" }]);
    const archivePath = await writeArchive(root, archive);
    const info = infoOf(archive);

    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest"), { ...info, sha256: "not-hex" }),
      "invalid-expected",
    );
    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest"), { ...info, md5: "short" }),
      "invalid-expected",
    );
    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest"), info, { maxArchiveBytes: info.bytes - 1 }),
      "invalid-expected",
    );
  });

  it("enforces injected restore ceilings on entries and inflated payload", async () => {
    const root = await makeRoot();
    const archive = makeTarGz([
      { name: "a.bin", content: randomBytes(1024) },
      { name: "b.bin", content: randomBytes(1024) },
    ]);
    const archivePath = await writeArchive(root, archive);
    const info = infoOf(archive);

    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest-a"), info, { maxBytes: 1500 }),
      "workspace-too-large",
    );
    await expectArchiveError(
      () => restoreWorkspaceArchive(archivePath, join(root, "dest-b"), info, { maxEntries: 1 }),
      "too-many-entries",
    );
    expect(await stagingLeftovers(root)).toEqual([]);
    await expect(lstat(join(root, "dest-a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an archive path inside the workspace and non-directory destinations", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    const outsideArchive = join(root, "ok.tar.gz");
    const info = await createWorkspaceArchive(workspace, outsideArchive);

    // Archive path inside the workspace is refused before anything is read.
    const insideArchive = join(workspace, "inside.tar.gz");
    await writeFile(insideArchive, await readFile(outsideArchive));
    await expectArchiveError(() => restoreWorkspaceArchive(insideArchive, workspace, info), "unsafe-archive-path");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("a");

    // Destination that is a symlink or a plain file is refused untouched.
    const realEmpty = join(root, "real-empty");
    await mkdir(realEmpty);
    const destLink = join(root, "dest-link");
    await symlink(realEmpty, destLink);
    await expectArchiveError(() => restoreWorkspaceArchive(outsideArchive, destLink, info), "invalid-destination");
    expect((await lstat(destLink)).isSymbolicLink()).toBe(true);
    expect(await readdir(realEmpty)).toEqual([]);

    const destFile = join(root, "dest-file");
    await writeFile(destFile, "keep me");
    await expectArchiveError(() => restoreWorkspaceArchive(outsideArchive, destFile, info), "invalid-destination");
    expect(await readFile(destFile, "utf8")).toBe("keep me");
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("never overwrites a nonempty workspace and never deletes it on failure", async () => {
    const root = await makeRoot();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "new.txt"), "new state\n");
    const archivePath = join(root, "state.tar.gz");
    const info = await createWorkspaceArchive(source, archivePath);

    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "existing.txt"), "do not touch\n");
    await expectArchiveError(() => restoreWorkspaceArchive(archivePath, workspace, info), "destination-not-empty");
    expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe("do not touch\n");
    expect(await readdir(workspace)).toEqual(["existing.txt"]);
    expect(await stagingLeftovers(root)).toEqual([]);

    // A failed restore against an existing EMPTY destination keeps that destination in place.
    const tampered = { ...info, sha256: "f".repeat(64) };
    await rm(join(workspace, "existing.txt"));
    await expectArchiveError(() => restoreWorkspaceArchive(archivePath, workspace, tampered), "hash-mismatch");
    expect((await lstat(workspace)).isDirectory()).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("restores over an existing empty destination directory without failing", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await populateWorkspace(workspace);
    const archivePath = join(root, "workspace.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);
    // An EMPTY destination that already exists takes the hadDestination path: the validated
    // workspace is swapped in without merging into the old tree.
    const destination = join(root, "existing");
    await mkdir(destination);
    await restoreWorkspaceArchive(archivePath, destination, info);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# workspace\n");
    expect(await readFile(join(destination, ".env"), "utf8")).toBe("USER_DOTFILE_SECRET=kept\n");
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("rejects a symlinked or non-regular archive path before reading it", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    const archivePath = join(root, "workspace.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);

    // A symlink pointing at the real archive is refused: only a regular file is accepted.
    const linkPath = join(root, "link.tar.gz");
    await symlink(archivePath, linkPath);
    await expectArchiveError(() => restoreWorkspaceArchive(linkPath, join(root, "dest-link"), info), "invalid-archive");
    await expect(lstat(join(root, "dest-link"))).rejects.toMatchObject({ code: "ENOENT" });

    // A directory at the archive path is not a regular file either.
    const directoryPath = join(root, "directory.tar.gz");
    await mkdir(directoryPath);
    await expectArchiveError(
      () => restoreWorkspaceArchive(directoryPath, join(root, "dest-dir"), info),
      "invalid-archive",
    );
  });

  it("reports a missing archive file through the io-failed fallback", async () => {
    const root = await makeRoot();
    const missing = join(root, "absent.tar.gz");
    await expectArchiveError(
      () =>
        restoreWorkspaceArchive(missing, join(root, "dest"), {
          bytes: 1,
          md5: "0000000000000000000000==",
          sha256: "0".repeat(64),
        }),
      "io-failed",
    );
  });

  it("reports a non-archive failure through the io-failed fallback", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.txt"), "a");
    const archivePath = join(root, "workspace.tar.gz");
    const info = await createWorkspaceArchive(workspace, archivePath);
    const blocker = join(root, "dest-parent");
    // A plain file where the destination's parent must be a directory makes staging fail with a
    // real ENOTDIR that is not a WorkspaceArchiveError.
    await writeFile(blocker, "not a directory");
    await expectArchiveError(() => restoreWorkspaceArchive(archivePath, join(blocker, "child"), info), "io-failed");
    expect(await readFile(blocker, "utf8")).toBe("not a directory");
  });

  it("creates implicit parents for nested members and applies declared directory modes last", async () => {
    const root = await makeRoot();
    // Nested members without explicit directory entries force the implicit-parent path, and a
    // restrictive declared mode must be applied AFTER the children exist.
    const archive = makeTarGz([
      { content: "deep", name: "a/b/c/deep.txt" },
      { mode: 0o500, name: "a/b/", type: "directory" },
      { content: "top", name: "top.txt" },
    ]);
    const archivePath = await writeArchive(root, archive);
    const destination = join(root, "restored");
    await restoreWorkspaceArchive(archivePath, destination, infoOf(archive));
    expect(await readFile(join(destination, "a", "b", "c", "deep.txt"), "utf8")).toBe("deep");
    expect(await readFile(join(destination, "top.txt"), "utf8")).toBe("top");
    // The declared 0500 mode was applied in finalize, after the child was written.
    expect((await stat(join(destination, "a", "b"))).mode & 0o777).toBe(0o500);
    await chmod(join(destination, "a", "b"), 0o700);
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("rejects a member nested beneath a non-directory and one colliding with a directory", async () => {
    const root = await makeRoot();
    // A file declared first, then a member beneath it, is a structural escape of the namespace.
    const nestedUnderFile = makeTarGz([
      { content: "file", name: "blocked" },
      { content: "child", name: "blocked/child.txt" },
    ]);
    const nestedPath = await writeArchive(root, nestedUnderFile);
    await expectArchiveError(
      () => restoreWorkspaceArchive(nestedPath, join(root, "dest-nested"), infoOf(nestedUnderFile)),
      "unsafe-member",
    );
    await expect(lstat(join(root, "dest-nested"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingLeftovers(root)).toEqual([]);

    // An implicit directory created for an earlier member cannot later be redeclared as a FILE.
    const collision = makeTarGz([
      { content: "child", name: "implicit/child.txt" },
      { content: "now a file", name: "implicit" },
    ]);
    const collisionPath = await writeArchive(root, collision);
    await expectArchiveError(
      () => restoreWorkspaceArchive(collisionPath, join(root, "dest-collision"), infoOf(collision)),
      "unsafe-member",
    );
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("refuses a duplicated member and a NUL byte in a member or link name", async () => {
    const root = await makeRoot();
    const duplicated = makeTarGz([
      { content: "one", name: "dup.txt" },
      { content: "two", name: "dup.txt" },
    ]);
    const duplicatePath = await writeArchive(root, duplicated);
    await expectArchiveError(
      () => restoreWorkspaceArchive(duplicatePath, join(root, "dest-dup"), infoOf(duplicated)),
      "duplicate-member",
    );

    // A NUL byte inside a member name is refused: the name normalizer rejects it explicitly. The
    // header is rewritten byte-for-byte with a literal NUL because ustar names are NUL-padded.
    const withNul = makeTarGz([{ content: "x", name: "plain.txt" }]);
    const nulVariant = Buffer.from(withNul);
    const gunzipped = gunzipSync(nulVariant);
    // The first 100 bytes of the first ustar header are the member name.
    gunzipped.writeUInt8(0x00, 0);
    gunzipped.write("a", 0, "utf8");
    gunzipped.writeUInt8(0x00, 1);
    gunzipped.write("b.txt", 2, "utf8");
    const withNulAgain = gzipSync(gunzipped);
    const nulPath = await writeArchive(root, withNulAgain);
    // A NUL-bearing member name is refused by the archive reader itself (tar-stream sees a
    // malformed header), which is still a fail-closed refusal before any destination work.
    await expectArchiveError(
      () => restoreWorkspaceArchive(nulPath, join(root, "dest-nul"), infoOf(withNulAgain)),
      "invalid-archive",
    );
    await expect(lstat(join(root, "dest-nul"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("strips setuid/setgid/sticky bits and never restores unsafe ownership bits", async () => {
    const root = await makeRoot();
    const archive = makeTarGz([
      { name: "rootish.sh", content: "#!/bin/sh\n", mode: 0o4755 },
      { name: "gid.bin", content: "x", mode: 0o2750 },
      { name: "sticky-dir", type: "directory", mode: 0o1755 },
      { name: "sticky-dir/inner.txt", content: "inner", mode: 0o644 },
    ]);
    const archivePath = await writeArchive(root, archive);
    const restored = join(root, "restored");
    await restoreWorkspaceArchive(archivePath, restored, infoOf(archive));

    const rootish = await stat(join(restored, "rootish.sh"));
    expect(rootish.mode & 0o7000).toBe(0);
    expect(rootish.mode & 0o777).toBe(0o755);
    const gid = await stat(join(restored, "gid.bin"));
    expect(gid.mode & 0o7000).toBe(0);
    expect(gid.mode & 0o777).toBe(0o750);
    const sticky = await stat(join(restored, "sticky-dir"));
    expect(sticky.mode & 0o7000).toBe(0);
    expect(sticky.mode & 0o777).toBe(0o755);
    expect(await readFile(join(restored, "sticky-dir", "inner.txt"), "utf8")).toBe("inner");
  });
});

describe("restoreWorkspaceArchive member validation", () => {
  const malicious: ReadonlyArray<readonly [string, readonly MemberSpec[], WorkspaceArchiveErrorCode]> = [
    ["dot-dot traversal", [{ name: "../escape.txt", content: "x" }], "unsafe-member"],
    ["nested traversal", [{ name: "sub/../../escape.txt", content: "x" }], "unsafe-member"],
    ["absolute member", [{ name: "/etc/passwd-copy", content: "x" }], "unsafe-member"],
    ["drive-letter member", [{ name: "C:/windows.txt", content: "x" }], "unsafe-member"],
    ["backslash member", [{ name: "a\\b.txt", content: "x" }], "unsafe-member"],
    [
      "symlink escaping the root",
      [{ name: "link", type: "symlink", linkname: "../../outside/secret" }],
      "unsafe-member",
    ],
    ["oversized UTF-8 path", [{ name: `${"界".repeat(80)}/`.repeat(5) + "file", content: "x" }], "unsafe-member"],
    [
      "oversized UTF-8 link",
      [{ name: "link", type: "symlink", linkname: `${"界".repeat(80)}/`.repeat(5) + "file" }],
      "unsafe-member",
    ],
    ["absolute symlink", [{ name: "link", type: "symlink", linkname: "/etc/passwd" }], "unsafe-member"],
    [
      "chained symlink escape through a root pivot",
      [
        { name: "pivot", type: "symlink", linkname: "." },
        { name: "chained", type: "symlink", linkname: "pivot/../parent-secret" },
      ],
      "unsafe-member",
    ],
    [
      "chained symlink escape through a nested directory pivot",
      [
        { name: "sub", type: "directory" },
        { name: "sub/pivot", type: "symlink", linkname: "." },
        { name: "chained", type: "symlink", linkname: "sub/pivot/../../parent-secret" },
      ],
      "unsafe-member",
    ],
    [
      "symlink cycle",
      [
        { name: "cycle-a", type: "symlink", linkname: "cycle-b" },
        { name: "cycle-b", type: "symlink", linkname: "cycle-a" },
      ],
      "unsafe-member",
    ],
    [
      "hard-link member",
      [
        { name: "other.txt", content: "x" },
        { name: "hard", type: "link", linkname: "other.txt" },
      ],
      "unsafe-member",
    ],
    ["fifo member", [{ name: "pipe", type: "fifo" }], "unsupported-member"],
    [
      "duplicate members",
      [
        { name: "dup.txt", content: "one" },
        { name: "dup.txt", content: "two" },
      ],
      "duplicate-member",
    ],
    [
      "member nested beneath a file",
      [
        { name: "a.txt", content: "x" },
        { name: "a.txt/b.txt", content: "y" },
      ],
      "unsafe-member",
    ],
    [
      "member nested beneath a symlink",
      [
        { name: "dir", type: "directory" },
        { name: "s", type: "symlink", linkname: "dir" },
        { name: "s/x.txt", content: "y" },
      ],
      "unsafe-member",
    ],
  ];

  for (const [label, members, code] of malicious) {
    it(`rejects ${label}`, async () => {
      const root = await makeRoot();
      const archive = label.startsWith("oversized UTF-8") ? await makePaxTarGz(members) : makeTarGz(members);
      const archivePath = await writeArchive(root, archive);
      const workspace = join(root, "workspace");
      await expectArchiveError(() => restoreWorkspaceArchive(archivePath, workspace, infoOf(archive)), code);
      await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await stagingLeftovers(root)).toEqual([]);
    });
  }
});
