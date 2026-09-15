import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real child-process probes need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import type {
  AgentRuntimeProbeResult,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { ClaudeCodeAgentRuntimeFactory } from "../providers/claude-code/agent-runtime.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import {
  resolvedClaudeCodeFactory,
  resolvedCodexFactory,
  resolvedPiFactory,
} from "../runtime/client-runtime-composition.js";

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

  it("maps discovery-unknown to non-advancing temporarily_unavailable", async () => {
    const root = await temporaryRoot();
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
          throw Object.assign(new Error("io"), { code: "EIO" });
        },
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "temporarily_unavailable" }],
    });
  });

  it("propagates candidate factory construction errors", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    await executable(caller, "codex");
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
      createCandidateFactory: () => {
        throw new Error("factory exploded");
      },
    });
    await expect(factory.probe({})).rejects.toThrow("factory exploded");
  });

  it("propagates candidate probe errors outside the discovery catch", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    await executable(caller, "claude");
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
        wellKnownDirs: () => [],
      },
      createCandidateFactory: () =>
        ({
          manifest: new ClaudeCodeAgentRuntimeFactory().manifest,
          probe: async () => {
            throw new Error("probe exploded");
          },
        }) as unknown as ClaudeCodeAgentRuntimeFactory,
    });
    await expect(factory.probe({})).rejects.toThrow("probe exploded");
  });

  it("propagates discovery programming errors instead of translating them", async () => {
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
        wellKnownDirs: () => {
          throw new Error("well-known failed");
        },
      },
    });
    await expect(factory.probe({})).rejects.toThrow("well-known failed");
  });

  it("rejects Pi create and resume before successful readiness without invoking a candidate runtime", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    await executable(caller, "pi");
    const probed: string[] = [];
    const created: unknown[] = [];
    const resumed: unknown[] = [];
    const factory = resolvedPiFactory({
      command: "pi",
      environment: {},
      piHome: root,
      sessionDirectory: root,
      sourceEnvironment: { PATH: caller },
      discovery: {
        candidateAllowed: () => true,
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [],
      },
      createCandidateFactory: (command) => {
        probed.push(command);
        return {
          manifest: new PiAgentRuntimeFactory().manifest,
          probe: async () => ({ ready: true, version: "unused", issues: [] }),
          create: async (request: CreateAgentRuntimeRequest) => {
            created.push(request);
            throw new Error("unused create");
          },
          resume: async (request: ResumeAgentRuntimeRequest) => {
            resumed.push(request);
            throw new Error("unused resume");
          },
        } as unknown as PiAgentRuntimeFactory;
      },
    });
    const request: CreateAgentRuntimeRequest = {
      eventSink: async () => undefined,
      systemPrompt: "OpenTag managed system prompt",
      workspace: { cwd: root },
      policy: {
        approvals: "never",
        fileSystem: "unrestricted",
        network: "enabled",
        tools: { mode: "provider-default" },
      },
    };
    expect(() => factory.create(request)).toThrow("Pi provider readiness has not been established");
    expect(() =>
      factory.resume({
        ...request,
        binding: { providerId: "pi", schemaVersion: 1, payload: { session: "unused" } },
      }),
    ).toThrow("Pi provider readiness has not been established");
    expect(probed).toEqual([]);
    expect(created).toEqual([]);
    expect(resumed).toEqual([]);
  });

  it("pins the ready Pi candidate after same-provider fallback and forwards create and resume", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const stale = await realpath(await executable(caller, "pi"));
    const working = await realpath(await executable(wellKnown, "pi"));
    const probed: string[] = [];
    const created: CreateAgentRuntimeRequest[] = [];
    const resumed: ResumeAgentRuntimeRequest[] = [];
    const createdRuntime = { kind: "created-pi" };
    const resumedRuntime = { kind: "resumed-pi" };
    const factory = resolvedPiFactory({
      command: "pi",
      environment: {},
      piHome: root,
      sessionDirectory: root,
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
        if (command === stale) {
          return new PiAgentRuntimeFactory({
            probeRunner: async () => ({ credential: true, rpc: false, version: "old" }),
          });
        }
        return {
          manifest: new PiAgentRuntimeFactory().manifest,
          probe: async () => ({ ready: true, version: "new", issues: [] }),
          create: async (request: CreateAgentRuntimeRequest) => {
            created.push(request);
            return createdRuntime as never;
          },
          resume: async (request: ResumeAgentRuntimeRequest) => {
            resumed.push(request);
            return resumedRuntime as never;
          },
        } as unknown as PiAgentRuntimeFactory;
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "new" });
    expect(probed).toEqual([stale, working]);
    const createRequest: CreateAgentRuntimeRequest = {
      eventSink: async () => undefined,
      systemPrompt: "create-pi",
      workspace: { cwd: root },
      policy: {
        approvals: "never",
        fileSystem: "unrestricted",
        network: "enabled",
        tools: { mode: "provider-default" },
      },
    };
    const resumeRequest: ResumeAgentRuntimeRequest = {
      ...createRequest,
      systemPrompt: "resume-pi",
      binding: { providerId: "pi", schemaVersion: 1, payload: { session: "fixture" } },
    };
    await expect(factory.create(createRequest)).resolves.toBe(createdRuntime);
    await expect(factory.resume(resumeRequest)).resolves.toBe(resumedRuntime);
    expect(created).toEqual([createRequest]);
    expect(resumed).toEqual([resumeRequest]);
  });

  it("does not advance Pi on credential_missing", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const first = await realpath(await executable(caller, "pi"));
    await executable(wellKnown, "pi");
    const probed: string[] = [];
    const factory = resolvedPiFactory({
      command: "pi",
      environment: {},
      piHome: root,
      sessionDirectory: root,
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
        return new PiAgentRuntimeFactory({
          probeRunner: async () => ({ credential: false, rpc: true, version: "new" }),
        });
      },
    });
    const result = await factory.probe({});
    expect(issues(result)).toContain("credential_missing");
    expect(probed).toEqual([first]);
    expect(() => factory.create({} as never)).toThrow("Pi provider readiness has not been established");
    expect(() => factory.resume({} as never)).toThrow("Pi provider readiness has not been established");
  });

  it.skipIf(process.platform === "win32")(
    "forwards explicit packaged skill paths onto the Pi RPC spawn prefix",
    async () => {
      const root = await temporaryRoot();
      const logPath = join(root, "pi-args.jsonl");
      const command = await writeRecordingPiCommand(root, logPath);
      const skillPath = join(root, "packaged-skills");
      const factory = resolvedPiFactory({
        command,
        environment: {},
        piHome: root,
        sessionDirectory: root,
        skillPaths: [skillPath],
        sourceEnvironment: { PATH: root },
        discovery: {
          candidateAllowed: () => true,
          home: root,
          includeLoginShell: false,
          platform: "linux",
          wellKnownDirs: () => [],
        },
      });
      await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "0.84.2" });
      const runtime = await factory.create(piCreateRequest(root));
      // The recording executable exits after capturing argv; it never runs a model.
      await expect(
        runtime.prompt({ runId: "packaged-skills", input: { items: [{ type: "text", text: "hello" }] } }),
      ).resolves.toMatchObject({ status: "failed", error: { code: "provider_error" } });
      await runtime.close();
      expect(rpcLaunchArgs(await readJsonlArgs(logPath))?.slice(0, 2)).toEqual(["--skill", skillPath]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "omits --skill from Pi RPC spawn when packaged skill paths are absent",
    async () => {
      const root = await temporaryRoot();
      const logPath = join(root, "pi-args.jsonl");
      const command = await writeRecordingPiCommand(root, logPath);
      const factory = resolvedPiFactory({
        command,
        environment: {},
        piHome: root,
        sessionDirectory: root,
        sourceEnvironment: { PATH: root },
        discovery: {
          candidateAllowed: () => true,
          home: root,
          includeLoginShell: false,
          platform: "linux",
          wellKnownDirs: () => [],
        },
      });
      await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "0.84.2" });
      const runtime = await factory.create(piCreateRequest(root));
      // The recording executable exits after capturing argv; it never runs a model.
      await expect(
        runtime.prompt({ runId: "no-skills", input: { items: [{ type: "text", text: "hello" }] } }),
      ).resolves.toMatchObject({ status: "failed", error: { code: "provider_error" } });
      await runtime.close();
      const rpcArgs = rpcLaunchArgs(await readJsonlArgs(logPath));
      expect(rpcArgs).toEqual(expect.arrayContaining(["--mode", "rpc"]));
      expect(rpcArgs?.includes("--skill")).toBe(false);
    },
  );

  it("does not prepend a search bin for an explicit command", async () => {
    const root = await temporaryRoot();
    const empty = join(root, "empty");
    await mkdir(empty);
    const explicit = await realpath(await executable(root, "explicit-codex"));
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const factory = resolvedCodexFactory({
      clientVersion: "test",
      command: explicit,
      codexHome: root,
      environment: { PATH: empty },
      sourceEnvironment: {},
      createCandidateFactory: (_command, environment) => {
        capturedEnv = environment;
        return new CodexAgentRuntimeFactory({
          clientVersion: "test",
          probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "1" }),
        });
      },
    });
    await expect(factory.probe({})).resolves.toMatchObject({ ready: true });
    expect(capturedEnv?.PATH).toBe(empty);
  });

  it.skipIf(process.platform === "win32")(
    "executes an env-node Codex candidate by prepending its search bin, which is absent from the frozen PATH",
    async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      const empty = join(root, "empty");
      const version = join(home, ".nvm", "versions", "node", "v22.13.0");
      const bin = join(version, "bin");
      const scriptDir = join(version, "lib", "node_modules", "@openai", "codex", "bin");
      const script = join(scriptDir, "codex.js");
      const invocationLog = join(root, "codex-invocations.jsonl");
      await mkdir(empty);
      await mkdir(bin, { recursive: true });
      await mkdir(scriptDir, { recursive: true });
      await writeFile(
        script,
        [
          "#!/usr/bin/env node",
          'const { appendFileSync } = require("node:fs");',
          'const { createInterface } = require("node:readline");',
          "const args = process.argv.slice(2);",
          'appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args, path: process.env.PATH }) + "\\n");',
          'if (args[0] === "--version") { process.stdout.write("codex-env-node\\n"); process.exit(0); }',
          'if (args[0] === "login" && args[1] === "status") process.exit(0);',
          'if (args[0] === "app-server" && args[1] === "--help") { process.stdout.write("app-server\\n"); process.exit(0); }',
          'if (args[0] !== "app-server") process.exit(1);',
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (!("id" in message)) return;',
          "  let result;",
          '  if (message.method === "initialize") {',
          '    result = { userAgent: "fixture", platformFamily: process.platform, platformOs: process.platform, codexHome: process.env.CODEX_HOME };',
          '  } else if (message.method === "thread/start") {',
          '    result = { thread: { id: "fixture-thread" } };',
          '  } else if (message.method === "thread/resume") {',
          "    result = { thread: { id: message.params.threadId } };",
          "  } else {",
          "    result = {};",
          "  }",
          '  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");',
          "});",
          "",
        ].join("\n"),
      );
      await chmod(script, 0o755);
      await symlink(script, join(bin, "codex"));
      await symlink(process.execPath, join(bin, "node"));
      const canonical = await realpath(join(bin, "codex"));
      const frozen = { CODEX_HOME: root, FIXTURE_LOG: invocationLog, PATH: empty };
      const execFileAsync = promisify(execFile);
      await expect(execFileAsync(canonical, ["--version"], { env: frozen, timeout: 5_000 })).rejects.toThrow();
      const factory = resolvedCodexFactory({
        clientVersion: "test",
        command: "codex",
        codexHome: root,
        environment: frozen,
        sourceEnvironment: { PATH: empty },
        discovery: {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          includeLoginShell: true,
          loginShellEnv: () => ({ nvmBin: bin }),
          loginShellPathDirs: () => [],
          platform: "linux",
          wellKnownDirs: () => [],
        },
      });
      await expect(factory.probe({})).resolves.toMatchObject({ ready: true, version: "codex-env-node" });
      expect(canonical).toBe(await realpath(script));
      const request: CreateAgentRuntimeRequest = {
        eventSink: async () => undefined,
        systemPrompt: "OpenTag managed system prompt",
        workspace: { cwd: root },
        policy: {
          approvals: "on-request",
          fileSystem: "workspace-write",
          network: "disabled",
          tools: { mode: "provider-default" },
        },
      };
      const created = await factory.create(request);
      expect(created.binding).toMatchObject({ providerId: "codex" });
      const binding = created.binding;
      await created.close();
      if (!binding) throw new Error("fixture Codex binding is unavailable");
      const resumed = await factory.resume({ ...request, binding });
      expect(resumed.binding).toEqual(binding);
      await resumed.close();
      const invocations = (await readFile(invocationLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; path?: string });
      expect(invocations.length).toBeGreaterThanOrEqual(8);
      expect(invocations.every((invocation) => invocation.path?.split(delimiter)[0] === bin)).toBe(true);

      let missingPath: NodeJS.ProcessEnv | undefined;
      const noPath = resolvedCodexFactory({
        clientVersion: "test",
        command: "codex",
        codexHome: root,
        environment: {},
        sourceEnvironment: { PATH: empty },
        discovery: {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          includeLoginShell: true,
          loginShellEnv: () => ({ nvmBin: bin }),
          loginShellPathDirs: () => [],
          platform: "linux",
          wellKnownDirs: () => [],
        },
        createCandidateFactory: (_command, environment) => {
          missingPath = environment;
          return new CodexAgentRuntimeFactory({
            clientVersion: "test",
            probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "1" }),
          });
        },
      });
      await noPath.probe({});
      expect(missingPath?.PATH).toBe(bin);

      let alreadyFirst: NodeJS.ProcessEnv | undefined;
      const prepended = resolvedCodexFactory({
        clientVersion: "test",
        command: "codex",
        codexHome: root,
        environment: { PATH: `${bin}${delimiter}${empty}` },
        sourceEnvironment: { PATH: empty },
        discovery: {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          includeLoginShell: true,
          loginShellEnv: () => ({ nvmBin: bin }),
          loginShellPathDirs: () => [],
          platform: "linux",
          wellKnownDirs: () => [],
        },
        createCandidateFactory: (_command, environment) => {
          alreadyFirst = environment;
          return new CodexAgentRuntimeFactory({
            clientVersion: "test",
            probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "1" }),
          });
        },
      });
      await prepended.probe({});
      expect(alreadyFirst?.PATH).toBe(`${bin}${delimiter}${empty}`);
    },
  );
});

