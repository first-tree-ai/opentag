import { describe, expect, it } from "vitest";
import {
  agentSkillBundlePath,
  agentSkillPath,
  agentSkillsPath,
  computerAgentSkillBundlePath,
  computerAgentSkillsPath,
  runtimeSkillBundlePath,
} from "../http-paths.js";
import {
  isReservedSkillName,
  ListAgentSkillsResponseSchema,
  parseSkillManifest,
  RuntimeSkillManifestEntrySchema,
  RuntimeSkillManifestSchema,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_ERROR_CODE_METADATA,
  SKILL_ERROR_CODES,
  SKILL_FORMAT_HEADER,
  SKILL_MANIFEST_FILE,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_MARKER_FILE,
  SKILL_MAX_PER_AGENT,
  SKILL_REPLACE_HEADER,
  SKILL_RESERVED_NAMES,
  SKILL_SHA256_HEADER,
  SKILL_UNPACKED_MAX_BYTES,
  SKILL_UPLOAD_CONTENT_TYPE,
  SkillDetailSchema,
  SkillFileEntrySchema,
  SkillInstallMarkerSchema,
  SkillManifestSchema,
  SkillNameSchema,
  SkillSchema,
  UpdateSkillRequestSchema,
} from "../skill.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SKILL_ID = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);

function validSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: SKILL_ID,
    agentId: AGENT_ID,
    name: "demo",
    description: "A demo skill",
    enabled: true,
    source: "web_upload",
    archiveSha256: SHA,
    archiveBytes: 1024,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("skill name rules", () => {
  it("accepts lowercase letters, numbers, and single hyphens", () => {
    for (const name of ["a", "demo", "my-skill", "a1-b2-c3", "a".repeat(64)]) {
      expect(SkillNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects uppercase, hyphen placement, over-long, and empty names", () => {
    for (const name of ["MySkill", "-skill", "pdf-", "a--b", "a".repeat(65), "", "skill_name", "skill name"]) {
      expect(SkillNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("rejects every reserved name and accepts an ordinary one", () => {
    for (const name of SKILL_RESERVED_NAMES) {
      expect(isReservedSkillName(name)).toBe(true);
    }
    expect(isReservedSkillName("my-skill")).toBe(false);
    expect(SKILL_RESERVED_NAMES.length).toBe(10);
  });
});

describe("skill constants", () => {
  it("exposes the documented values", () => {
    expect(SKILL_ARCHIVE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(SKILL_UNPACKED_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(SKILL_MANIFEST_MAX_BYTES).toBe(256 * 1024);
    expect(SKILL_DESCRIPTION_MAX_LENGTH).toBe(1024);
    expect(SKILL_MAX_PER_AGENT).toBe(64);
    expect(SKILL_MANIFEST_FILE).toBe("SKILL.md");
    expect(SKILL_MARKER_FILE).toBe(".opentag-skill.json");
    expect(SKILL_SHA256_HEADER).toBe("x-opentag-skill-sha256");
    expect(SKILL_FORMAT_HEADER).toBe("x-opentag-skill-format");
    expect(SKILL_REPLACE_HEADER).toBe("x-opentag-skill-replace");
    expect(SKILL_UPLOAD_CONTENT_TYPE).toBe("application/octet-stream");
  });
});

describe("parseSkillManifest", () => {
  function expectManifest(markdown: string, manifest: { name: string; description: string }) {
    const result = parseSkillManifest(markdown);
    expect(result).toEqual({ ok: true, manifest });
  }

  function expectReason(markdown: string, fragment: string) {
    const result = parseSkillManifest(markdown);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(fragment);
  }

  it("reads a plain scalar manifest", () => {
    expectManifest("---\nname: demo\ndescription: A demo skill\n---\n# Demo\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("reads single-quoted scalars and unescapes doubled quotes", () => {
    expectManifest("---\nname: demo\ndescription: 'It''s fine'\n---\n", {
      name: "demo",
      description: "It's fine",
    });
  });

  it("reads double-quoted scalars and their escapes", () => {
    expectManifest('---\nname: demo\ndescription: "line\\nnext"\n---\n', {
      name: "demo",
      description: "line\nnext",
    });
  });

  it("folds a `>` block scalar", () => {
    expectManifest("---\nname: demo\ndescription: >\n  Folded\n  text\n---\n", {
      name: "demo",
      description: "Folded text",
    });
  });

  it("keeps paragraph breaks in a folded block scalar", () => {
    expectManifest("---\nname: demo\ndescription: >\n  Para one\n\n  Para two\n---\n", {
      name: "demo",
      description: "Para one\nPara two",
    });
  });

  it("keeps newlines in a literal `|` block scalar", () => {
    expectManifest("---\nname: demo\ndescription: |\n  Line one\n  Line two\n---\n", {
      name: "demo",
      description: "Line one\nLine two",
    });
  });

  it("trims folded, literal, and keep-chomped block descriptions", () => {
    const markdowns = [
      "---\nname: demo\ndescription: >\n  Folded\n  text\n---\n",
      "---\nname: demo\ndescription: |\n  Line one\n  Line two\n---\n",
      "---\nname: demo\ndescription: >+\n  Folded\n  text\n\n---\n",
    ];
    for (const markdown of markdowns) {
      const result = parseSkillManifest(markdown);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.description).toBe(result.manifest.description.trim());
        expect(result.manifest.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("honors the strip and keep chomping indicators", () => {
    expectManifest("---\nname: demo\ndescription: >-\n  Folded\n  text\n---\n", {
      name: "demo",
      description: "Folded text",
    });
    expectManifest("---\nname: demo\ndescription: >+\n  Folded\n  text\n\n---\n", {
      name: "demo",
      description: "Folded text",
    });
    expectManifest("---\nname: demo\ndescription: |+\n  Line one\n\n---\n", {
      name: "demo",
      description: "Line one",
    });
  });

  it("reads CRLF line endings", () => {
    expectManifest("---\r\nname: demo\r\ndescription: A demo skill\r\n---\r\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("ignores unknown top-level keys", () => {
    expectManifest("---\nname: demo\nlicense: MIT\nallowed-tools: [read]\ndescription: A demo skill\n---\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("ignores nested maps and block sequences under unknown keys", () => {
    const markdown = [
      "---",
      "name: demo",
      "description: A demo skill",
      "license: MIT",
      "metadata:",
      "  author: x",
      "  requires:",
      "    - y",
      "allowed-tools:",
      "  - read",
      "  - write",
      "---",
    ].join("\n");
    expectManifest(markdown, { name: "demo", description: "A demo skill" });
  });

  it("accepts OpenTag's own context-tree-read manifest shape", () => {
    const markdown = [
      "---",
      "name: context-tree-read",
      "description: Read a node, subtree, or search result from Context Tree.",
      "metadata:",
      "  author: x",
      "  requires:",
      "    - y",
      "allowed-tools:",
      "- read",
      "---",
    ].join("\n");
    expectManifest(markdown, {
      name: "context-tree-read",
      description: "Read a node, subtree, or search result from Context Tree.",
    });
  });

  it("folds a multi-line plain description", () => {
    expectManifest("---\nname: demo\ndescription: This is\n  a long description\n  over lines\n---\n", {
      name: "demo",
      description: "This is a long description over lines",
    });
  });

  it("keeps paragraph breaks in a multi-line plain description", () => {
    expectManifest("---\nname: demo\ndescription:\n  Para one\n\n  Para two\n---\n", {
      name: "demo",
      description: "Para one\nPara two",
    });
  });

  it("rejects an indented line with no preceding key", () => {
    expectReason("---\n  orphan: x\n---\n", "indented line with no preceding key");
  });

  it("rejects a missing frontmatter block", () => {
    expectReason("# Demo\nname: demo\n", "missing its frontmatter");
  });

  it("rejects unterminated frontmatter", () => {
    expectReason("---\nname: demo\ndescription: A demo skill\n", "unterminated");
  });

  it("rejects a manifest missing name or description", () => {
    expectReason("---\ndescription: A demo skill\n---\n", "missing the name field");
    expectReason("---\nname: demo\n---\n", "missing the description field");
  });

  it("rejects an invalid name", () => {
    expectReason("---\nname: Demo\ndescription: A demo skill\n---\n", "Skill name must be 1 to 64 characters");
  });

  it("rejects an over-long or empty description", () => {
    expectReason(`---\nname: demo\ndescription: ${"x".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)}\n---\n`, "Too big");
    expectReason("---\nname: demo\ndescription: ''\n---\n", "Too small");
  });

  it("rejects a whitespace-only description", () => {
    expectReason("---\nname: demo\ndescription: '   '\n---\n", "Too small");
    expectReason("---\nname: demo\ndescription: >\n   \n---\n", "Too small");
  });

  it("rejects input larger than the manifest limit before parsing", () => {
    const oversize = `---\nname: demo\ndescription: ${"x".repeat(SKILL_MANIFEST_MAX_BYTES)}\n---\n`;
    expectReason(oversize, "exceeds");
  });

  it("never throws for malformed input", () => {
    for (const input of ["", "---", "---\n---", "---\nname: |\n", "---\n\u0000: x\n---\n", "---\nname: demo\n"]) {
      expect(() => parseSkillManifest(input)).not.toThrow();
    }
  });

  it("exposes a manifest schema that matches the parsed result", () => {
    const result = parseSkillManifest("---\nname: demo\ndescription: A demo skill\n---\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(SkillManifestSchema.safeParse(result.manifest).success).toBe(true);
  });
});

describe("skill resource schemas", () => {
  it("accepts a well-formed skill", () => {
    const parsed = SkillSchema.parse(validSkill());
    expect(parsed.id).toBe(SKILL_ID);
    expect(parsed.source).toBe("web_upload");
  });

  it("rejects a bad sha, revision 0, and an over-limit archive", () => {
    expect(SkillSchema.safeParse(validSkill({ archiveSha256: "XYZ" })).success).toBe(false);
    expect(SkillSchema.safeParse(validSkill({ archiveSha256: "A".repeat(64) })).success).toBe(false);
    expect(SkillSchema.safeParse(validSkill({ revision: 0 })).success).toBe(false);
    expect(SkillSchema.safeParse(validSkill({ archiveBytes: SKILL_ARCHIVE_MAX_BYTES + 1 })).success).toBe(false);
    expect(SkillSchema.safeParse(validSkill({ archiveBytes: 0 })).success).toBe(false);
  });

  it("rejects unknown keys on a skill", () => {
    expect(SkillSchema.safeParse(validSkill({ unexpected: true })).success).toBe(false);
  });

  it("round-trips a skill detail", () => {
    const detail = { ...validSkill(), files: [{ path: "SKILL.md", bytes: 42 }], filesTruncated: false };
    expect(SkillDetailSchema.safeParse(detail).success).toBe(true);
    expect(SkillFileEntrySchema.safeParse({ path: "SKILL.md", bytes: 0 }).success).toBe(true);
    expect(SkillFileEntrySchema.safeParse({ path: "", bytes: 0 }).success).toBe(false);
    expect(SkillFileEntrySchema.safeParse({ path: "SKILL.md", bytes: -1 }).success).toBe(false);
  });

  it("round-trips a list response", () => {
    const response = { skills: [validSkill()], storage: "available" };
    expect(ListAgentSkillsResponseSchema.safeParse(response).success).toBe(true);
    expect(ListAgentSkillsResponseSchema.safeParse({ ...response, storage: "gone" }).success).toBe(false);
  });

  it("round-trips the runtime manifest and bounds it per agent", () => {
    const entry = { id: SKILL_ID, name: "demo", archiveSha256: SHA, archiveBytes: 1024 };
    expect(RuntimeSkillManifestEntrySchema.safeParse(entry).success).toBe(true);
    expect(RuntimeSkillManifestSchema.safeParse({ skills: [entry] }).success).toBe(true);
    const tooMany = Array.from({ length: SKILL_MAX_PER_AGENT + 1 }, () => entry);
    expect(RuntimeSkillManifestSchema.safeParse({ skills: tooMany }).success).toBe(false);
  });

  it("round-trips the install marker", () => {
    expect(SkillInstallMarkerSchema.safeParse({ skillId: SKILL_ID, archiveSha256: SHA }).success).toBe(true);
    expect(SkillInstallMarkerSchema.safeParse({ skillId: "not-a-uuid", archiveSha256: SHA }).success).toBe(false);
  });

  it("rejects unknown keys on the update request", () => {
    expect(UpdateSkillRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateSkillRequestSchema.safeParse({ enabled: false, name: "demo" }).success).toBe(false);
    expect(UpdateSkillRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("skill error codes", () => {
  it("maps every code to metadata and every metadata key to a known code", () => {
    const codes = Object.values(SKILL_ERROR_CODES);
    expect(Object.keys(SKILL_ERROR_CODE_METADATA).sort()).toEqual([...codes].sort());
    for (const metadata of Object.values(SKILL_ERROR_CODE_METADATA)) {
      expect(metadata.statusCode).toBeGreaterThanOrEqual(400);
      expect(["credential", "deterministic", "validation", "transient"]).toContain(metadata.category);
    }
    expect(SKILL_ERROR_CODE_METADATA[SKILL_ERROR_CODES.STORAGE_UNAVAILABLE]).toEqual({
      category: "transient",
      statusCode: 503,
    });
  });
});

describe("skill HTTP path builders", () => {
  it("builds the account-scoped paths", () => {
    expect(agentSkillsPath(AGENT_ID)).toBe(`/api/v1/agents/${AGENT_ID}/skills`);
    expect(agentSkillPath(AGENT_ID, SKILL_ID)).toBe(`/api/v1/agents/${AGENT_ID}/skills/${SKILL_ID}`);
    expect(agentSkillBundlePath(AGENT_ID, SKILL_ID)).toBe(`/api/v1/agents/${AGENT_ID}/skills/${SKILL_ID}/bundle`);
  });

  it("builds the computer-scoped paths", () => {
    expect(computerAgentSkillsPath(AGENT_ID)).toBe(`/api/v1/computer/agents/${AGENT_ID}/skills`);
    expect(computerAgentSkillBundlePath(AGENT_ID, SKILL_ID)).toBe(
      `/api/v1/computer/agents/${AGENT_ID}/skills/${SKILL_ID}/bundle`,
    );
  });

  it("builds the session-proof runtime bundle path", () => {
    expect(runtimeSkillBundlePath("demo")).toBe("/api/v1/runtime/skills/demo/bundle");
  });

  it("percent-encodes every argument", () => {
    expect(agentSkillsPath("agent id")).toBe("/api/v1/agents/agent%20id/skills");
    expect(agentSkillPath(AGENT_ID, "skill/1")).toBe(`/api/v1/agents/${AGENT_ID}/skills/skill%2F1`);
    expect(agentSkillBundlePath("agent/id", "skill/1")).toBe("/api/v1/agents/agent%2Fid/skills/skill%2F1/bundle");
    expect(computerAgentSkillBundlePath("agent id", "skill/1")).toBe(
      "/api/v1/computer/agents/agent%20id/skills/skill%2F1/bundle",
    );
    expect(runtimeSkillBundlePath("my/skill")).toBe("/api/v1/runtime/skills/my%2Fskill/bundle");
  });
});
