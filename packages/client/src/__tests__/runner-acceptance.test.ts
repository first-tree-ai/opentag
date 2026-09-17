import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentPromptRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeFactory,
  AgentRuntimeProbeResult,
} from "../agent-runtime/types.js";
import { createTrackedFactory, RUNNER_PI_PROBE_TIMEOUT_MS, runRunnerAcceptance } from "../runner/acceptance.js";
import { CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES } from "../runner/skills.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function completed(runId: string, text: string) {
  return { runId, status: "completed" as const, output: [{ type: "text" as const, text }] };
}

// Minimal hermetic Pi probe contract: exact help tokens and a valid models table.
const RUNNER_PROBE_HELP =
  "--mode rpc --session-id --session-dir --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --tools --model --thinking --append-system-prompt --name";

function fakeFactory(options: { credential?: boolean }): AgentRuntimeFactory {
  const binding = { providerId: "pi", schemaVersion: 1, payload: { sessionId: "s" } };
  const createRuntime = (): AgentRuntime =>
    ({
      binding,
      async close() {
        return undefined;
      },
      async prompt(request: { runId: string }) {
        return completed(request.runId, "42");
      },
    }) as unknown as AgentRuntime;
  let ready = false;
  return {
    manifest: { providerId: "pi", displayName: "Pi", contractVersion: 2, bindingSchemaVersion: 1 },
    async probe(): Promise<AgentRuntimeProbeResult> {
      ready = options.credential !== false;
      return {
        ready,
        version: "0.84.2",
        issues: ready ? [] : [{ code: "credential_missing", message: "Pi has no configured model credential" }],
      };
    },
    async create() {
      if (!ready) throw new Error("Pi provider readiness has not been established");
      return createRuntime();
    },
    async resume() {
      if (!ready) throw new Error("Pi provider readiness has not been established");
      return createRuntime();
    },
  } as AgentRuntimeFactory;
}

describe("runner acceptance", () => {
  it("reports model skipped separately from successful offline checks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-acc-"));
    directories.push(workspace);
    const report = await runRunnerAcceptance({
      mode: "offline",
      piHome: workspace,
      runtimeHome: workspace,
      sessionDirectory: join(workspace, "sessions"),
      workspace,
      probeTools: async () => [{ name: "git", ok: true, detail: "git version 2.39.5" }],
      assembleSkills: async () => ({
        package: { root: workspace, cliPath: join(workspace, "cli"), skillsPath: join(workspace, "skills") },
        skillsPath: join(workspace, "skills"),
        skillPaths: [join(workspace, "skills")],
        skills: CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES.map((name) => ({
          name,
          directory: join(workspace, "skills", name),
          skillFile: join(workspace, "skills", name, "SKILL.md"),
        })),
      }),
    });
    expect(report.offline).toBe("passed");
    expect(report.model).toBe("skipped");
    expect(report.failed).toBe(false);
  });

  it("fails real mode clearly when the model credential is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-real-"));
    directories.push(workspace);
    const report = await runRunnerAcceptance({
      mode: "real",
      piHome: workspace,
      runtimeHome: workspace,
      sessionDirectory: join(workspace, "sessions"),
      workspace,
      factory: fakeFactory({ credential: false }),
      probeTools: async () => [{ name: "git", ok: true }],
      assembleSkills: async () => ({
        package: { root: workspace, cliPath: join(workspace, "cli"), skillsPath: join(workspace, "skills") },
        skillsPath: join(workspace, "skills"),
        skillPaths: [join(workspace, "skills")],
        skills: CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES.map((name) => ({
          name,
          directory: join(workspace, "skills", name),
          skillFile: join(workspace, "skills", name, "SKILL.md"),
        })),
      }),
    });
    expect(report.model).toBe("failed");
    expect(
      report.events.some((item) => item.name === "model" && item.detail?.includes("no configured model credential")),
    ).toBe(true);
  });

  it("hands the spawned Pi exactly the provided piHome as its agent config directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-env-"));
    directories.push(workspace);
    const piHome = join(workspace, "filtered-pi");
    const bin = join(workspace, "bin");
    const record = join(workspace, "pi-env.txt");
    await mkdir(piHome, { recursive: true });
    await mkdir(bin, { recursive: true });
    // A hermetic stand-in for the Pi CLI: answer the exact probe contract and record which agent
    // config directory every invocation was handed through PI_CODING_AGENT_DIR.
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$PI_CODING_AGENT_DIR" >> "${record}"`,
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --version) echo "0.84.2"; exit 0 ;;',
      `    --help) echo "${RUNNER_PROBE_HELP}"; exit 0 ;;`,
      `    --list-models) printf 'provider model context max-out thinking images\\ndeepseek deepseek-v4.1 128000 8192 max no\\n'; exit 0 ;;`,
      "  esac",
      "done",
      "exit 0",
      "",
    ].join("\n");
    await writeFile(join(bin, "pi"), script, { mode: 0o755 });
    const factory = createTrackedFactory(
      {
        mode: "real",
        piHome,
        runtimeHome: join(workspace, "home"),
        path: bin,
        sessionDirectory: join(workspace, "sessions"),
        workspace,
      },
      [],
      new Set<number>(),
    );
    const probe = await factory.probe({});
    expect(probe).toMatchObject({ ready: true, issues: [] });
    const seen = (await readFile(record, "utf8")).trim().split("\n");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(seen)]).toEqual([piHome]);
  });
});

