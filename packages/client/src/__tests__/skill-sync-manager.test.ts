import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAgentSkillsDigest,
  EMPTY_AGENT_SKILLS_DIGEST,
  type RuntimeAgentSkills,
  type RuntimeSkillEntry,
  type RuntimeSkillsManifest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillArchiveDownload } from "../api.js";
import { readLocalSkillsManifest, skillsManifestPath } from "../runtime/skills/skill-manifest-store.js";
import {
  SKILL_SYNC_INITIAL_RETRY_DELAY_MS,
  SKILL_SYNC_MAX_RETRY_DELAY_MS,
  SkillSyncManager,
  type SkillSyncState,
  type SkillSyncTimers,
} from "../runtime/skills/skill-sync-manager.js";
import { buildSkillZip, type SkillZipFixture } from "./fixtures/skill-zip.js";

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function agentHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-skill-sync-"));
  homes.push(home);
  return home;
}

interface FakeServer {
  assignments: Map<string, RuntimeSkillEntry[]>;
  archives: Map<string, Uint8Array>;
  manifestRequests: string[];
  archiveRequests: Array<{ name: string; etag?: string }>;
  failArchive?: (name: string) => Error | SkillArchiveDownload | undefined;
  failManifest?: Error;
  api: {
    runtimeSkillsManifest(token: string, input?: { agentId?: string }): Promise<RuntimeSkillsManifest>;
    downloadRuntimeSkillArchive(token: string, name: string, input?: { etag?: string }): Promise<SkillArchiveDownload>;
  };
}

function agentSkills(agentId: string, skills: RuntimeSkillEntry[]): RuntimeAgentSkills {
  return { agentId, digest: computeAgentSkillsDigest(skills), skills };
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    assignments: new Map(),
    archives: new Map(),
    manifestRequests: [],
    archiveRequests: [],
    api: {
      async runtimeSkillsManifest(token, input = {}) {
        expect(token).toBe("machine-token");
        server.manifestRequests.push(input.agentId ?? "*");
        if (server.failManifest) throw server.failManifest;
        const agents = [...server.assignments.entries()]
          .filter(([agentId]) => input.agentId === undefined || agentId === input.agentId)
          .map(([agentId, skills]) => agentSkills(agentId, skills));
        return { agents };
      },
      async downloadRuntimeSkillArchive(token, name, input = {}) {
        expect(token).toBe("machine-token");
        server.archiveRequests.push({ name, ...(input.etag ? { etag: input.etag } : {}) });
        const override = server.failArchive?.(name);
        if (override instanceof Error) throw override;
        if (override) return override;
        const bytes = server.archives.get(name);
        if (!bytes) throw new Error(`no archive for ${name}`);
        return { status: 200, bytes };
      },
    },
  };
  return server;
}

function publish(server: FakeServer, fixture: SkillZipFixture): RuntimeSkillEntry {
  server.archives.set(fixture.entry.name, fixture.bytes);
  return fixture.entry;
}

function manager(
  server: FakeServer,
  homesByAgent: Record<string, string>,
  options: {
    timers?: SkillSyncTimers;
    now?: () => number;
    recordState?: (agentId: string, state: SkillSyncState) => Promise<void>;
    verifyIntervalMs?: number;
    sweepIntervalMs?: number;
  } = {},
): SkillSyncManager {
  return new SkillSyncManager({
    api: server.api,
    machineToken: "machine-token",
    agentHome: async (agentId) => {
      const home = homesByAgent[agentId];
      if (!home) throw new Error(`workspace for ${agentId} is not ready`);
      return home;
    },
    ...options,
  });
}

function fakeTimers(): SkillSyncTimers & { scheduled: Array<{ callback: () => void; delayMs: number }> } {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    scheduled,
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, unref: () => undefined };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = scheduled.indexOf(handle as (typeof scheduled)[number]);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
}

async function listSkills(home: string): Promise<string[]> {
  return (await readdir(join(home, ".skills"))).filter((entry) => !entry.startsWith(".")).sort();
}

async function listProjection(home: string): Promise<string[]> {
  return (await readdir(join(home, ".claude", "skills"))).sort();
}

