import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as browserSurface from "../browser.js";
import {
  AgentSkillAssignmentRequestSchema,
  AgentSkillsResponseSchema,
  agentSkillsPath,
  canonicalizeSkillManifest,
  computeAgentSkillsDigest,
  computeSkillDigest,
  EMPTY_AGENT_SKILLS_DIGEST,
  ListSkillsResponseSchema,
  RuntimeSkillsManifestSchema,
  runtimeSessionSkillsPath,
  runtimeSkillArchivePath,
  runtimeSkillsPath,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_MD_MAX_BYTES,
  SKILL_NAME_PATTERN,
  SKILL_UNPACKED_MAX_BYTES,
  SKILLS_PER_ACCOUNT_MAX,
  SkillDetailSchema,
  SkillListQuerySchema,
  type SkillManifest,
  SkillManifestSchema,
  SkillNameSchema,
  SkillUploadQuerySchema,
  skillAgentsPath,
  skillArchivePath,
  skillByNamePath,
  skillSkillMdPath,
} from "../index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: 1,
    name: "my-skill",
    files: [
      { path: "scripts/run.sh", sha256: sha("run"), size: 1400, mode: "0755" },
      { path: "SKILL.md", sha256: sha("skill"), size: 812, mode: "0644" },
    ],
    ...overrides,
  };
}

