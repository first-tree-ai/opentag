import { describe, expect, it } from "vitest";
import { SKILL_MAX_PER_AGENT } from "../skill.js";
import {
  InstallRemoteSkillsRequestSchema,
  InstallRemoteSkillsResponseSchema,
  parseSkillSource,
  RemoteSkillCandidateSchema,
  RemoteSkillInstallResultSchema,
  RemoteSkillSourceSchema,
  ResolveRemoteSkillsRequestSchema,
  ResolveRemoteSkillsResponseSchema,
  SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_FILES,
  SKILL_SOURCE_GIT_TIMEOUT_MS,
  SKILL_SOURCE_HTTP_TIMEOUT_MS,
  SKILL_SOURCE_INPUT_MAX_LENGTH,
  SKILL_SOURCE_MAX_CANDIDATES,
  SKILL_SOURCE_SNAPSHOT_MAX_BYTES,
} from "../skill-source.js";

/**
 * The accepted source forms, as a table.
 *
 * Every case names the spec scenario it pins: `specs/skills/remote-source/spec.md` scenarios for the
 * accepted forms, the hosted-artifact and subpath rules, and the refusals. A `parse` case asserts the
 * normalized descriptor; a `reject` case asserts the rejection reason.
 */

interface ParseCase {
  name: string;
  input: string;
  expected: Record<string, unknown>;
}

const PARSE_CASES: readonly ParseCase[] = [
  {
    name: "GitHub shorthand resolves to the repository root",
    input: "vercel-labs/agent-skills",
    expected: { kind: "github", url: "https://github.com/vercel-labs/agent-skills.git" },
  },
  {
    name: "GitHub shorthand with a trailing slash",
    input: "vercel-labs/agent-skills/",
    expected: { kind: "github", url: "https://github.com/vercel-labs/agent-skills.git" },
  },
  {
    name: "shorthand carries a subpath",
    input: "vercel-labs/agent-skills/skills/web-design-guidelines",
    expected: {
      kind: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
      subpath: "skills/web-design-guidelines",
    },
  },
  {
    name: "shorthand carries a Skill filter",
    input: "vercel-labs/agent-skills@web-design-guidelines",
    expected: {
      kind: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
      skillFilter: "web-design-guidelines",
    },
  },
  {
    name: "the github: prefix is shorthand, not a scheme",
    input: "github:vercel-labs/agent-skills",
    expected: { kind: "github", url: "https://github.com/vercel-labs/agent-skills.git" },
  },
  {
    name: "the gitlab: prefix resolves against gitlab.com",
    input: "gitlab:group/subgroup/repo",
    expected: { kind: "gitlab", url: "https://gitlab.com/group/subgroup/repo.git" },
  },
  {
    name: "a GitHub repository URL keeps the full URL path",
    input: "https://github.com/vercel-labs/agent-skills",
    expected: { kind: "github", url: "https://github.com/vercel-labs/agent-skills.git" },
  },
  {
    name: "a GitHub tree URL without a path yields a ref",
    input: "https://github.com/vercel-labs/agent-skills/tree/main",
    expected: { kind: "github", url: "https://github.com/vercel-labs/agent-skills.git", ref: "main" },
  },
  {
    name: "a GitHub tree URL yields a ref and a subpath",
    input: "https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines",
    expected: {
      kind: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
      ref: "main",
      subpath: "skills/web-design-guidelines",
    },
  },
  {
    name: "a GitLab instance is not limited to gitlab.com",
    input: "https://gitlab.example.com/group/subgroup/repo/-/tree/main/skills/foo",
    expected: {
      kind: "gitlab",
      url: "https://gitlab.example.com/group/subgroup/repo.git",
      ref: "main",
      subpath: "skills/foo",
    },
  },
  {
    name: "a GitLab repository URL keeps its subgroups",
    input: "https://gitlab.com/group/subgroup/repo",
    expected: { kind: "gitlab", url: "https://gitlab.com/group/subgroup/repo.git" },
  },
  {
    name: "Azure Repos restores the ref and subpath from the query",
    input: "https://dev.azure.com/org/project/_git/repo?path=/skills/demo&version=GBmain",
    expected: {
      kind: "azure",
      url: "https://dev.azure.com/org/project/_git/repo",
      ref: "main",
      subpath: "skills/demo",
    },
  },
  {
    name: "Azure Repos accepts a tag version",
    input: "https://dev.azure.com/org/project/_git/repo?version=GTv1.2.0",
    expected: { kind: "azure", url: "https://dev.azure.com/org/project/_git/repo", ref: "v1.2.0" },
  },
  {
    name: "a raw file host is a direct download",
    input: "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md",
    expected: { kind: "download", url: "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md" },
  },
  {
    name: "a GitHub release asset is a direct download",
    input: "https://github.com/owner/repo/releases/download/v1/demo.tar.gz",
    expected: { kind: "download", url: "https://github.com/owner/repo/releases/download/v1/demo.tar.gz" },
  },
  {
    name: "a GitLab archive URL is a direct download",
    input: "https://gitlab.com/group/repo/-/archive/main/repo-main.tar.gz",
    expected: { kind: "download", url: "https://gitlab.com/group/repo/-/archive/main/repo-main.tar.gz" },
  },
  {
    name: "an ordinary host is well-known discovery first",
    input: "https://example.com/skills",
    expected: { kind: "well_known", url: "https://example.com/skills" },
  },
  {
    name: "a generic git URL is not well-known discovery",
    input: "https://git.example.com/acme/skills.git",
    expected: { kind: "git", url: "https://git.example.com/acme/skills.git" },
  },
  {
    name: "a bare repository URL without .git is a generic git source",
    input: "https://git.example.com/acme/skills",
    expected: { kind: "well_known", url: "https://git.example.com/acme/skills" },
  },
  {
    name: "a shorthand fragment is the ref",
    input: "owner/repo#release-2026",
    expected: { kind: "github", url: "https://github.com/owner/repo.git", ref: "release-2026" },
  },
  {
    name: "a percent-encoded shorthand fragment is decoded",
    input: "owner/repo#release%2D2026",
    expected: { kind: "github", url: "https://github.com/owner/repo.git", ref: "release-2026" },
  },
  {
    name: "a fragment carries both ref and Skill filter",
    input: "https://github.com/owner/repo#main@demo",
    expected: { kind: "github", url: "https://github.com/owner/repo.git", ref: "main", skillFilter: "demo" },
  },
  {
    name: "a fragment on a non-git URL is not a ref",
    input: "https://example.com/skills#section",
    expected: { kind: "well_known", url: "https://example.com/skills#section" },
  },
  {
    name: "a blob anchor is not a ref",
    input: "https://github.com/owner/repo/blob/main/README.md#L10",
    expected: { kind: "github", url: "https://github.com/owner/repo.git" },
  },
  {
    name: "a .git URL keeps http",
    input: "http://gitlab.example.com/group/repo.git",
    expected: { kind: "git", url: "http://gitlab.example.com/group/repo.git" },
  },
  {
    name: "surrounding whitespace is ignored",
    input: "  owner/repo  ",
    expected: { kind: "github", url: "https://github.com/owner/repo.git" },
  },
];

