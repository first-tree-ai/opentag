import { randomBytes, randomUUID } from "node:crypto";
import { SKILL_ERROR_CODES, SKILL_MAX_PER_AGENT } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentSkills, agents } from "../db/schema/index.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { buildStoredZip, skillManifest } from "./support/skill-archive-fixtures.js";
import { createSkillHarness, type SkillHarness } from "./support/skill-service-harness.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/** Domain behaviour of `SkillService`: ownership, CRUD, limits, and the per-surface views. */

let unit: UnitDatabase;
let h: SkillHarness;

beforeAll(async () => {
  unit = await createUnitDatabase();
  h = createSkillHarness(unit);
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

describe("SkillService", () => {
  it("makes another Account's or a deleted Agent indistinguishable from missing", async () => {
    const ownerAccount = await h.createUser();
    const foreignAccount = await h.createUser();
    const agentId = await h.createAgent(ownerAccount);
    const service = h.serviceWith(new FakeSkillObjectStore());

    await expect(service.list(foreignAccount, agentId)).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
    await expect(h.upload(service, foreignAccount, agentId, "nope")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });

    await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, agentId));
    await expect(service.list(ownerAccount, agentId)).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
  });

  it("round-trips upload, list, get, and openBundle", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);

    const detail = await h.upload(service, accountId, agentId, "round-trip", { files: { "lib/x.txt": "x" } });
    expect(detail).toMatchObject({ name: "round-trip", enabled: true, source: "web_upload", revision: 1 });
    expect(detail.files.map((file) => file.path)).toEqual(["SKILL.md", "lib/x.txt"]);

    expect(await service.list(accountId, agentId)).toMatchObject({ storage: "available" });
    expect((await service.get(accountId, agentId, detail.id)).id).toBe(detail.id);

    const bundle = await service.openBundle(accountId, agentId, detail.id);
    expect(bundle.sha256).toBe(detail.archiveSha256);
    expect(bundle.bytes).toBe(detail.archiveBytes);
    const body = Buffer.from(await new Response(bundle.stream).arrayBuffer());
    expect(h.sha256(body)).toBe(detail.archiveSha256);
    expect(store.keys()).toHaveLength(1);
  });

  it("rejects a declared sha256 that does not match the received bytes", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const service = h.serviceWith(new FakeSkillObjectStore());
    const bytes = await h.archive("mismatch");
    await expect(
      service.upload(accountId, agentId, {
        bytes,
        format: "tar.gz",
        declaredSha256: h.sha256(new TextEncoder().encode("other")),
        replace: false,
        source: "web_upload",
      }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.HASH_MISMATCH });
  });

  it("reports a name conflict and replaces only with the replace flag", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);

    const first = await h.upload(service, accountId, agentId, "same-name");
    await expect(h.upload(service, accountId, agentId, "same-name", { files: { "a.txt": "a" } })).rejects.toMatchObject(
      {
        code: SKILL_ERROR_CODES.NAME_CONFLICT,
      },
    );

    const replaced = await h.upload(service, accountId, agentId, "same-name", {
      files: { "b.txt": "b" },
      replace: true,
    });
    expect(replaced.id).toBe(first.id);
    expect(replaced.revision).toBe(first.revision + 1);
    expect(replaced.archiveSha256).not.toBe(first.archiveSha256);
    expect(store.keys()).toHaveLength(1);
    const bundle = await service.openBundle(accountId, agentId, replaced.id);
    expect(bundle.sha256).toBe(replaced.archiveSha256);
  });

  it("rejects a canonical archive that grows past the size limit before storing anything", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);
    // A stored zip just under the input limit re-packs a few KB larger because tar framing and gzip
    // overhead exceed zip's; the incompressible payload keeps gzip from shrinking it back.
    const nearLimit = buildStoredZip([
      { name: "SKILL.md", body: skillManifest("big-skill") },
      { name: "data.bin", body: randomBytes(16_776_000) },
    ]);
    await expect(
      service.upload(accountId, agentId, {
        bytes: nearLimit,
        format: "zip",
        declaredSha256: h.sha256(nearLimit),
        replace: false,
        source: "web_upload",
      }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE, statusCode: 413 });
    // The typed rejection lands before storage: no object was written and no row exists.
    expect(store.puts).toBe(0);
    expect((await service.list(accountId, agentId)).skills).toEqual([]);
  });

  it("enforces the per-Agent limit", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const max = SKILL_MAX_PER_AGENT;
    for (let index = 0; index < max; index += 1) {
      await unit.database.insert(agentSkills).values({
        agentId,
        name: `skill-${index}`,
        description: "seeded",
        source: "web_upload",
        objectKey: `skills/accounts/${accountId}/agents/${agentId}/skills/${randomUUID()}/${"a".repeat(64)}.tar.gz`,
        archiveSha256: "a".repeat(64),
        archiveBytes: 1,
        fileCount: 1,
      });
    }
    const service = h.serviceWith(new FakeSkillObjectStore());
    await expect(h.upload(service, accountId, agentId, "one-too-many")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.LIMIT_REACHED,
    });
  });

  it("reflects enable and disable in the computer manifest and requires the bound computer", async () => {
    const accountId = await h.createUser();
    const boundComputer = await h.createComputer(accountId);
    const otherComputer = await h.createComputer(accountId);
    const agentId = await h.createAgent(accountId, boundComputer);
    const service = h.serviceWith(new FakeSkillObjectStore());

    const detail = await h.upload(service, accountId, agentId, "manifest-skill");
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toHaveLength(1);

    await service.setEnabled(accountId, agentId, detail.id, false);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toEqual([]);
    // A disabled Skill is a hard stop on the Computer surface, not just absent from the manifest.
    await expect(service.openBundleForComputer(boundComputer, agentId, detail.id)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
    await service.setEnabled(accountId, agentId, detail.id, true);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills[0]).toMatchObject({
      id: detail.id,
      name: "manifest-skill",
    });

    await expect(service.manifestForComputer(otherComputer, agentId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
    const bundle = await service.openBundleForComputer(boundComputer, agentId, detail.id);
    expect(bundle.bytes).toBe(detail.archiveBytes);
  });

  it("tags agent-surface uploads and keeps sibling Agents isolated", async () => {
    const accountId = await h.createUser();
    const first = await h.createAgent(accountId);
    const sibling = await h.createAgent(accountId);
    const service = h.serviceWith(new FakeSkillObjectStore());

    const bytes = await h.archive("agent-made");
    const detail = await service.uploadForAgent(first, {
      bytes,
      format: "tar.gz",
      declaredSha256: h.sha256(bytes),
      replace: false,
    });
    expect(detail.source).toBe("agent_upload");
    expect((await service.listForAgent(first)).skills.map((skill) => skill.name)).toEqual(["agent-made"]);
    expect((await service.listForAgent(sibling)).skills).toEqual([]);
    await expect(service.openBundleForAgent(sibling, "agent-made")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
    const bundle = await service.openBundleForAgent(first, "agent-made");
    expect(bundle.sha256).toBe(detail.archiveSha256);
  });

  it("degrades without storage while row operations keep working", async () => {
    const accountId = await h.createUser();
    const boundComputer = await h.createComputer(accountId);
    const agentId = await h.createAgent(accountId, boundComputer);
    const service = h.serviceWith();

    await expect(h.upload(service, accountId, agentId, "no-store")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });

    await unit.database.insert(agentSkills).values({
      agentId,
      name: "row-only",
      description: "seeded",
      source: "cli_upload",
      objectKey: `skills/accounts/${accountId}/agents/${agentId}/skills/${randomUUID()}/${"b".repeat(64)}.tar.gz`,
      archiveSha256: "b".repeat(64),
      archiveBytes: 1,
      fileCount: 1,
    });
    expect(await service.list(accountId, agentId)).toMatchObject({ storage: "unavailable" });
    expect((await service.listForAgent(agentId)).skills).toHaveLength(1);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toHaveLength(1);

    const [row] = await service.list(accountId, agentId).then((response) => response.skills);
    expect(row).toBeDefined();
    const skillId = row?.id as string;
    expect((await service.get(accountId, agentId, skillId)).name).toBe("row-only");
    await expect(service.openBundle(accountId, agentId, skillId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    await expect(service.openBundleForComputer(boundComputer, agentId, skillId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    await expect(service.openBundleForAgent(agentId, "row-only")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });

    expect((await service.setEnabled(accountId, agentId, skillId, false)).enabled).toBe(false);
    await service.remove(accountId, agentId, skillId);
    expect((await service.list(accountId, agentId)).skills).toEqual([]);
  });
});