describe("skill name", () => {
  it("accepts lowercase names, digits and hyphens up to 64 characters", () => {
    for (const name of ["a", "my-skill", "skill2", "0-start", "a".repeat(64)]) {
      expect(SkillNameSchema.parse(name)).toBe(name);
      expect(SKILL_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it("rejects uppercase, underscores, leading hyphens, empty names and 65 characters", () => {
    for (const name of ["", "My-Skill", "my_skill", "-skill", "a".repeat(65), "skill/one", "skill.md", "a b"]) {
      expect(SkillNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("skill constants", () => {
  it("pins the agreed limits", () => {
    expect(SKILL_ARCHIVE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(SKILL_UNPACKED_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(SKILL_MAX_FILES).toBe(200);
    expect(SKILL_MD_MAX_BYTES).toBe(256 * 1024);
    expect(SKILLS_PER_ACCOUNT_MAX).toBe(200);
  });
});

describe("skill manifest schema", () => {
  it("round-trips a valid manifest", () => {
    const value = manifest();
    expect(SkillManifestSchema.parse(value)).toEqual(value);
  });

  it("rejects empty file lists, more than the file limit, bad modes and bad digests", () => {
    expect(SkillManifestSchema.safeParse(manifest({ files: [] })).success).toBe(false);
    const files = Array.from({ length: SKILL_MAX_FILES + 1 }, (_, index) => ({
      path: `file-${index}`,
      sha256: sha(String(index)),
      size: 1,
      mode: "0644" as const,
    }));
    expect(SkillManifestSchema.safeParse(manifest({ files })).success).toBe(false);
    expect(SkillManifestSchema.safeParse(manifest({ files: files.slice(0, SKILL_MAX_FILES) })).success).toBe(true);
    expect(
      SkillManifestSchema.safeParse({ ...manifest(), files: [{ path: "a", sha256: sha("a"), size: 1, mode: "0600" }] })
        .success,
    ).toBe(false);
    expect(
      SkillManifestSchema.safeParse(manifest({ files: [{ path: "a", sha256: "ABC", size: 1, mode: "0644" }] })).success,
    ).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...manifest(), schemaVersion: 2 }).success).toBe(false);
  });
});

describe("skill digests", () => {
  it("canonicalizes files by byte order and fixed key order", () => {
    const canonical = canonicalizeSkillManifest(manifest());
    expect(canonical.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(JSON.stringify(canonical)).toBe(
      JSON.stringify({
        schemaVersion: 1,
        name: "my-skill",
        files: [
          { path: "SKILL.md", sha256: sha("skill"), size: 812, mode: "0644" },
          { path: "scripts/run.sh", sha256: sha("run"), size: 1400, mode: "0755" },
        ],
      }),
    );
  });

  it("is independent of file order and equals sha256 of the canonical JSON", () => {
    const forward = manifest();
    const reversed = manifest({ files: [...forward.files].reverse() });
    const digest = computeSkillDigest(forward);
    expect(digest).toBe(computeSkillDigest(reversed));
    expect(digest).toBe(sha(JSON.stringify(canonicalizeSkillManifest(forward))));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any file digest, size, mode, path or the name changes", () => {
    const base = computeSkillDigest(manifest());
    const [run, skill] = manifest().files as [SkillManifest["files"][number], SkillManifest["files"][number]];
    expect(computeSkillDigest(manifest({ name: "other" }))).not.toBe(base);
    expect(computeSkillDigest(manifest({ files: [{ ...run, sha256: sha("changed") }, skill] }))).not.toBe(base);
    expect(computeSkillDigest(manifest({ files: [{ ...run, size: 1 }, skill] }))).not.toBe(base);
    expect(computeSkillDigest(manifest({ files: [{ ...run, mode: "0644" }, skill] }))).not.toBe(base);
    expect(computeSkillDigest(manifest({ files: [{ ...run, path: "scripts/go.sh" }, skill] }))).not.toBe(base);
  });

  it("rejects an invalid manifest instead of hashing it", () => {
    expect(() => computeSkillDigest(manifest({ files: [] }))).toThrow();
  });

  it("returns the documented constant for an empty agent set", () => {
    expect(computeAgentSkillsDigest([])).toBe(EMPTY_AGENT_SKILLS_DIGEST);
    expect(EMPTY_AGENT_SKILLS_DIGEST).toBe(sha(""));
  });

  it("computes the agent digest from sorted name:digest lines regardless of input order", () => {
    const entries = [
      { name: "zeta", digest: sha("z") },
      { name: "alpha", digest: sha("a") },
    ];
    const expected = sha([`alpha:${sha("a")}`, `zeta:${sha("z")}`].join("\n"));
    expect(computeAgentSkillsDigest(entries)).toBe(expected);
    expect(computeAgentSkillsDigest([...entries].reverse())).toBe(expected);
    expect(computeAgentSkillsDigest([entries[0] as { name: string; digest: string }])).not.toBe(expected);
  });
});

describe("skill API schemas", () => {
  it("defaults and bounds the list query", () => {
    expect(SkillListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(SkillListQuerySchema.parse({ limit: "10", cursor: "my-skill" })).toEqual({ limit: 10, cursor: "my-skill" });
    expect(SkillListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(SkillListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(SkillListQuerySchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("defaults the upload conflict policy to fail", () => {
    expect(SkillUploadQuerySchema.parse({})).toEqual({ onConflict: "fail" });
    expect(SkillUploadQuerySchema.parse({ onConflict: "replace" })).toEqual({ onConflict: "replace" });
    expect(SkillUploadQuerySchema.safeParse({ onConflict: "merge" }).success).toBe(false);
  });

  it("requires unique, valid skill names in an assignment request and caps the count", () => {
    expect(AgentSkillAssignmentRequestSchema.parse({ skillNames: [] })).toEqual({ skillNames: [] });
    expect(AgentSkillAssignmentRequestSchema.parse({ skillNames: ["a", "b"] })).toEqual({ skillNames: ["a", "b"] });
    expect(AgentSkillAssignmentRequestSchema.safeParse({ skillNames: ["a", "a"] }).success).toBe(false);
    expect(AgentSkillAssignmentRequestSchema.safeParse({ skillNames: ["Bad"] }).success).toBe(false);
    const tooMany = Array.from({ length: SKILLS_PER_ACCOUNT_MAX + 1 }, (_, index) => `skill-${index}`);
    expect(AgentSkillAssignmentRequestSchema.safeParse({ skillNames: tooMany }).success).toBe(false);
  });

  it("round-trips summaries, details, lists and runtime manifests", () => {
    const summary = {
      name: "my-skill",
      description: "Runs things",
      digest: computeSkillDigest(manifest()),
      archiveSha256: sha("zip"),
      archiveBytes: 2048,
      fileCount: 2,
      totalBytes: 2212,
      agentCount: 1,
      updatedAt: "2026-09-11T10:00:00.000Z",
      updatedBy: { kind: "user" as const, id: "user-1" },
    };
    const detail = { ...summary, manifest: manifest() };
    expect(SkillDetailSchema.parse(detail)).toEqual(detail);
    expect(ListSkillsResponseSchema.parse({ skills: [summary], nextCursor: null })).toEqual({
      skills: [summary],
      nextCursor: null,
    });
    expect(ListSkillsResponseSchema.safeParse({ skills: [summary], nextCursor: "" }).success).toBe(false);
    expect(SkillDetailSchema.safeParse({ ...detail, description: "" }).success).toBe(false);
    expect(SkillDetailSchema.safeParse({ ...detail, updatedBy: { kind: "bot", id: "x" } }).success).toBe(false);
    const agentSkills = { agentId: "agent-1", digest: EMPTY_AGENT_SKILLS_DIGEST, skills: [] };
    expect(AgentSkillsResponseSchema.parse(agentSkills)).toEqual(agentSkills);
    const runtime = {
      agents: [
        {
          agentId: "agent-1",
          digest: computeAgentSkillsDigest([{ name: "my-skill", digest: summary.digest }]),
          skills: [
            {
              name: "my-skill",
              digest: summary.digest,
              archiveSha256: sha("zip"),
              archiveBytes: 2048,
              manifest: manifest(),
            },
          ],
        },
      ],
    };
    expect(RuntimeSkillsManifestSchema.parse(runtime)).toEqual(runtime);
  });
});

describe("skill HTTP paths", () => {
  it("builds account, agent and runtime skill paths with encoded segments", () => {
    expect(skillByNamePath("my-skill")).toBe("/api/v1/skills/my-skill");
    expect(skillSkillMdPath("my-skill")).toBe("/api/v1/skills/my-skill/skill-md");
    expect(skillArchivePath("my-skill")).toBe("/api/v1/skills/my-skill/archive");
    expect(skillAgentsPath("my-skill")).toBe("/api/v1/skills/my-skill/agents");
    expect(agentSkillsPath("agent/1")).toBe("/api/v1/agents/agent%2F1/skills");
    expect(runtimeSkillsPath()).toBe("/api/v1/runtime/skills");
    expect(runtimeSkillsPath("agent 1")).toBe("/api/v1/runtime/skills?agentId=agent+1");
    expect(runtimeSkillArchivePath("my-skill")).toBe("/api/v1/runtime/skills/my-skill/archive");
    expect(runtimeSessionSkillsPath("session-1")).toBe("/api/v1/runtime/sessions/session-1/skills");
  });
});

describe("browser entrypoint", () => {
  it("exposes the skill schemas and paths without the Node-only digest helpers", () => {
    expect(browserSurface.SkillManifestSchema).toBe(SkillManifestSchema);
    expect(browserSurface.skillArchivePath).toBe(skillArchivePath);
    expect(browserSurface.SKILL_ARCHIVE_MAX_BYTES).toBe(SKILL_ARCHIVE_MAX_BYTES);
    expect("computeSkillDigest" in browserSurface).toBe(false);
  });
});
