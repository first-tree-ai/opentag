import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProbeResult } from "../agent-runtime/types.js";
import { ClaudeCodeAgentRuntimeFactory } from "../providers/claude-code/agent-runtime.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import { resolvedClaudeCodeFactory, resolvedCodexFactory } from "../runtime/client-runtime-composition.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-resolved-factory-"));
  temporaryRoots.push(root);
  return root;
}

async function executable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function issues(result: AgentRuntimeProbeResult): string[] {
  return result.issues.map((issue) => issue.code);
}

describe("resolved provider factories candidate fallback", () => {
  it("advances to the next same-Provider candidate on version_incompatible and does not spawn login-shell", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const stale = await realpath(await executable(caller, "codex"));
    const working = await realpath(await executable(wellKnown, "codex"));
    const loginShellPathDirs = vi.fn(async () => [join(root, "login")]);
    const probed: string[] = [];
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: "codex",
      codexHome: root,
      environment: {},
      sourceEnvironment: { PATH: caller },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: true,
        loginShellPathDirs,
        platform: "linux",
        wellKnownDirs: () => [wellKnown],
      },
      createCandidateFactory: (command) => {
        probed.push(command);
        return new CodexAgentRuntimeFactory({
          clientVersion: "test",
          probeRunner: async () => {
            if (command === stale) {
              throw Object.assign(new Error("old"), { code: 1 });
            }
            return { appServer: true, credential: true, experimentalTools: true, version: "new" };
          },
        });
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "new" });
    expect(probed).toEqual([stale, working]);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });

  it("advances Claude Code to the next same-Provider candidate after a deterministic binary failure", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const stale = await realpath(await executable(caller, "claude"));
    const working = await realpath(await executable(wellKnown, "claude"));
    const probed: string[] = [];
    const factory = resolvedClaudeCodeFactory({
      claudeCodeHome: root,
      command: "claude",
      environment: {},
      sourceEnvironment: { PATH: caller },
      discovery: {
        candidateAllowed: () => true,
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [wellKnown],
      },
      createCandidateFactory: (command) => {
        probed.push(command);
        return new ClaudeCodeAgentRuntimeFactory({
          probeRunner: async () => {
            if (command === stale) throw Object.assign(new Error("fault"), { signal: "SIGSEGV" });
            return { credential: true, streamJson: true, version: "new" };
          },
        });
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "new" });
    expect(probed).toEqual([stale, working]);
  });

  it("does not advance on credential_missing, mixed issues, or temporarily_unavailable", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const first = await realpath(await executable(caller, "codex"));
    await executable(wellKnown, "codex");
    const cases: Array<{ result: AgentRuntimeProbeResult; expected: string }> = [
      {
        result: { ready: false, issues: [{ code: "credential_missing", message: "logged out" }] },
        expected: "credential_missing",
      },
      {
        result: {
          ready: false,
          issues: [
            { code: "version_incompatible", message: "old" },
            { code: "credential_missing", message: "logged out" },
          ],
        },
        expected: "version_incompatible",
      },
      {
        result: { ready: false, issues: [{ code: "temporarily_unavailable", message: "timeout" }] },
        expected: "temporarily_unavailable",
      },
      {
        result: { ready: false, issues: [{ code: "configuration_invalid", message: "bad" }] },
        expected: "configuration_invalid",
      },
    ];
    for (const testCase of cases) {
      const probed: string[] = [];
      const canned = resolvedCodexFactory({
        clientVersion: "test",
        command: "codex",
        codexHome: root,
        environment: {},
        sourceEnvironment: { PATH: caller },
        discovery: {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          includeLoginShell: false,
          platform: "linux",
          wellKnownDirs: () => [wellKnown],
        },
        createCandidateFactory: (command) => {
          probed.push(command);
          return {
            manifest: new CodexAgentRuntimeFactory({ clientVersion: "test" }).manifest,
            probe: async () => testCase.result,
            create: async () => {
              throw new Error("unused");
            },
            resume: async () => {
              throw new Error("unused");
            },
          } as unknown as CodexAgentRuntimeFactory;
        },
      });
      const result = await canned.probe({});
      expect(issues(result)).toContain(testCase.expected);
      expect(probed).toEqual([first]);
    }
  });

  it("does not give an absolute explicit command fallback semantics", async () => {
    const root = await temporaryRoot();
    const explicit = await realpath(await executable(root, "explicit-codex"));
    const other = join(root, "other");
    await executable(other, "codex");
    const loginShellPathDirs = vi.fn(async () => [other]);
    const probed: string[] = [];
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: explicit,
      codexHome: root,
      environment: {},
      sourceEnvironment: { PATH: other },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [other],
        home: root,
        includeLoginShell: true,
        loginShellPathDirs,
        platform: "linux",
        wellKnownDirs: () => [other],
      },
      createCandidateFactory: (command) => {
        probed.push(command);
        return new CodexAgentRuntimeFactory({
          clientVersion: "test",
          probeRunner: async () => {
            throw Object.assign(new Error("old"), { code: 1 });
          },
        });
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
    expect(probed).toEqual([explicit]);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });

  it("skips login-shell on pre-connect and consults it when includeLoginShell becomes true", async () => {
    const root = await temporaryRoot();
    const login = join(root, "login");
    const working = await realpath(await executable(login, "claude"));
    let includeLoginShell = false;
    const loginShellPathDirs = vi.fn(async () => [login]);
    const factory = resolvedClaudeCodeFactory({
      claudeCodeHome: root,
      command: "claude",
      environment: {},
      sourceEnvironment: { PATH: "" },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: () => includeLoginShell,
        loginShellPathDirs,
        platform: "linux",
        wellKnownDirs: () => [],
      },
      createCandidateFactory: (command) =>
        new ClaudeCodeAgentRuntimeFactory({
          probeRunner: async () => {
            if (command !== working) throw new Error("missing");
            return { credential: true, streamJson: true, version: "2" };
          },
        }),
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    includeLoginShell = true;
    await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "2" });
    expect(loginShellPathDirs).toHaveBeenCalledOnce();
  });

  it("never substitutes another Provider when Codex candidates are exhausted", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    await executable(caller, "codex");
    await executable(caller, "claude");
    const probed: string[] = [];
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: "codex",
      codexHome: root,
      environment: {},
      sourceEnvironment: { PATH: caller },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [],
      },
      createCandidateFactory: (command) => {
        probed.push(command);
        return new CodexAgentRuntimeFactory({
          clientVersion: "test",
          probeRunner: async () => {
            throw Object.assign(new Error("old"), { code: 1 });
          },
        });
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
    expect(probed.every((command) => command.endsWith("codex"))).toBe(true);
    expect(probed.some((command) => command.endsWith("claude"))).toBe(false);
  });

  it("returns artifact_missing when discovery yields no candidates", async () => {
    const root = await temporaryRoot();
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: "codex",
      codexHome: root,
      environment: {},
      sourceEnvironment: { PATH: "" },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [],
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
  });

  it("returns the last Claude binary-shaped result after same-Provider candidate fallback", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    await realpath(await executable(caller, "claude"));
    const factory = resolvedClaudeCodeFactory({
      claudeCodeHome: root,
      command: "claude",
      environment: {},
      sourceEnvironment: { PATH: caller },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [],
      },
      createCandidateFactory: () =>
        new ClaudeCodeAgentRuntimeFactory({
          probeRunner: async () => {
            throw Object.assign(new Error("old"), { code: 1 });
          },
        }),
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
  });

  it("maps a missing absolute Claude command through discovery failure without fallback", async () => {
    const root = await temporaryRoot();
    const factory = resolvedClaudeCodeFactory({
      claudeCodeHome: root,
      command: join(root, "missing-claude"),
      environment: {},
      sourceEnvironment: {},
      discovery: {
        includeLoginShell: false,
        platform: "linux",
        home: root,
        wellKnownDirs: () => [],
        desktopAppDirs: () => [],
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
  });

  it("rethrows an aborted Codex discovery failure", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: "codex",
      codexHome: root,
      environment: {},
      sourceEnvironment: { PATH: join(root, "bin") },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [],
        stat: async () => {
          controller.abort(new Error("stop discovery"));
          throw Object.assign(new Error("io"), { code: "EIO" });
        },
      },
    });
    await expect(factory.probe({ signal: controller.signal })).rejects.toThrow();
  });

  it("rethrows an aborted Claude discovery failure", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const factory = resolvedClaudeCodeFactory({
      claudeCodeHome: root,
      command: "claude",
      environment: {},
      sourceEnvironment: { PATH: "" },
      discovery: {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => {
          controller.abort(new Error("stop Claude discovery"));
          throw new Error("well-known failed");
        },
      },
    });
    await expect(factory.probe({ signal: controller.signal })).rejects.toThrow("well-known failed");
  });
});