type CancelBehaviour = "aborted" | "completed" | "rejected";

/**
 * A scripted stand-in for the Pi adapter: the fixture turn does real file I/O, the child turn
 * spawns a real long-lived shell fixture (ready marker + PID file + sleep + delayed write), and
 * the abort settles exactly the way the behaviour selects. This exercises the acceptance cancel
 * contract — live PID proof, strict cancellation status, tree gone, no delayed write — without
 * any model credential or network.
 */
function scriptedModelFactory(workspace: string, behaviour: CancelBehaviour): AgentRuntimeFactory {
  const binding = { providerId: "pi", schemaVersion: 1, payload: { sessionId: "s" } };
  let eventSink: (event: AgentRuntimeEvent) => void = () => undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const killChild = () => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const createRuntime = (): AgentRuntime =>
    ({
      binding,
      async close() {
        killChild();
      },
      async prompt(request: AgentPromptRequest) {
        if (request.runId === "runner-fixture") {
          const [left = 0, right = 0] = (await readFile(join(workspace, "fixture.txt"), "utf8"))
            .trim()
            .split(/\s+/)
            .map(Number);
          const sum = String(left + right);
          eventSink({ type: "tool_started", runId: request.runId, toolCallId: "t1", name: "Read" });
          eventSink({
            type: "tool_completed",
            runId: request.runId,
            toolCallId: "t1",
            name: "Read",
            status: "completed",
          });
          await writeFile(join(workspace, "sum.txt"), `${sum}\n`, "utf8");
          return { runId: request.runId, status: "completed" as const, output: [{ type: "text" as const, text: sum }] };
        }
        if (request.runId === "runner-resume") {
          const sum = (await readFile(join(workspace, "sum.txt"), "utf8")).trim();
          return { runId: request.runId, status: "completed" as const, output: [{ type: "text" as const, text: sum }] };
        }
        if (request.runId === "runner-child") {
          eventSink({ type: "tool_started", runId: request.runId, toolCallId: "t2", name: "Bash" });
          child = spawn(
            "sh",
            [
              "-c",
              `printf READY > "${join(workspace, "child-ready.txt")}"; echo $$ > "${join(workspace, "child.pid")}"; sleep 300; echo leaked > "${join(workspace, "delayed.txt")}"`,
            ],
            { detached: true, stdio: "ignore" },
          );
          child.on("error", () => undefined);
          return await new Promise((resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => {
                killChild();
                if (behaviour === "aborted") {
                  resolve({
                    runId: request.runId,
                    status: "aborted",
                    output: [],
                    error: { code: "run_aborted", message: "run was interrupted" },
                  });
                } else if (behaviour === "completed") {
                  resolve({ runId: request.runId, status: "completed", output: [] });
                } else {
                  reject(new Error("provider socket exploded"));
                }
              },
              { once: true },
            );
          });
        }
        throw new Error(`unexpected run ${request.runId}`);
      },
    }) as unknown as AgentRuntime;
  return {
    manifest: { providerId: "pi", displayName: "Pi", contractVersion: 2, bindingSchemaVersion: 1 },
    async probe(): Promise<AgentRuntimeProbeResult> {
      return { ready: true, version: "0.84.2", issues: [] };
    },
    async create(request: { eventSink: (event: AgentRuntimeEvent) => void }) {
      eventSink = request.eventSink;
      return createRuntime();
    },
    async resume(request: { eventSink: (event: AgentRuntimeEvent) => void }) {
      eventSink = request.eventSink;
      return createRuntime();
    },
  } as unknown as AgentRuntimeFactory;
}

function fakeAssembledSkills(workspace: string) {
  return {
    package: { root: workspace, cliPath: join(workspace, "cli"), skillsPath: join(workspace, "skills") },
    skillsPath: join(workspace, "skills"),
    skillPaths: [join(workspace, "skills")],
    skills: CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES.map((name) => ({
      name,
      directory: join(workspace, "skills", name),
      skillFile: join(workspace, "skills", name, "SKILL.md"),
    })),
  };
}