interface RejectCase {
  input: string;
  rejection: "empty" | "unsupported" | "unsafe_subpath";
}

const REJECT_CASES: readonly RejectCase[] = [
  { input: "", rejection: "empty" },
  { input: "   ", rejection: "empty" },
  { input: "./my-local-skills", rejection: "unsupported" },
  { input: "../my-local-skills", rejection: "unsupported" },
  { input: "/opt/skills/demo", rejection: "unsupported" },
  { input: "C:\\skills\\demo", rejection: "unsupported" },
  { input: "x@github.com:owner/repo.git", rejection: "unsupported" },
  { input: "ssh://git@host/owner/repo.git", rejection: "unsupported" },
  { input: "https://user:secret@github.com/owner/repo", rejection: "unsupported" },
  { input: "not a url", rejection: "unsupported" },
  { input: "file:///etc/passwd", rejection: "unsupported" },
  { input: "ftp://example.com/skills", rejection: "unsupported" },
  { input: "skills/../../etc", rejection: "unsafe_subpath" },
  { input: "https://github.com/owner/repo/tree/main/../../etc", rejection: "unsafe_subpath" },
];

describe("parseSkillSource", () => {
  it.each(PARSE_CASES)("parses: $name", ({ input, expected }) => {
    const result = parseSkillSource(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(RemoteSkillSourceSchema.parse(result.source)).toEqual(expected);
  });

  it.each(REJECT_CASES)("rejects $input as $rejection", ({ input, rejection }) => {
    expect(parseSkillSource(input)).toEqual({ ok: false, rejection });
  });

  it("never reports an unsafe subpath as an ordinary unknown source", () => {
    const result = parseSkillSource("https://github.com/owner/repo/tree/main/a/../../b");
    expect(result).toEqual({ ok: false, rejection: "unsafe_subpath" });
  });
});

describe("remote Skill source schemas", () => {
  it("bounds every kind and field", () => {
    expect(RemoteSkillSourceSchema.safeParse({ kind: "github", url: "https://example.com/x.git" }).success).toBe(true);
    expect(RemoteSkillSourceSchema.safeParse({ kind: "elsewhere", url: "https://example.com" }).success).toBe(false);
    expect(RemoteSkillSourceSchema.safeParse({ kind: "git", url: "" }).success).toBe(false);
    expect(RemoteSkillSourceSchema.safeParse({ kind: "git", url: "https://example.com", ref: "" }).success).toBe(false);
    expect(RemoteSkillSourceSchema.safeParse({ kind: "git", url: "https://example.com", unknown: true }).success).toBe(
      false,
    );
  });

  it("accepts a candidate and rejects unknown or invalid fields", () => {
    const candidate = {
      name: "demo",
      description: "A demo Skill",
      path: "skills/demo",
      fileCount: 3,
      bytes: 1024,
      alreadyInstalled: false,
      fingerprint: "sha256:".concat("a".repeat(64)),
    };
    expect(RemoteSkillCandidateSchema.safeParse(candidate).success).toBe(true);
    // The detail fields are optional: a well-known index knows neither until it downloads. The
    // fingerprint is not optional — it is how the install knows it is installing what was shown.
    expect(
      RemoteSkillCandidateSchema.safeParse({
        name: "demo",
        description: "",
        path: "demo",
        alreadyInstalled: false,
        fingerprint: "declared:".concat("b".repeat(64)),
      }).success,
    ).toBe(true);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, unexpected: 1 }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, name: "" }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, fileCount: -1 }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, alreadyInstalled: "yes" }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, unavailableReason: "nope" }).success).toBe(false);
    // The fingerprint is how the install knows it is installing what the preview showed.
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, fingerprint: undefined }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, fingerprint: "" }).success).toBe(false);
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, unavailableReason: "path_invalid" }).success).toBe(
      true,
    );
    expect(RemoteSkillCandidateSchema.safeParse({ ...candidate, unavailableReason: "manifest_invalid" }).success).toBe(
      true,
    );
  });

  it("bounds the resolve request and response", () => {
    expect(ResolveRemoteSkillsRequestSchema.parse({ source: "  owner/repo  " })).toEqual({ source: "owner/repo" });
    expect(ResolveRemoteSkillsRequestSchema.safeParse({ source: "" }).success).toBe(false);
    expect(
      ResolveRemoteSkillsRequestSchema.safeParse({ source: "a".repeat(SKILL_SOURCE_INPUT_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(ResolveRemoteSkillsRequestSchema.safeParse({ source: "owner/repo", extra: 1 }).success).toBe(false);
    const candidate = {
      name: "demo",
      description: "",
      path: "skills/demo",
      fileCount: 1,
      bytes: 1,
      alreadyInstalled: false,
      fingerprint: "sha256:".concat("c".repeat(64)),
    };
    expect(
      ResolveRemoteSkillsResponseSchema.safeParse({
        source: { kind: "github", url: "https://github.com/owner/repo.git" },
        skills: [candidate],
      }).success,
    ).toBe(true);
    expect(
      ResolveRemoteSkillsResponseSchema.safeParse({
        source: { kind: "github", url: "https://github.com/owner/repo.git" },
        skills: Array.from({ length: SKILL_SOURCE_MAX_CANDIDATES + 1 }, () => candidate),
      }).success,
    ).toBe(false);
  });

  it("bounds the install request and requires at least one selection", () => {
    const selection = { name: "demo", fingerprint: "sha256:".concat("a".repeat(64)) };
    expect(InstallRemoteSkillsRequestSchema.safeParse({ source: "owner/repo", selections: [selection] }).success).toBe(
      true,
    );
    expect(InstallRemoteSkillsRequestSchema.safeParse({ source: "owner/repo", selections: [] }).success).toBe(false);
    expect(InstallRemoteSkillsRequestSchema.safeParse({ source: "owner/repo" }).success).toBe(false);
    // A name alone is no longer a selection: the request states exact content.
    expect(InstallRemoteSkillsRequestSchema.safeParse({ source: "owner/repo", names: ["demo"] }).success).toBe(false);
    expect(
      InstallRemoteSkillsRequestSchema.safeParse({ source: "owner/repo", selections: [{ name: "demo" }] }).success,
    ).toBe(false);
    expect(
      InstallRemoteSkillsRequestSchema.safeParse({
        source: "owner/repo",
        selections: Array.from({ length: SKILL_MAX_PER_AGENT + 1 }, () => selection),
      }).success,
    ).toBe(false);
  });

  it("requires an error code exactly on failed items", () => {
    expect(RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "installed" }).success).toBe(true);
    expect(RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "skipped_name_conflict" }).success).toBe(
      true,
    );
    expect(
      RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "failed", errorCode: "SKILL_NOT_FOUND" })
        .success,
    ).toBe(true);
    expect(RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "failed" }).success).toBe(false);
    expect(
      RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "installed", errorCode: "SKILL_NOT_FOUND" })
        .success,
    ).toBe(false);
    expect(
      RemoteSkillInstallResultSchema.safeParse({ name: "demo", status: "failed", errorCode: "NOT_A_CODE" }).success,
    ).toBe(false);
    expect(InstallRemoteSkillsResponseSchema.safeParse({ results: [] }).success).toBe(true);
  });

  it("pins the numeric limits the fetch layer enforces", () => {
    expect(SKILL_SOURCE_DOWNLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(SKILL_SOURCE_EXTRACT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(SKILL_SOURCE_EXTRACT_MAX_FILES).toBe(1000);
    expect(SKILL_SOURCE_SNAPSHOT_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(SKILL_SOURCE_MAX_CANDIDATES).toBe(200);
    expect(SKILL_SOURCE_GIT_TIMEOUT_MS).toBe(60_000);
    expect(SKILL_SOURCE_HTTP_TIMEOUT_MS).toBe(30_000);
    expect(SKILL_SOURCE_INPUT_MAX_LENGTH).toBe(2048);
  });
});
