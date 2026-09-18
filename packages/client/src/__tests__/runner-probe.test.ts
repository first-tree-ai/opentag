import { describe, expect, it } from "vitest";
import { expectedFromIdentity, probeRunnerTools, runnerToolsReady } from "../runner/probe.js";
import type { RunnerIdentity } from "../runner/types.js";

type ExecFile = NonNullable<Parameters<typeof probeRunnerTools>[0]>["execFile"];

const GOOD_OUTPUTS: Readonly<Record<string, string>> = {
  "node --version": "v24.19.0\n",
  "git --version": "git version 2.39.5\n",
  "gh --version": "gh version 2.100.0 (2026-09-03)\n",
  "pi --version": "0.84.2\n",
  "context-tree --version": "0.1.14\n",
  "opentag --version": "0.0.5\n",
  "lark-cli --version": "lark-cli version 1.0.92\n",
  "lark-cli im --help": "Message and group chat management\n\nPrefer a +-prefixed shortcut.\n",
  "slack version": "Using slack v4.7.0\n",
  "slack api --help": "Call any Slack API method directly.\n",
};

function identity(): RunnerIdentity {
  return {
    schemaVersion: 1,
    channel: "dev",
    version: "0.0.5",
    sourceSha: "a".repeat(40),
    sourceDirty: false,
    cliPackageName: "open-tag",
    nodeVersion: "v24.19.0",
    pnpmVersion: "10.12.1",
    piPackage: "@earendil-works/pi-coding-agent",
    piVersion: "0.84.2",
    contextTreeVersion: "0.1.14",
    toolLock: {
      node: "v24.19.0",
      piPackage: "@earendil-works/pi-coding-agent",
      piVersion: "0.84.2",
      pnpm: "10.12.1",
      git: "1:2.39.5-0+deb12u3",
      gh: "2.100.0",
    },
  };
}

function router(outputs: Readonly<Record<string, string>>): ExecFile {
  return (async (file: string, args: readonly string[]) => {
    const key = [file, ...args].join(" ");
    const stdout = outputs[key];
    if (stdout === undefined) throw Object.assign(new Error(`${key} missing`), { stderr: "not found" });
    return { stdout, stderr: "" };
  }) as unknown as ExecFile;
}