describe("SkillSyncManager", () => {
  it("pulls every assigned skill on first sync, projects it, and records the outcome", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(
      server,
      buildSkillZip("alpha", { "SKILL.md": "# alpha", "scripts/run.sh": { content: "run", mode: 0o755 } }),
    );
    const beta = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta" }));
    server.assignments.set("agent-1", [alpha, beta]);
    const recorded: Array<[string, SkillSyncState]> = [];
    const sync = manager(
      server,
      { "agent-1": home },
      {
        now: () => Date.parse("2026-09-11T10:00:00.000Z"),
        recordState: async (agentId, state) => {
          recorded.push([agentId, state]);
        },
      },
    );

    const expectedDigest = computeAgentSkillsDigest([alpha, beta]);
    await expect(sync.reconcile("agent-1")).resolves.toEqual({ status: "synced", digest: expectedDigest });
    expect(await listSkills(home)).toEqual(["alpha", "beta"]);
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha");
    expect((await lstat(join(home, ".skills", "alpha", "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await listProjection(home)).toEqual(["alpha", "beta"]);
    expect(await readlink(join(home, ".claude", "skills", "alpha"))).toBe("../../.skills/alpha");
    expect(await readlink(join(home, ".agents", "skills", "alpha"))).toBe("../../.skills/alpha");
    expect((await readdir(join(home, ".agents", "skills"))).sort()).toEqual(["alpha", "beta"]);
    const local = await readLocalSkillsManifest(home);
    expect(local).toMatchObject({
      schemaVersion: 1,
      agentId: "agent-1",
      digest: expectedDigest,
      syncedAt: "2026-09-11T10:00:00.000Z",
    });
    expect(local?.lastError).toBeUndefined();
    expect(Object.keys(local?.skills ?? {}).sort()).toEqual(["alpha", "beta"]);
    expect(recorded).toEqual([["agent-1", { digest: expectedDigest, syncedAt: "2026-09-11T10:00:00.000Z" }]]);
    expect(server.archiveRequests).toEqual([{ name: "alpha" }, { name: "beta" }]);
    expect(sync.knownAgentIds()).toEqual(["agent-1"]);
  });

  it("does not download anything when the digest matches and the local files are intact", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    server.assignments.set("agent-1", [alpha]);
    const sync = manager(server, { "agent-1": home });
    await sync.reconcile("agent-1");
    server.archiveRequests.length = 0;
    server.manifestRequests.length = 0;

    const digest = computeAgentSkillsDigest([alpha]);
    await expect(sync.reconcile("agent-1")).resolves.toEqual({ status: "unchanged", digest });
    expect(server.manifestRequests).toEqual(["agent-1"]);
    expect(server.archiveRequests).toEqual([]);
    await expect(sync.reconcile("agent-1", { expectedDigest: digest })).resolves.toEqual({
      status: "unchanged",
      digest,
    });
    expect(server.manifestRequests).toEqual(["agent-1"]);
    expect(server.archiveRequests).toEqual([]);
  });

  it("re-fetches only the skill whose files were tampered with", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    const beta = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta" }));
    server.assignments.set("agent-1", [alpha, beta]);
    const sync = manager(server, { "agent-1": home });
    await sync.reconcile("agent-1");
    server.archiveRequests.length = 0;
    await writeFile(join(home, ".skills", "beta", "SKILL.md"), "# tampered");

    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({ status: "synced" });
    expect(server.archiveRequests).toEqual([{ name: "beta" }]);
    expect(await readFile(join(home, ".skills", "beta", "SKILL.md"), "utf8")).toBe("# beta");
  });

  it("removes skills the Server no longer assigns together with their projection links", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    const beta = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta" }));
    server.assignments.set("agent-1", [alpha, beta]);
    const sync = manager(server, { "agent-1": home });
    await sync.reconcile("agent-1");
    server.assignments.set("agent-1", [alpha]);
    await mkdir(join(home, ".skills", ".tmp-alpha-stale"));

    await expect(sync.reconcile("agent-1")).resolves.toEqual({
      status: "synced",
      digest: computeAgentSkillsDigest([alpha]),
    });
    expect(await listSkills(home)).toEqual(["alpha"]);
    expect(await readdir(join(home, ".skills"))).toEqual([".opentag-skills.json", "alpha"]);
    expect(await listProjection(home)).toEqual(["alpha"]);
    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["alpha"]);

    server.assignments.set("agent-1", []);
    await expect(sync.reconcile("agent-1")).resolves.toEqual({ status: "synced", digest: EMPTY_AGENT_SKILLS_DIGEST });
    expect(await listSkills(home)).toEqual([]);
    expect(await listProjection(home)).toEqual([]);
  });

  it("keeps the previous version and leaves no temporary directory when a download fails mid-way", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    const betaV1 = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta v1" }));
    server.assignments.set("agent-1", [alpha, betaV1]);
    const recorded: SkillSyncState[] = [];
    const timers = fakeTimers();
    const sync = manager(
      server,
      { "agent-1": home },
      {
        timers,
        recordState: async (_agentId, state) => {
          recorded.push(state);
        },
      },
    );
    await sync.reconcile("agent-1");

    const betaV2 = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta v2" }));
    const gamma = publish(server, buildSkillZip("gamma", { "SKILL.md": "# gamma" }));
    server.assignments.set("agent-1", [alpha, betaV2, gamma]);
    server.failArchive = (name) => (name === "beta" ? new Error("connection reset") : undefined);

    const failed = await sync.reconcile("agent-1");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("beta: connection reset");
    expect(await readFile(join(home, ".skills", "beta", "SKILL.md"), "utf8")).toBe("# beta v1");
    expect(await readFile(join(home, ".skills", "gamma", "SKILL.md"), "utf8")).toBe("# gamma");
    expect((await readdir(join(home, ".skills"))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    const partialDigest = computeAgentSkillsDigest([alpha, betaV1, gamma]);
    expect(await readLocalSkillsManifest(home)).toMatchObject({ digest: partialDigest, lastError: failed.error });
    expect(recorded.at(-1)).toMatchObject({ digest: partialDigest, lastError: failed.error });
    expect(timers.scheduled.map((entry) => entry.delayMs)).toEqual([SKILL_SYNC_INITIAL_RETRY_DELAY_MS]);

    server.failArchive = undefined;
    server.archiveRequests.length = 0;
    timers.scheduled.shift()?.callback();
    await vi.waitFor(async () => {
      expect(await readFile(join(home, ".skills", "beta", "SKILL.md"), "utf8")).toBe("# beta v2");
    });
    expect(server.archiveRequests).toEqual([{ name: "beta", etag: betaV1.archiveSha256 }]);
    await vi.waitFor(async () => {
      expect((await readLocalSkillsManifest(home))?.lastError).toBeUndefined();
    });
    expect(recorded.at(-1)).toEqual({
      digest: computeAgentSkillsDigest([alpha, betaV2, gamma]),
      syncedAt: expect.any(String),
    });
    expect(timers.scheduled).toEqual([]);
  });

  it("rejects an archive whose checksum or contents disagree with the manifest and keeps the old version", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alphaV1 = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha v1" }));
    server.assignments.set("agent-1", [alphaV1]);
    const sync = manager(server, { "agent-1": home }, { timers: fakeTimers() });
    await sync.reconcile("agent-1");

    const alphaV2 = buildSkillZip("alpha", { "SKILL.md": "# alpha v2" });
    server.assignments.set("agent-1", [alphaV2.entry]);
    server.archives.set("alpha", buildSkillZip("alpha", { "SKILL.md": "# alpha v3" }).bytes);
    const mismatch = await sync.reconcile("agent-1");
    expect(mismatch).toMatchObject({ status: "failed", error: expect.stringContaining("checksum") });
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1");

    const forged = buildSkillZip("alpha", { "SKILL.md": "# alpha v2", "extra.txt": "x" });
    server.assignments.set("agent-1", [
      { ...alphaV2.entry, archiveSha256: forged.archiveSha256, archiveBytes: forged.bytes.length },
    ]);
    server.archives.set("alpha", forged.bytes);
    const content = await sync.reconcile("agent-1");
    expect(content).toMatchObject({ status: "failed", error: expect.stringContaining("manifest") });
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1");
    expect((await readdir(join(home, ".skills"))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  it("sends If-None-Match only for an intact local copy and treats a contradictory 304 as a failure", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alphaV1 = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha v1" }));
    server.assignments.set("agent-1", [alphaV1]);
    const sync = manager(server, { "agent-1": home }, { timers: fakeTimers() });
    await sync.reconcile("agent-1");
    server.archiveRequests.length = 0;

    const alphaV2 = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha v2" }));
    server.assignments.set("agent-1", [alphaV2]);
    server.failArchive = () => ({ status: 304 });
    const stale = await sync.reconcile("agent-1");
    expect(stale).toMatchObject({ status: "failed", error: expect.stringContaining("unchanged archive") });
    expect(server.archiveRequests).toEqual([{ name: "alpha", etag: alphaV1.archiveSha256 }]);
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1");

    server.failArchive = undefined;
    server.archiveRequests.length = 0;
    await writeFile(join(home, ".skills", "alpha", "SKILL.md"), "# damaged");
    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({ status: "synced" });
    expect(server.archiveRequests).toEqual([{ name: "alpha" }]);
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha v2");
  });

  it("keeps two agents' assignments apart and syncs only the agents a skills:changed frame names", async () => {
    const homeA = await agentHome();
    const homeB = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    const beta = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta" }));
    server.assignments.set("agent-a", [alpha]);
    server.assignments.set("agent-b", [beta]);
    const sync = manager(server, { "agent-a": homeA, "agent-b": homeB });
    await Promise.all([sync.reconcile("agent-a"), sync.reconcile("agent-b")]);
    expect(await listSkills(homeA)).toEqual(["alpha"]);
    expect(await listSkills(homeB)).toEqual(["beta"]);
    server.manifestRequests.length = 0;

    server.assignments.set("agent-a", [alpha, beta]);
    await sync.handleSkillsChanged({
      type: "skills:changed",
      agents: [
        { agentId: "agent-a", digest: computeAgentSkillsDigest([alpha, beta]) },
        { agentId: "agent-unknown", digest: EMPTY_AGENT_SKILLS_DIGEST },
      ],
    });
    expect(server.manifestRequests).toEqual(["agent-a"]);
    expect(await listSkills(homeA)).toEqual(["alpha", "beta"]);
    expect(await listSkills(homeB)).toEqual(["beta"]);
    expect(sync.knownAgentIds().sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("coalesces a burst of reconcile calls into at most one queued run per agent", async () => {
    const home = await agentHome();
    const server = fakeServer();
    server.assignments.set("agent-1", [publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }))]);
    const sync = manager(server, { "agent-1": home });
    const first = sync.reconcile("agent-1");
    expect(sync.reconcile("agent-1")).toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    const second = sync.reconcile("agent-1");
    const third = sync.reconcile("agent-1");
    expect(second).toBe(third);
    expect(first).not.toBe(second);
    await Promise.all([first, second, third]);
    expect(server.manifestRequests).toEqual(["agent-1", "agent-1"]);
  });

  it("backs off exponentially up to the cap while the Server is unreachable and recovers afterwards", async () => {
    const home = await agentHome();
    const server = fakeServer();
    server.failManifest = new Error("server unavailable");
    const timers = fakeTimers();
    const recorded: SkillSyncState[] = [];
    const sync = manager(
      server,
      { "agent-1": home },
      {
        timers,
        now: () => Date.parse("2026-09-11T10:00:00.000Z"),
        recordState: async (_agentId, state) => {
          recorded.push(state);
        },
      },
    );

    const delays: number[] = [];
    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({ status: "failed", error: "server unavailable" });
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect(timers.scheduled).toHaveLength(1);
      const scheduled = timers.scheduled[0] as { callback: () => void; delayMs: number };
      delays.push(scheduled.delayMs);
      timers.scheduled.length = 0;
      scheduled.callback();
      await vi.waitFor(() => expect(timers.scheduled).toHaveLength(1));
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
    expect(timers.scheduled[0]?.delayMs).toBe(SKILL_SYNC_MAX_RETRY_DELAY_MS);
    expect(recorded.at(-1)).toEqual({
      digest: EMPTY_AGENT_SKILLS_DIGEST,
      syncedAt: "2026-09-11T10:00:00.000Z",
      lastError: "server unavailable",
    });
    await expect(lstat(skillsManifestPath(home))).rejects.toMatchObject({ code: "ENOENT" });

    server.failManifest = undefined;
    server.assignments.set("agent-1", [publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }))]);
    timers.scheduled.shift()?.callback();
    await vi.waitFor(async () => expect(await listSkills(home)).toEqual(["alpha"]));
    expect(timers.scheduled).toEqual([]);
    expect(recorded.at(-1)?.lastError).toBeUndefined();

    server.failManifest = new Error("down again");
    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({ status: "failed" });
    expect(timers.scheduled[0]?.delayMs).toBe(SKILL_SYNC_INITIAL_RETRY_DELAY_MS);
    expect((await readLocalSkillsManifest(home))?.lastError).toBe("down again");
    sync.close();
    expect(timers.scheduled).toEqual([]);
    await expect(sync.reconcile("agent-1")).resolves.toEqual({ status: "skipped" });
    await expect(sync.verify("agent-2")).resolves.toEqual({ status: "skipped" });
  });

  it("records a failure and retries when the workspace is not ready yet", async () => {
    const server = fakeServer();
    const timers = fakeTimers();
    const sync = manager(server, {}, { timers });
    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({
      status: "failed",
      error: "workspace for agent-1 is not ready",
    });
    expect(timers.scheduled.map((entry) => entry.delayMs)).toEqual([SKILL_SYNC_INITIAL_RETRY_DELAY_MS]);
    expect(server.manifestRequests).toEqual([]);
  });

  it("resynchronizes from scratch when the local manifest is corrupt", async () => {
    const home = await agentHome();
    const server = fakeServer();
    server.assignments.set("agent-1", [publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }))]);
    const sync = manager(server, { "agent-1": home });
    await sync.reconcile("agent-1");
    await writeFile(skillsManifestPath(home), "{not json");
    server.archiveRequests.length = 0;
    await expect(sync.reconcile("agent-1")).resolves.toMatchObject({ status: "synced" });
    expect(server.archiveRequests).toEqual([{ name: "alpha" }]);
    expect((await readLocalSkillsManifest(home))?.agentId).toBe("agent-1");
  });

  it("verifies cheaply, throttles repeats, and escalates to a reconcile on digest or file changes", async () => {
    const home = await agentHome();
    const server = fakeServer();
    const alpha = publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }));
    server.assignments.set("agent-1", [alpha]);
    let now = Date.parse("2026-09-11T10:00:00.000Z");
    const sync = manager(server, { "agent-1": home }, { now: () => now, verifyIntervalMs: 60_000 });

    await expect(sync.verify("agent-1")).resolves.toMatchObject({ status: "synced" });
    server.manifestRequests.length = 0;
    await expect(sync.verify("agent-1")).resolves.toEqual({ status: "skipped" });
    now += 61_000;
    const digest = computeAgentSkillsDigest([alpha]);
    await expect(sync.verify("agent-1")).resolves.toEqual({ status: "unchanged", digest });
    await expect(sync.verify("agent-1", { expectedDigest: digest })).resolves.toEqual({ status: "skipped" });
    expect(server.manifestRequests).toEqual([]);

    now += 61_000;
    await writeFile(join(home, ".skills", "alpha", "SKILL.md"), "# tampered");
    await expect(sync.verify("agent-1")).resolves.toMatchObject({ status: "synced" });
    expect(server.manifestRequests).toEqual(["agent-1"]);
    expect(await readFile(join(home, ".skills", "alpha", "SKILL.md"), "utf8")).toBe("# alpha");

    const beta = publish(server, buildSkillZip("beta", { "SKILL.md": "# beta" }));
    server.assignments.set("agent-1", [alpha, beta]);
    server.manifestRequests.length = 0;
    await expect(
      sync.verify("agent-1", { expectedDigest: computeAgentSkillsDigest([alpha, beta]) }),
    ).resolves.toMatchObject({
      status: "synced",
    });
    expect(server.manifestRequests).toEqual(["agent-1"]);
    expect(await listSkills(home)).toEqual(["alpha", "beta"]);
  });

  it("sweeps every known agent on the configured interval and stops on close", async () => {
    vi.useFakeTimers();
    const home = await agentHome();
    const server = fakeServer();
    server.assignments.set("agent-1", [publish(server, buildSkillZip("alpha", { "SKILL.md": "# alpha" }))]);
    const sync = manager(server, { "agent-1": home }, { sweepIntervalMs: 1_000, verifyIntervalMs: 0 });
    await sync.reconcile("agent-1");
    const verify = vi.spyOn(sync, "verify");
    sync.startSweep();
    sync.startSweep();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verify).toHaveBeenCalledWith("agent-1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verify).toHaveBeenCalledTimes(2);
    sync.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(verify).toHaveBeenCalledTimes(2);
    sync.startSweep();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
