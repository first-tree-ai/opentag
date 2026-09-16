import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRunnerCli } from "../runner/cli.js";
import { RUNNER_IDENTITY_SCHEMA_VERSION } from "../runner/types.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write(chunk: string) {
        stdout.push(chunk);
      },
      chunks: stdout,
    },
    stderr: {
      write(chunk: string) {
        stderr.push(chunk);
      },
      chunks: stderr,
    },
  };
}

describe("runner CLI entry", () => {
  it("exits nonzero for missing or invalid config without hanging", async () => {
    const missing = io();
    expect(await runRunnerCli([], missing)).toBe(2);
    expect(missing.stderr.chunks.join("")).toMatch(/missing command/);
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-cli-"));
    directories.push(cwd);
    const identity = io();
    expect(await runRunnerCli(["identity"], identity, cwd)).toBe(1);
    expect(identity.stderr.chunks.join("")).toMatch(/identity file is missing/);
  });

  it("prints a stored identity record", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-id-"));
    directories.push(cwd);
    await writeFile(
      join(cwd, "identity.json"),
      `${JSON.stringify({
        schemaVersion: RUNNER_IDENTITY_SCHEMA_VERSION,
        channel: "prod",
        version: "0.0.5",
        sourceSha: "440dfed53c3bb22a8527cd731f82e9b9006bd9b5",
        sourceDirty: false,
        cliPackageName: "open-tag",
        nodeVersion: "v24.19.0",
        pnpmVersion: "10.12.1",
        piPackage: "@earendil-works/pi-coding-agent",
        piVersion: "0.84.2",
        contextTreeVersion: "0.1.14",
        toolLock: {
          node: "v24.19.0",
          pnpm: "10.12.1",
          piPackage: "@earendil-works/pi-coding-agent",
          piVersion: "0.84.2",
        },
      })}\n`,
    );
    const captured = io();
    expect(await runRunnerCli(["identity", "--json"], captured, cwd)).toBe(0);
    expect(captured.stdout.chunks.join("")).toMatch(/"version":"0.0.5"/);
  });

  it("prints a stored identity record as text and reports a corrupt record as an error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-idtext-"));
    directories.push(cwd);
    await writeFile(
      join(cwd, "identity.json"),
      `${JSON.stringify({
        schemaVersion: RUNNER_IDENTITY_SCHEMA_VERSION,
        channel: "dev",
        version: "0.0.5",
        sourceSha: "440dfed53c3bb22a8527cd731f82e9b9006bd9b5",
        sourceDirty: true,
        cliPackageName: "open-tag-dev",
        nodeVersion: "v24.19.0",
        pnpmVersion: "10.12.1",
        piPackage: "@earendil-works/pi-coding-agent",
        piVersion: "0.84.2",
        contextTreeVersion: "0.1.14",
        toolLock: {
          node: "v24.19.0",
          pnpm: "10.12.1",
          piPackage: "@earendil-works/pi-coding-agent",
          piVersion: "0.84.2",
        },
      })}\n`,
    );
    const text = io();
    expect(await runRunnerCli(["identity"], text, cwd)).toBe(0);
    expect(text.stdout.chunks.join("")).toBe("0.0.5 440dfed53c3bb22a8527cd731f82e9b9006bd9b5 dirty\n");
    await writeFile(join(cwd, "identity.json"), "{not valid\n");
    const broken = io();
    expect(await runRunnerCli(["identity"], broken, cwd)).toBe(1);
    expect(broken.stderr.chunks.join("").length).toBeGreaterThan(0);
  });

  it("lists the six Context Tree skills as text and JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-skills-"));
    directories.push(cwd);
    const text = io();
    expect(await runRunnerCli(["skills"], text, cwd)).toBe(0);
    const names = text.stdout.chunks.join("").trim().split("\n");
    expect(names).toHaveLength(6);
    expect(names).toContain("context-tree-read");
    const json = io();
    expect(await runRunnerCli(["skills", "--json"], json, cwd)).toBe(0);
    const payload = JSON.parse(json.stdout.chunks.join("")) as { skills: string[]; skillsPath: string };
    expect(payload.skills).toHaveLength(6);
    expect(payload.skillsPath.length).toBeGreaterThan(0);
  });

  it("probes tools and reports per-tool status without identity expectations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-probe-"));
    directories.push(cwd);
    const env = { HOME: cwd, PATH: join(cwd, "empty-bin") };
    const captured = { ...io(), env };
    const code = await runRunnerCli(["probe"], captured, cwd);
    expect(code).toBe(1);
    const lines = captured.stdout.chunks.join("").trim().split("\n");
    expect(lines.some((line) => line.includes("node"))).toBe(true);
    expect(lines.some((line) => line.includes("FAIL node"))).toBe(true);
    const json = { ...io(), env };
    const jsonCode = await runRunnerCli(["probe", "--json"], json, cwd);
    expect(jsonCode).toBe(1);
    const probes = JSON.parse(json.stdout.chunks.join("")) as Array<{ name: string; ok: boolean }>;
    expect(probes.some((probe) => probe.name === "node")).toBe(true);
    expect(probes.every((probe) => !probe.ok)).toBe(true);
  }, 60_000);

  it("runs an offline accept through a disposable scratch and reports model=skipped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-accept-"));
    const home = await mkdtemp(join(tmpdir(), "opentag-runner-accept-home-"));
    directories.push(cwd, home);
    const captured = io();
    const code = await runRunnerCli(
      ["accept"],
      { ...captured, env: { HOME: home, PATH: join(cwd, "empty-bin") } },
      cwd,
    );
    expect(code).toBe(1);
    const out = captured.stdout.chunks.join("");
    expect(out).toMatch(/offline=failed/);
    expect(out).toMatch(/model=skipped/);
  }, 120_000);

  it("rejects an unsupported provider before any config copy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-provider-"));
    directories.push(cwd);
    const captured = io();
    expect(
      await runRunnerCli(["accept", "--mode", "real", "--pi-config-dir", cwd, "--provider", "openai"], captured, cwd),
    ).toBe(2);
    expect(captured.stderr.chunks.join("")).toMatch(/unsupported provider for real acceptance: openai/);
  });

  it("never leaks full or partial canary when the copied config is malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-canary-"));
    const config = await mkdtemp(join(tmpdir(), "opentag-runner-canary-cfg-"));
    directories.push(cwd, config);
    await writeFile(join(config, "auth.json"), "canary1234567890\n");
    const captured = io();
    expect(
      await runRunnerCli(
        ["accept", "--mode", "real", "--pi-config-dir", config, "--provider", "deepseek"],
        { ...captured, env: { HOME: cwd, PATH: join(cwd, "empty-bin") } },
        cwd,
      ),
    ).toBe(1);
    const stderr = captured.stderr.chunks.join("");
    expect(stderr).toContain("auth.json is not valid JSON");
    expect(stderr).not.toMatch(/canary/i);
    expect(stderr).not.toContain("1234567890");
    for (let length = 4; length <= "canary1234567890".length; length += 1) {
      expect(stderr).not.toContain("canary1234567890".slice(0, length));
    }
  });

  it("rejects real accept without a provider or config directory at parse time", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-parse-"));
    directories.push(cwd);
    const missingDir = io();
    expect(await runRunnerCli(["accept", "--mode", "real"], missingDir, cwd)).toBe(2);
    expect(missingDir.stderr.chunks.join("")).toMatch(/real mode requires --pi-config-dir/);
    const missingProvider = io();
    expect(await runRunnerCli(["accept", "--pi-config-dir", cwd], missingProvider, cwd)).toBe(2);
    expect(missingProvider.stderr.chunks.join("")).toMatch(/requires --provider/);
    const unknown = io();
    expect(await runRunnerCli(["frobnicate"], unknown, cwd)).toBe(2);
    expect(unknown.stderr.chunks.join("")).toMatch(/unknown command/);
  });
});