describe("runner acceptance cancel contract", () => {
  it("passes real mode with a confirmed cancellation and a reaped fixture tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-cancel-"));
    directories.push(workspace);
    const report = await runRunnerAcceptance({
      mode: "real",
      piHome: workspace,
      runtimeHome: workspace,
      sessionDirectory: join(workspace, "sessions"),
      workspace,
      factory: scriptedModelFactory(workspace, "aborted"),
      probeTools: async () => [{ name: "git", ok: true }],
      assembleSkills: async () => fakeAssembledSkills(workspace),
    });
    expect(report.model).toBe("passed");
    expect(report.failed).toBe(false);
    expect(report.events.some((item) => item.name === "model-cancel" && item.status === "passed")).toBe(true);
    expect(typeof report.firstTaskMs).toBe("number");
  }, 30_000);

  it.each([
    { behaviour: "completed" as const, detail: "confirmed cancellation status/cause" },
    { behaviour: "rejected" as const, detail: "rejected instead of reporting a cancellation status" },
  ])(
    "fails when the cancel settles as $behaviour instead of a cancellation",
    async ({ behaviour, detail }) => {
      const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-cancel-bad-"));
      directories.push(workspace);
      const report = await runRunnerAcceptance({
        mode: "real",
        piHome: workspace,
        runtimeHome: workspace,
        sessionDirectory: join(workspace, "sessions"),
        workspace,
        factory: scriptedModelFactory(workspace, behaviour),
        probeTools: async () => [{ name: "git", ok: true }],
        assembleSkills: async () => fakeAssembledSkills(workspace),
      });
      expect(report.model).toBe("failed");
      expect(report.failed).toBe(true);
      expect(report.events.some((item) => item.name === "model" && item.detail?.includes(detail))).toBe(true);
    },
    30_000,
  );
});

describe("runner acceptance disposable Context Tree", () => {
  it("prepares, verifies, and cleans a real disposable tree with the exact skill argument contract", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-ctacc-"));
    directories.push(workspace);
    const report = await runRunnerAcceptance({
      mode: "offline",
      piHome: workspace,
      runtimeHome: workspace,
      sessionDirectory: join(workspace, "sessions"),
      workspace,
      probeTools: async () => [{ name: "git", ok: true, detail: "git version 2.39.5" }],
    });
    expect(report.offline, JSON.stringify(report.events)).toBe("passed");
    expect(report.model).toBe("skipped");
    expect(report.failed).toBe(false);

    const skillsEvent = report.events.find((item) => item.name === "skills");
    expect(skillsEvent?.status).toBe("passed");
    expect(skillsEvent?.detail?.split(",").sort()).toEqual([...CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES].sort());

    // Explicit skill loading: --no-skills first, then six individual --skill <dir> arguments.
    const args = report.skillArguments ?? [];
    expect(args[0]).toBe("--no-skills");
    const skillDirs = args.filter((_, index) => index > 0 && args[index - 1] === "--skill");
    for (const name of CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES) {
      expect(skillDirs.some((dir) => dir.endsWith(`/${name}`))).toBe(true);
    }
    expect(report.events.find((item) => item.name === "skills-args")?.detail).toContain("--no-skills");
    expect(report.events.some((item) => item.name === "tool-skills")).toBe(true);

    // The disposable tree/account home and seed are removed by the acceptance cleanup.
    const treeEvent = report.events.find((item) => item.name === "context-tree");
    expect(treeEvent?.status).toBe("passed");
    expect(treeEvent?.detail).toBeTruthy();
    await expect(stat(treeEvent?.detail as string)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("blocks real mode before any model work when offline checks fail", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-offlinefail-"));
    directories.push(workspace);
    const report = await runRunnerAcceptance({
      mode: "real",
      piHome: workspace,
      runtimeHome: workspace,
      sessionDirectory: join(workspace, "sessions"),
      workspace,
      factory: fakeFactory({ credential: true }),
      probeTools: async () => [{ name: "git", ok: false, detail: "git missing" }],
      assembleSkills: async () => fakeAssembledSkills(workspace),
    });
    expect(report.offline).toBe("failed");
    expect(report.model).toBe("failed");
    expect(report.failed).toBe(true);
    expect(
      report.events.some(
        (item) => item.name === "model" && item.detail?.includes("offline checks must pass before real mode"),
      ),
    ).toBe(true);
  });

  it("prepares the native Pi probe with the 30s Runner budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runner-probe-"));
    directories.push(workspace);
    const pi = join(workspace, "pi");
    await writeFile(
      pi,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exec '${process.execPath}' -e 'setTimeout(() => { console.log("0.84.2"); }, 5200)'
fi
if [ "$1" = "--offline" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--help" ]; then echo ${JSON.stringify(RUNNER_PROBE_HELP)}; exit 0; fi
  done
  echo "provider  model            context  max-out  thinking  images"
  echo "fixture   configured-model  128K     8K       no        no"
  exit 0
fi
exit 1
`,
      "utf8",
    );
    await chmod(pi, 0o755);
    expect(RUNNER_PI_PROBE_TIMEOUT_MS).toBe(30_000);
    const factory = createTrackedFactory(
      {
        mode: "real",
        piHome: workspace,
        runtimeHome: workspace,
        sessionDirectory: join(workspace, "sessions"),
        workspace,
        path: workspace,
      },
      [],
      new Set(),
    );
    // The same delayed startup fails on the provider's 5s default; the Runner budget must accept it.
    await expect(factory.probe({})).resolves.toEqual({ ready: true, version: "0.84.2", issues: [] });
  }, 20_000);
});