describe("runner tool probes", () => {
  it("reports per-tool failures without hanging when commands are missing", async () => {
    const execFile = (async (file: string) => {
      throw Object.assign(new Error(`${file} missing`), { stderr: `${file}: not found` });
    }) as unknown as ExecFile;
    const probes = await probeRunnerTools({
      env: { HOME: "/nonexistent", PATH: "/bin" },
      execFile,
      timeoutMs: 50,
    });
    expect(probes.length).toBeGreaterThan(4);
    expect(probes.every((probe) => probe.ok === false)).toBe(true);
    expect(runnerToolsReady(probes)).toBe(false);
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining([
        "git",
        "gh",
        "pi",
        "context-tree",
        "lark-cli",
        "slack",
        "lark-cli:surface",
        "slack:surface",
      ]),
    );
  });

  it("keeps an exec failure diagnostic when stdout and stderr are empty", async () => {
    const execFile = (async () => {
      throw Object.assign(new Error("Command failed: pi --version\n"), {
        stdout: "",
        stderr: "",
        killed: true,
        signal: "SIGTERM",
      });
    }) as unknown as ExecFile;
    const probes = await probeRunnerTools({ execFile, env: { HOME: "/tmp" } });
    const pi = probes.find((probe) => probe.name === "pi");
    expect(pi).toMatchObject({ ok: false });
    expect(pi?.detail).toContain("Command failed: pi --version");
    expect(pi?.detail).toContain("signal=SIGTERM");
    expect(pi?.detail).toContain("killed");
  });

  it("prefers captured stderr over the generic failure message", async () => {
    const execFile = (async () => {
      throw Object.assign(new Error("Command failed: pi --version\n"), {
        stdout: "",
        stderr: "pi: error while loading shared libraries\n",
      });
    }) as unknown as ExecFile;
    const probes = await probeRunnerTools({ execFile, env: { HOME: "/tmp" } });
    const pi = probes.find((probe) => probe.name === "pi");
    expect(pi?.detail).toContain("error while loading shared libraries");
    expect(pi?.detail).not.toContain("Command failed");
  });

  it("passes exact versions and reviewed surface banners", async () => {
    const probes = await probeRunnerTools({
      execFile: router(GOOD_OUTPUTS),
      env: { HOME: "/tmp" },
      expected: expectedFromIdentity(identity()),
    });
    expect(probes.map((probe) => `${probe.name}:${probe.ok}`)).toEqual([
      "node:true",
      "git:true",
      "gh:true",
      "pi:true",
      "context-tree:true",
      "opentag:true",
      "lark-cli:true",
      "lark-cli:surface:true",
      "slack:true",
      "slack:surface:true",
    ]);
    expect(runnerToolsReady(probes)).toBe(true);
  });

  it.each([
    { name: "pi", key: "pi --version", output: "0.84.20\n", why: "suffix version 0.84.20 must not satisfy 0.84.2" },
    { name: "opentag", key: "opentag --version", output: "0.0.50\n", why: "0.0.50 must not satisfy 0.0.5" },
    { name: "node", key: "node --version", output: "v24.19.00\n", why: "v24.19.00 must not satisfy v24.19.0" },
    {
      name: "slack",
      key: "slack version",
      output: "Using slack.bin v4.7.0\n",
      why: "renamed slack.bin breaks the reviewed catalog pattern",
    },
    {
      name: "slack",
      key: "slack version",
      output: "old Using slack v4.7.0\n",
      why: "leading wrapper on the Slack banner",
    },
    {
      name: "slack",
      key: "slack version",
      output: "Using slack v4.7.0 (beta)\n",
      why: "trailing wrapper on the Slack banner",
    },
    {
      name: "lark-cli",
      key: "lark-cli --version",
      output: "old lark-cli version 1.0.92\n",
      why: "leading wrapper on the Lark banner",
    },
    {
      name: "lark-cli",
      key: "lark-cli --version",
      output: "lark-cli version 1.0.92 extra\n",
      why: "trailing wrapper on the Lark banner",
    },
  ])("rejects $name when $why", async ({ name, key, output }) => {
    const probes = await probeRunnerTools({
      execFile: router({ ...GOOD_OUTPUTS, [key]: output }),
      env: { HOME: "/tmp" },
      expected: expectedFromIdentity(identity()),
    });
    expect(probes.find((probe) => probe.name === name)?.ok).toBe(false);
    expect(runnerToolsReady(probes)).toBe(false);
  });

  it.each([
    { command: "lark-cli", key: "lark-cli im --help", output: "totally different banner\n" },
    { command: "slack", key: "slack api --help", output: "totally different banner\n" },
  ])("rejects $command surface probes that exit 0 with the wrong output", async ({ command, key, output }) => {
    const probes = await probeRunnerTools({
      execFile: router({ ...GOOD_OUTPUTS, [key]: output }),
      env: { HOME: "/tmp" },
      expected: expectedFromIdentity(identity()),
    });
    expect(probes.find((probe) => probe.name === `${command}:surface`)?.ok).toBe(false);
    expect(runnerToolsReady(probes)).toBe(false);
  });

  it("accepts exact catalog banners with conventional trailing output", async () => {
    // Multi-line version/help conventions stay accepted: matching is anchored on the first line.
    const probes = await probeRunnerTools({
      execFile: router({
        ...GOOD_OUTPUTS,
        "slack version": "Using slack v4.7.0\nUpdate checks are disabled.\n",
        "lark-cli --version": "lark-cli version 1.0.92\nbuilt from the pinned release\n",
      }),
      env: { HOME: "/tmp" },
      expected: expectedFromIdentity(identity()),
    });
    expect(probes.find((probe) => probe.name === "slack")?.ok).toBe(true);
    expect(probes.find((probe) => probe.name === "lark-cli")?.ok).toBe(true);
    expect(runnerToolsReady(probes)).toBe(true);
  });
});