const PI_HELP_TOKENS =
  "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name";
const PI_LIST_MODELS_TABLE = [
  "provider  model            context  max-out  thinking  images",
  "fixture   configured-model  128K     8K       no        no",
].join("\n");

async function writeRecordingPiCommand(root: string, logPath: string): Promise<string> {
  const command = join(root, "pi");
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + ${JSON.stringify("\n")});
if (args[0] === "--version") {
  console.log("0.84.2");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(${JSON.stringify(PI_HELP_TOKENS)});
  process.exit(0);
}
if (args.includes("--list-models")) {
  console.log(${JSON.stringify(PI_LIST_MODELS_TABLE)});
  process.exit(0);
}
process.exit(0);
`,
    "utf8",
  );
  await chmod(command, 0o755);
  return command;
}

async function readJsonlArgs(logPath: string): Promise<string[][]> {
  try {
    return (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function rpcLaunchArgs(launches: readonly (readonly string[])[]): string[] | undefined {
  const match = launches.find((args) => args.includes("--mode") && args.includes("rpc"));
  return match ? [...match] : undefined;
}

function piCreateRequest(cwd: string): CreateAgentRuntimeRequest {
  return {
    eventSink: async () => undefined,
    systemPrompt: "OpenTag managed system prompt",
    workspace: { cwd },
    policy: {
      approvals: "never",
      fileSystem: "unrestricted",
      network: "enabled",
      tools: { mode: "provider-default" },
    },
  };
}
