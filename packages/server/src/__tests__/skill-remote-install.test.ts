import { createHash, randomUUID } from "node:crypto";
import { SKILL_ERROR_CODES, SKILL_MAX_PER_AGENT } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentSkills } from "../db/schema/index.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import { runTrustedProcess } from "../services/github-proxy/git-process.js";
import type { SkillService } from "../services/skills/index.js";
import { RemoteSkillService } from "../services/skills/source/remote-skill-service.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { startGitRepositoryFixture } from "./support/git-http-fixture.js";
import { skillManifest, tarGz } from "./support/skill-archive-fixtures.js";
import { createSkillHarness, type SkillHarness } from "./support/skill-service-harness.js";
import { stubFetcher } from "./support/skill-source-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Remote Skill installation against the real `SkillService` and a real database: what a source
 * offers, what happens to each selected name, and what lands in the Agent afterwards.
 *
 * The source side is a stubbed HTTP surface for the well-known cases and a real local repository for
 * the git case, so both transports reach `SkillService.upload` through the same code.
 */

const SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

type StubAnswer = { status: number; body?: Uint8Array | string };
type StubRoutes = Record<string, () => StubAnswer | undefined>;

let unit: UnitDatabase;
let h: SkillHarness;

beforeAll(async () => {
  unit = await createUnitDatabase();
  h = createSkillHarness(unit);
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fetcherServing(routes: StubRoutes) {
  return stubFetcher(routes);
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** One archive artifact per named Skill, published through a v0.2.0 index. */
async function indexServing(names: readonly string[], options: { manifestNames?: Record<string, string> } = {}) {
  const routes: StubRoutes = {};
  const entries: Record<string, unknown>[] = [];
  for (const name of names) {
    const artifact = await tarGz([
      { name: "SKILL.md", body: skillManifest(options.manifestNames?.[name] ?? name) },
      { name: "notes.md", body: "notes" },
    ]);
    const url = `https://example.test/artifacts/${name}.tar.gz`;
    routes[url] = () => ({ status: 200, body: artifact });
    entries.push({ name, description: `${name} Skill`, type: "archive", url, digest: sha256(artifact) });
  }
  routes["https://example.test/skills/.well-known/agent-skills/index.json"] = () => ({
    status: 200,
    body: JSON.stringify({ $schema: SCHEMA_V2, skills: entries }),
  });
  return routes;
}

/**
 * Installs through the real preview, so each selection carries the fingerprint the preview reported.
 * A test that needs a *stale* fingerprint calls the service directly.
 */
async function install(
  service: RemoteSkillService,
  input: { callerUserId: string; agentId: string; source: string; names: string[] },
) {
  const preview = await service.resolve({
    callerUserId: input.callerUserId,
    agentId: input.agentId,
    source: input.source,
  });
  const selections = input.names.map((name) => {
    const candidate = preview.skills.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    return { name, fingerprint: candidate?.fingerprint ?? "absent" };
  });
  return service.install({
    callerUserId: input.callerUserId,
    agentId: input.agentId,
    source: input.source,
    selections,
  });
}

interface Fixture {
  service: RemoteSkillService;
  skills: SkillService;
  store: FakeSkillObjectStore;
}

function remoteService(routes: StubRoutes, options: { allowLoopback?: boolean } = {}): Fixture {
  const store = new FakeSkillObjectStore();
  const skills = h.serviceWith(store);
  const service = new RemoteSkillService({
    skills,
    fetcher: fetcherServing(routes),
    allowLoopback: options.allowLoopback === true,
  });
  return { service, skills, store };
}

/** A Skill row inserted directly, for the states a test needs without an upload per row. */
async function seedSkill(agentId: string, name: string): Promise<void> {
  await unit.database.insert(agentSkills).values({
    id: randomUUID(),
    agentId,
    name,
    description: "seeded",
    source: "web_upload",
    objectKey: `skills/accounts/${randomUUID()}/seeded.tar.gz`,
    archiveSha256: "a".repeat(64),
    archiveBytes: 1024,
    fileCount: 1,
  });
}

describe("RemoteSkillService.resolve", () => {
  it("lists what a source offers", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService(await indexServing(["demo", "other"]));

    const response = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test/skills" });
    expect(response.skills.map((candidate) => candidate.name)).toEqual(["demo", "other"]);
    expect(response.skills[0]).toMatchObject({
      name: "demo",
      description: "demo Skill",
      path: "demo",
      alreadyInstalled: false,
    });
    expect(response.source.kind).toBe("well_known");
  });

  it("marks a Skill the Agent already owns", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    await seedSkill(agentId, "demo");
    const { service } = remoteService(await indexServing(["demo", "other"]));

    const response = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test/skills" });
    expect(response.skills.map((candidate) => [candidate.name, candidate.alreadyInstalled])).toEqual([
      ["demo", true],
      ["other", false],
    ]);
  });

  it("lists a reserved name as unusable rather than hiding it", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService(await indexServing(["git"]));

    const response = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test/skills" });
    expect(response.skills[0]).toMatchObject({ name: "git", unavailableReason: "name_reserved" });
  });

  it("reports a source it cannot parse as invalid", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService({});
    expect(
      await code(service.resolve({ callerUserId: accountId, agentId, source: "{{EMAIL_6y3t2cwy}}:owner/repo.git" })),
    ).toBe(SKILL_ERROR_CODES.SOURCE_INVALID);
  });

  it("reports a source with no Skills", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService({
      "https://example.test/skills/.well-known/agent-skills/index.json": () => ({
        status: 200,
        body: JSON.stringify({ $schema: SCHEMA_V2, skills: [] }),
      }),
    });
    expect(
      await code(service.resolve({ callerUserId: accountId, agentId, source: "https://example.test/skills" })),
    ).toBe(SKILL_ERROR_CODES.SOURCE_NO_SKILLS);
  });

  it("keeps another Account's Agent indistinguishable from a missing one", async () => {
    const owner = await h.createUser();
    const foreign = await h.createUser();
    const agentId = await h.createAgent(owner);
    const { service } = remoteService(await indexServing(["demo"]));
    expect(await code(service.resolve({ callerUserId: foreign, agentId, source: "https://example.test/skills" }))).toBe(
      SKILL_ERROR_CODES.NOT_FOUND,
    );
  });
});

