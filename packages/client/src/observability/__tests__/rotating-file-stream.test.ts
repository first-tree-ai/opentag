import { writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingFileStream } from "../rotating-file-stream.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RotatingFileStream", () => {
  it("creates private paths and rotates oldest-first within the backup limit", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "logs");
    const stream = new RotatingFileStream(directory, { maxBackups: 2, maxBytes: 5 });
    stream.write("one\n");
    stream.write("two\n");
    stream.write("three\n");
    stream.write("four\n");
    stream.close();

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "client.log"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "client.log"), "utf8")).toBe("four\n");
    expect(await readFile(join(directory, "client.log.1"), "utf8")).toBe("three\n");
    expect(await readFile(join(directory, "client.log.2"), "utf8")).toBe("two\n");
  });

  it("switches permanently to stderr fallback when the file sink cannot open", async () => {
    const root = await temporaryDirectory();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "file");
    const fallback: string[] = [];
    const stream = new RotatingFileStream(blocked, {
      fallbackWrite: (chunk) => fallback.push(chunk),
    });
    expect(() => stream.write("safe\n")).not.toThrow();
    expect(fallback).toEqual(["safe\n"]);
  });

  it("normalizes permissions on a pre-existing directory and log file", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "logs");
    const path = join(directory, "client.log");
    await mkdir(directory, { mode: 0o777 });
    await writeFile(path, "existing\n", { mode: 0o666 });
    await chmod(directory, 0o777);
    await chmod(path, 0o666);

    const stream = new RotatingFileStream(directory);
    stream.write("new\n");
    stream.close();

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("existing\nnew\n");
  });

  it("rejects a symlinked log directory without touching its target", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target");
    const directory = join(root, "logs");
    await mkdir(target);
    await symlink(target, directory, "dir");
    const fallback: string[] = [];

    const stream = new RotatingFileStream(directory, { fallbackWrite: (chunk) => fallback.push(chunk) });
    stream.write("safe\n");

    expect(fallback).toEqual(["safe\n"]);
    await expect(readFile(join(target, "client.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked log file without touching its target", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "logs");
    const target = join(root, "target.log");
    await mkdir(directory);
    await writeFile(target, "unchanged\n");
    await symlink(target, join(directory, "client.log"));
    const fallback: string[] = [];

    const stream = new RotatingFileStream(directory, { fallbackWrite: (chunk) => fallback.push(chunk) });
    stream.write("safe\n");

    expect(fallback).toEqual(["safe\n"]);
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
  });

  it("rejects a non-regular log path", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "logs");
    await mkdir(join(directory, "client.log"), { recursive: true });
    const fallback: string[] = [];

    const stream = new RotatingFileStream(directory, { fallbackWrite: (chunk) => fallback.push(chunk) });
    stream.write("safe\n");

    expect(fallback).toEqual(["safe\n"]);
  });

  it("falls back without throwing when rotation fails", async () => {
    const directory = await temporaryDirectory();
    const fallback: string[] = [];
    const stream = new RotatingFileStream(directory, {
      fallbackWrite: (chunk) => fallback.push(chunk),
      maxBytes: 4,
      operations: {
        rename: () => {
          throw Object.assign(new Error("rename failed"), { code: "EACCES" });
        },
      },
    });
    stream.write("one\n");
    expect(() => stream.write("two\n")).not.toThrow();
    expect(fallback).toEqual(["two\n"]);
  });

  it("loops until a short synchronous write completes the NDJSON line", async () => {
    const directory = await temporaryDirectory();
    const stream = new RotatingFileStream(directory, {
      operations: {
        write: (fileDescriptor, buffer, offset, length) =>
          writeSync(fileDescriptor, buffer, offset, Math.min(1, length)),
      },
    });
    stream.write('{"message":"complete"}\n');
    stream.close();
    expect(await readFile(join(directory, "client.log"), "utf8")).toBe('{"message":"complete"}\n');
  });

  it("swallows a second failure in the synchronous fallback", async () => {
    const root = await temporaryDirectory();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "file");
    const stream = new RotatingFileStream(blocked, {
      fallbackWrite: () => {
        throw new Error("stderr unavailable");
      },
    });
    expect(() => stream.write("safe\n")).not.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-rotation-"));
  directories.push(directory);
  return directory;
}
