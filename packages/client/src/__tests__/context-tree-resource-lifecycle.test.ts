import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runContextTreeProcess } from "../runtime/context-tree.js";
import { ContextTreeCommandGateway } from "../runtime/context-tree-commands.js";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "ot-tree-io-"));
  roots.push(root);
  return root;
}
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const source = { kind: "git", repository: "acme/memory", path: "docs", ref: "main" } as const;

it("parent-abort and repeated owner close await the same underlying command cleanup", async () => {
  const root = await directory(),
    entered = deferred(),
    release = deferred(),
    parentAbort = new AbortController();
  const parent = {
    signal: parentAbort.signal,
    openContextTree: async () => ({ localHandleFor: () => "fixture", close: async () => undefined }),
  } as unknown as RuntimeCredentialRelay;
  let commandFinished = false;
  const gateway = new ContextTreeCommandGateway({
    parent,
    sources: [source],
    workspace: root,
    stateDirectory: join(root, "state"),
    environment: () => ({}),
    execute: async () => {
      entered.resolve();
      await release.promise;
      commandFinished = true;
      return { code: 1, stdout: "{}", stderr: "cancelled" };
    },
  });
  await gateway.listen("socket");
  let first: Promise<void> | undefined;
  parentAbort.signal.addEventListener(
    "abort",
    () => {
      first = gateway.close();
    },
    { once: true },
  );
  const running = gateway.run(["sync"]);
  try {
    await entered.promise;
    parentAbort.abort();
    const second = gateway.close();
    expect(second).toBe(first);
    let finished = false;
    void second.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(commandFinished).toBe(false);
    release.resolve();
    await Promise.all([running, first, second]);
    expect(commandFinished).toBe(true);
    assert(gateway.socketPath);
    await expect(stat(gateway.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    await running;
    await gateway.close();
  }
});

it("memoizes a cleanup failure and still removes the gateway directory", async () => {
  const root = await directory(),
    signal = new AbortController().signal;
  const gateway = new ContextTreeCommandGateway({
    parent: { signal } as RuntimeCredentialRelay,
    sources: [],
    workspace: root,
    stateDirectory: join(root, "state"),
    environment: () => ({}),
    execute: vi.fn(),
  });
  await gateway.listen("socket");
  const original = http.Server.prototype.close,
    failure = new Error("controlled server cleanup failure");
  vi.spyOn(http.Server.prototype, "close").mockImplementationOnce(function (this: http.Server, callback) {
    original.call(this, callback);
    throw failure;
  });
  const closing = gateway.close();
  expect(gateway.close()).toBe(closing);
  await expect(closing).rejects.toBe(failure);
  await expect(gateway.close()).rejects.toBe(failure);
  assert(gateway.socketPath);
  await expect(stat(gateway.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

async function run(script: string, maxBuffer: number) {
  const root = await directory(),
    path = join(root, "cli.mjs");
  await writeFile(path, script);
  return runContextTreeProcess(process.execPath, [path], { cwd: root, timeout: 5000, maxBuffer, windowsHide: true });
}

it("decodes one UTF-8 character split across actual pipe chunks", async () => {
  expect(
    await run(
      "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8,0xad])), 50);",
      3,
    ),
  ).toEqual({ stdout: "中" });
});

it.each(["abc", "中", "中文"])("accepts the exact byte boundary for %s", async (text) => {
  expect(await run(`process.stdout.write(${JSON.stringify(text)});`, Buffer.byteLength(text))).toEqual({
    stdout: text,
  });
});

it("counts bytes rather than string characters before retaining output", async () => {
  const failure = await run('process.stdout.write("中文");', 5).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(failure instanceof Error && "stdout" in failure && typeof failure.stdout === "string");
  expect(Buffer.byteLength(failure.stdout)).toBeLessThanOrEqual(5);
  expect(failure).toMatchObject({ killed: true });
});

it("stops collecting overflow while TERM is ignored and joins detached descendants", async () => {
  const root = await directory(),
    path = join(root, "flood.mjs"),
    pidFile = join(root, "child.pid");
  await writeFile(
    path,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>process.stdout.write(Buffer.alloc(65536,65)),1);`,
  );
  let childPid: number | undefined;
  try {
    const failure = await runContextTreeProcess(process.execPath, [path], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 1024,
      windowsHide: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert(failure instanceof Error && "stdout" in failure && typeof failure.stdout === "string");
    expect(Buffer.byteLength(failure.stdout)).toBeLessThanOrEqual(1024);
    childPid = Number(await readFile(pidFile, "utf8"));
    assert(Number.isSafeInteger(childPid) && childPid > 1);
    expect(await alive(childPid)).toBe(false);
  } finally {
    if (childPid && (await alive(childPid))) process.kill(childPid, "SIGKILL");
  }
}, 15000);

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value.slice(value.lastIndexOf(") ") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