describe("RemoteSkillService.install", () => {
  it("installs the selected Skills and marks them as remote installs", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service, skills } = remoteService(await indexServing(["demo", "other", "unwanted"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo", "other"],
    });
    expect(response.results).toEqual([
      { name: "demo", status: "installed" },
      { name: "other", status: "installed" },
    ]);
    const listed = await skills.list(accountId, agentId);
    expect(listed.skills.map((skill) => skill.name).sort()).toEqual(["demo", "other"]);
    expect(listed.skills.every((skill) => skill.source === "url_install")).toBe(true);
    expect(listed.skills.every((skill) => skill.fileCount === 2)).toBe(true);
  });

  it("skips a name that already exists without touching the existing Skill", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    await h.upload(h.serviceWith(new FakeSkillObjectStore()), accountId, agentId, "demo");
    const { service, skills } = remoteService(await indexServing(["demo"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo"],
    });
    expect(response.results).toEqual([{ name: "demo", status: "skipped_name_conflict" }]);
    const listed = await skills.list(accountId, agentId);
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]?.revision).toBe(1);
    expect(listed.skills[0]?.source).toBe("web_upload");
  });

  it("installs a name once and skips its duplicate in the same request", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service, skills } = remoteService(await indexServing(["demo"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo", "DEMO"],
    });
    expect(response.results.map((result) => result.status)).toEqual(["installed", "skipped_name_conflict"]);
    expect((await skills.list(accountId, agentId)).skills).toHaveLength(1);
  });

  it("reports a selected name the source no longer offers", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService(await indexServing(["demo"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo", "ghost"],
    });
    expect(response.results).toEqual([
      { name: "demo", status: "installed" },
      { name: "ghost", status: "failed", errorCode: SKILL_ERROR_CODES.NOT_FOUND },
    ]);
  });

  it("fails an item without stopping the others", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const routes = await indexServing(["demo", "broken"]);
    // Serve the wrong bytes for one artifact: the digest then cannot match.
    routes["https://example.test/artifacts/broken.tar.gz"] = () => ({ status: 200, body: "not the artifact" });
    const { service, skills } = remoteService(routes);

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["broken", "demo"],
    });
    expect(response.results).toEqual([
      { name: "broken", status: "failed", errorCode: SKILL_ERROR_CODES.SOURCE_INVALID },
      { name: "demo", status: "installed" },
    ]);
    expect((await skills.list(accountId, agentId)).skills.map((skill) => skill.name)).toEqual(["demo"]);
  });

  it("fails a candidate that can never be packaged", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService(await indexServing(["git"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["git"],
    });
    expect(response.results).toEqual([{ name: "git", status: "failed", errorCode: SKILL_ERROR_CODES.NAME_RESERVED }]);
  });

  it("refuses an artifact whose manifest claims another name", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service } = remoteService(await indexServing(["demo"], { manifestNames: { demo: "elsewhere" } }));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo"],
    });
    expect(response.results).toEqual([
      { name: "demo", status: "failed", errorCode: SKILL_ERROR_CODES.MANIFEST_INVALID },
    ]);
  });

  it("fails an item when the Agent is already at its Skill limit", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    for (let index = 0; index < SKILL_MAX_PER_AGENT; index += 1) {
      await seedSkill(agentId, `seeded-${index}`);
    }
    const { service } = remoteService(await indexServing(["demo"]));

    const response = await install(service, {
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      names: ["demo"],
    });
    expect(response.results).toEqual([{ name: "demo", status: "failed", errorCode: SKILL_ERROR_CODES.LIMIT_REACHED }]);
  });

  it("lists only the named Skill when the source carries a filter", async () => {
    const fixture = await startGitRepositoryFixture({
      files: {
        "skills/demo/SKILL.md": skillManifest("demo"),
        "skills/other/SKILL.md": skillManifest("other"),
      },
    });
    try {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      const service = new RemoteSkillService({
        skills: h.serviceWith(new FakeSkillObjectStore()),
        allowLoopback: true,
      });
      // `owner/repo@skill` and `#ref@skill` name one Skill; the filter must be applied, not accepted
      // and ignored, or the preview would offer the whole repository.
      const filtered = await service.resolve({ callerUserId: accountId, agentId, source: `${fixture.url}#main@demo` });
      expect(filtered.skills.map((candidate) => candidate.name)).toEqual(["demo"]);
      expect(
        await code(service.resolve({ callerUserId: accountId, agentId, source: `${fixture.url}#main@missing` })),
      ).toBe(SKILL_ERROR_CODES.SOURCE_NO_SKILLS);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("reads a legacy entry once per request, so nothing can answer the comparison twice", async () => {
    /*
     * A fingerprint read followed by a separate materialization read is a check/use race: a publisher
     * that answers the two reads differently passes the comparison and has the second body installed.
     * One read per request is the property that removes it, and the request count is how it shows.
     */
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const reads: string[] = [];
    const routes: StubRoutes = {
      "https://example.test/.well-known/skills/index.json": () => ({
        status: 200,
        body: JSON.stringify({ skills: [{ name: "demo", description: "d", files: ["SKILL.md"] }] }),
      }),
      "https://example.test/.well-known/skills/demo/SKILL.md": () => {
        reads.push("SKILL.md");
        return { status: 200, body: skillManifest("demo") };
      },
    };
    const { service, skills } = remoteService(routes);

    const preview = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test" });
    expect(reads).toHaveLength(1);
    const response = await service.install({
      callerUserId: accountId,
      agentId,
      source: "https://example.test",
      selections: [{ name: "demo", fingerprint: preview.skills[0]?.fingerprint ?? "" }],
    });
    expect(response.results).toEqual([{ name: "demo", status: "installed" }]);
    // One read for the preview, one more for the install: never a comparison read plus a use read.
    expect(reads).toHaveLength(2);
    expect((await skills.list(accountId, agentId)).skills.map((skill) => skill.name)).toEqual(["demo"]);
  });

  it("refuses a legacy entry whose content changed but whose file list did not", async () => {
    /*
     * The v0.1 layout publishes no content hash, so a declared-file-list fingerprint would let a
     * publisher swap `SKILL.md` and still install as though nothing had moved. The preview reads the
     * files, so a content-only change is a revision conflict.
     */
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    let body = skillManifest("demo", "The original description");
    const routes: StubRoutes = {
      "https://example.test/.well-known/skills/index.json": () => ({
        status: 200,
        body: JSON.stringify({ skills: [{ name: "demo", description: "d", files: ["SKILL.md"] }] }),
      }),
      "https://example.test/.well-known/skills/demo/SKILL.md": () => ({ status: 200, body }),
    };
    const { service, skills } = remoteService(routes);

    const preview = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test" });
    const fingerprint = preview.skills[0]?.fingerprint ?? "";

    // Same file list, different bytes.
    body = skillManifest("demo", "A different description");
    const response = await service.install({
      callerUserId: accountId,
      agentId,
      source: "https://example.test",
      selections: [{ name: "demo", fingerprint }],
    });
    expect(response.results).toEqual([
      { name: "demo", status: "failed", errorCode: SKILL_ERROR_CODES.REVISION_CONFLICT },
    ]);
    expect((await skills.list(accountId, agentId)).skills).toEqual([]);
  });

  it("refuses a selection whose source changed since the preview", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const { service, skills } = remoteService(await indexServing(["demo"]));
    const preview = await service.resolve({ callerUserId: accountId, agentId, source: "https://example.test/skills" });

    const response = await service.install({
      callerUserId: accountId,
      agentId,
      source: "https://example.test/skills",
      selections: [{ name: "demo", fingerprint: "sha256:".concat("0".repeat(64)) }],
    });
    // The preview's fingerprint is a promise about content; a mismatch is a revision conflict, not an
    // install of bytes the user never saw.
    expect(response.results).toEqual([
      { name: "demo", status: "failed", errorCode: SKILL_ERROR_CODES.REVISION_CONFLICT },
    ]);
    expect((await skills.list(accountId, agentId)).skills).toEqual([]);
    expect(preview.skills[0]?.fingerprint).not.toBe("sha256:".concat("0".repeat(64)));
  });

  it("reports a candidate whose file paths a Skill archive cannot hold", async () => {
    // Git allows a backslash in a filename; a Skill archive does not, and the Computer's extractor
    // would refuse the result. The preview says so instead of installing something unusable.
    const fixture = await startGitRepositoryFixture({
      files: {
        "skills/demo/SKILL.md": skillManifest("demo"),
        "skills/demo/notes\\draft.md": "notes",
      },
    });
    try {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      const { service } = remoteService({}, { allowLoopback: true });
      const preview = await service.resolve({ callerUserId: accountId, agentId, source: fixture.url });
      expect(preview.skills[0]).toMatchObject({ name: "demo", unavailableReason: "path_invalid" });

      const response = await install(service, {
        callerUserId: accountId,
        agentId,
        source: fixture.url,
        names: ["demo"],
      });
      expect(response.results).toEqual([
        { name: "demo", status: "failed", errorCode: SKILL_ERROR_CODES.ARCHIVE_INVALID },
      ]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("releases the request's resources when the listing fails after the fetch", async () => {
    /*
     * A tree that names a blob the clone does not hold is the shape of a post-fetch failure: the clone
     * and the tree listing succeed, and discovery fails while reading the manifest. Four things were
     * acquired — the tunnel's listener, the staging directory, the snapshot's size monitor, and its
     * cached blobs — and every one of them has to be released on this path.
     *
     * The leak the monitor would cause is a live interval polling a directory that cleanup removed, so
     * the assertion is on active timers: raising a timer is what a leaked monitor looks like.
     */
    const fixture = await startGitRepositoryFixture({
      files: { "skills/demo/SKILL.md": skillManifest("demo") },
    });
    try {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      // The real clone and the real blob read; only the listing is replaced, with a blob id that
      // cannot exist, so the manifest read fails inside discovery.
      let measurements = 0;
      const counting = new RemoteSkillService({
        skills: h.serviceWith(new FakeSkillObjectStore()),
        allowLoopback: true,
        measureWorkspace: async () => {
          measurements += 1;
          return 1;
        },
        gitRunner: async (binary, args, options) => {
          if (args.includes("ls-tree")) {
            return { code: 0, stdout: Buffer.from(`100644 blob ${"0".repeat(40)}\tSKILL.md\0`) };
          }
          return runTrustedProcess(binary, args, options);
        },
      });

      expect(await code(counting.resolve({ callerUserId: accountId, agentId, source: fixture.url }))).toBe(
        SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
      );

      // The monitor runs every 500 ms; the failure must have stopped it. Sampling twice, two ticks
      // apart, is what distinguishes "stopped" from "slow".
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const settled = measurements;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(measurements).toBe(settled);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("installs a repository Skill whose raw bytes exceed the archive ceiling but pack under it", async () => {
    /*
     * Uploads allow 64 MiB unpacked and then enforce a 16 MiB canonical archive. A repository source
     * must match: this Skill is ~17 MiB of highly compressible content, so it packages far under the
     * archive ceiling and must install rather than being refused for its raw size.
     */
    const filler = "a".repeat(17 * 1024 * 1024);
    const fixture = await startGitRepositoryFixture({
      files: { "skills/big/SKILL.md": skillManifest("big"), "skills/big/data.txt": filler },
    });
    try {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      const { service, skills } = remoteService({}, { allowLoopback: true });
      const response = await install(service, {
        callerUserId: accountId,
        agentId,
        source: fixture.url,
        names: ["big"],
      });
      expect(response.results).toEqual([{ name: "big", status: "installed" }]);
      const listed = await skills.list(accountId, agentId);
      expect(listed.skills[0]).toMatchObject({ name: "big", fileCount: 2 });
      // The stored archive is the packed size, which is what the 16 MiB ceiling bounds.
      expect(listed.skills[0]?.archiveBytes).toBeLessThan(16 * 1024 * 1024);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("reads a skill out of a real repository", async () => {
    const fixture = await startGitRepositoryFixture({
      files: {
        "README.md": "# repository",
        "skills/demo/SKILL.md": skillManifest("demo", "From a repository"),
        "skills/demo/notes.md": "notes",
      },
    });
    try {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      const store = new FakeSkillObjectStore();
      const skills = h.serviceWith(store);
      const service = new RemoteSkillService({ skills, allowLoopback: true, logger: quietLogger() });

      const preview = await service.resolve({ callerUserId: accountId, agentId, source: fixture.url });
      expect(preview.source.kind).toBe("git");
      expect(preview.skills).toEqual([
        {
          name: "demo",
          description: "From a repository",
          path: "skills/demo",
          fileCount: 2,
          alreadyInstalled: false,
          // A repository source fingerprints the listing: every path with its blob id and mode.
          fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      ]);

      const response = await install(service, {
        callerUserId: accountId,
        agentId,
        source: fixture.url,
        names: ["demo"],
      });
      expect(response.results).toEqual([{ name: "demo", status: "installed" }]);
      const listed = await skills.list(accountId, agentId);
      expect(listed.skills[0]).toMatchObject({
        name: "demo",
        description: "From a repository",
        fileCount: 2,
        source: "url_install",
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

/** A logger that keeps the service's own debug/info out of the test output. */
function quietLogger(): ServiceLogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}
