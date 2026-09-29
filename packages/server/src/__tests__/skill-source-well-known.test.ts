import { createHash } from "node:crypto";
import {
  ResolveRemoteSkillsResponseSchema,
  SKILL_ERROR_CODES,
  SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_BYTES,
  SKILL_SOURCE_MAX_CANDIDATES,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { RemoteSkillListing } from "../services/skills/source/remote-candidates.js";
import { parseWellKnownIndex, resolveWellKnownSource } from "../services/skills/source/well-known-source.js";
import { skillManifest, tarGz } from "./support/skill-archive-fixtures.js";
import { stubFetcher } from "./support/skill-source-fixtures.js";

/**
 * Well-known Skill discovery: both index versions, the two probe paths, the digest check, and the two
 * outcomes that must not be confused — a host that publishes no index at all (which lets the caller
 * try the URL as a download) and a host whose index holds nothing installable.
 */

const SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fetcherServing(routes: Record<string, () => { status: number; body?: Uint8Array | string } | undefined>) {
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

/** The first listing of a found index; the cases below all index a one-entry index. */
function firstListing(result: { found: true; listings: RemoteSkillListing[] }): RemoteSkillListing {
  return first(result.listings);
}

const json = (value: unknown) => () => ({ status: 200, body: JSON.stringify(value) });

/** The first entry, asserted present: a missing one is a test setup failure, not a soft expectation. */
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("expected at least one item");
  return value;
}

describe("parseWellKnownIndex", () => {
  it("classifies the two document versions", () => {
    expect(parseWellKnownIndex(JSON.stringify({ $schema: SCHEMA_V2, skills: [{ name: "demo" }] }))?.version).toBe(
      "0.2.0",
    );
    expect(
      parseWellKnownIndex(JSON.stringify({ skills: [{ name: "demo", description: "d", files: ["SKILL.md"] }] })),
    ).toMatchObject({ version: "0.1.0" });
  });

  it("rejects a document that is not an index", () => {
    expect(parseWellKnownIndex("not json")).toBeUndefined();
    expect(parseWellKnownIndex(JSON.stringify({ skills: "no" }))).toBeUndefined();
    expect(parseWellKnownIndex(JSON.stringify({ $schema: "https://example.test/other", skills: [] }))).toBeUndefined();
    expect(parseWellKnownIndex(JSON.stringify({ skills: [] }))).toMatchObject({ version: "0.1.0", entries: [] });
  });

  it("drops entries whose metadata cannot be used", () => {
    const parsed = parseWellKnownIndex(
      JSON.stringify({
        $schema: SCHEMA_V2,
        skills: [
          {
            name: "BadName",
            description: "d",
            type: "skill-md",
            url: "https://example.test/a",
            digest: "x".repeat(64),
          },
          { name: "demo", description: "d", type: "nope", url: "https://example.test/a", digest: "x".repeat(64) },
          { name: "ok", description: "d", type: "skill-md", url: "https://example.test/b", digest: "b".repeat(63) },
          { name: "good", description: "d", type: "archive", url: "https://example.test/c", digest: "c".repeat(64) },
        ],
      }),
    );
    expect(parsed?.entries.map((entry) => entry.name)).toEqual(["good"]);
  });
});

describe("resolveWellKnownSource", () => {
  it("reports a host that publishes no index at all", async () => {
    const result = await resolveWellKnownSource(fetcherServing({}), "https://example.test/skills");
    expect(result).toEqual({ found: false });
  });

  it("reads a v0.2.0 index and verifies the artifact digest", async () => {
    const artifact = await tarGz([{ name: "SKILL.md", body: skillManifest("demo") }]);
    const index = {
      $schema: SCHEMA_V2,
      skills: [
        {
          name: "demo",
          description: "A demo",
          type: "archive",
          url: "https://example.test/artifacts/demo.tar.gz",
          digest: sha256(artifact),
        },
      ],
    };
    const fetcher = fetcherServing({
      "https://example.test/skills/.well-known/agent-skills/index.json": json(index),
      "https://example.test/artifacts/demo.tar.gz": () => ({ status: 200, body: artifact }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test/skills");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings.map((listing) => listing.candidate)).toEqual([
      {
        name: "demo",
        description: "A demo",
        path: "demo",
        alreadyInstalled: false,
        // The published digest is the fingerprint: the install re-verifies it against the artifact.
        fingerprint: `sha256:${sha256(artifact)}`,
      },
    ]);
    expect(new TextDecoder().decode(first(await firstListing(result).materialize()).body)).toContain("name: demo");
  });

  it("refuses an artifact whose digest does not match", async () => {
    const index = {
      $schema: SCHEMA_V2,
      skills: [
        {
          name: "demo",
          description: "A demo",
          type: "skill-md",
          url: "https://example.test/artifacts/demo.md",
          digest: "a".repeat(64),
        },
      ],
    };
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json(index),
      "https://example.test/artifacts/demo.md": () => ({ status: 200, body: skillManifest("demo") }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(await code(firstListing(result).materialize())).toBe(SKILL_ERROR_CODES.SOURCE_INVALID);
  });

  it("reads a v0.2.0 skill-md artifact", async () => {
    const artifact = new TextEncoder().encode(skillManifest("demo"));
    const index = {
      $schema: SCHEMA_V2,
      skills: [
        {
          name: "demo",
          description: "A demo",
          type: "skill-md",
          url: "./demo/SKILL.md",
          digest: sha256(artifact),
        },
      ],
    };
    const fetcher = fetcherServing({
      "https://example.test/skills/.well-known/agent-skills/index.json": json(index),
      // A relative artifact URL resolves against the index document that published it.
      "https://example.test/skills/.well-known/agent-skills/demo/SKILL.md": () => ({ status: 200, body: artifact }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test/skills");
    expect(result.found).toBe(true);
    if (!result.found) return;
    const files = await firstListing(result).materialize();
    expect(files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(files[0]?.body.byteLength).toBe(artifact.byteLength);
  });

  it("falls back to the legacy index when the modern one is not there", async () => {
    const legacy = {
      skills: [{ name: "demo", description: "A demo", files: ["SKILL.md", "extra.md"] }],
    };
    const fetcher = fetcherServing({
      "https://example.test/.well-known/skills/index.json": json(legacy),
      "https://example.test/.well-known/skills/demo/SKILL.md": () => ({ status: 200, body: skillManifest("demo") }),
      "https://example.test/.well-known/skills/demo/extra.md": () => ({ status: 200, body: "extra" }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings[0]?.candidate).toMatchObject({
      name: "demo",
      description: "A demo",
      path: "demo",
      fileCount: 2,
      alreadyInstalled: false,
      // The legacy layout publishes no content hash, so the preview reads the files to bind the
      // candidate to what it actually offers.
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const files = await firstListing(result).materialize();
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "extra.md"]);
  });

  it("prefers the legacy index over a modern document it cannot read", async () => {
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": () => ({ status: 200, body: "<html>" }),
      "https://example.test/.well-known/skills/index.json": json({
        skills: [{ name: "demo", description: "d", files: ["SKILL.md"] }],
      }),
      "https://example.test/.well-known/skills/demo/SKILL.md": () => ({ status: 200, body: skillManifest("demo") }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings[0]?.candidate.name).toBe("demo");
  });

  it("reports a host whose published index cannot be read", async () => {
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": () => ({ status: 200, body: "<html>" }),
      "https://example.test/.well-known/skills/index.json": () => ({ status: 200, body: "<html>" }),
    });
    expect(await code(resolveWellKnownSource(fetcher, "https://example.test"))).toBe(SKILL_ERROR_CODES.SOURCE_INVALID);
  });

  it("reports an index with nothing installable as a source with no Skills", async () => {
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json({ $schema: SCHEMA_V2, skills: [] }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result).toEqual({ found: true, listings: [] });
  });

  it("marks a skill the Agent already owns", async () => {
    const artifact = new TextEncoder().encode(skillManifest("demo"));
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json({
        $schema: SCHEMA_V2,
        skills: [
          {
            name: "demo",
            description: "d",
            type: "skill-md",
            url: "https://example.test/demo.md",
            digest: sha256(artifact),
          },
        ],
      }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test", {
      existingNames: ["demo", "other"],
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings[0]?.candidate.alreadyInstalled).toBe(true);
  });

  it("accepts the RFC's `sha256:` digest form and normalizes it", () => {
    const hex = "d".repeat(64);
    const parsed = parseWellKnownIndex(
      JSON.stringify({
        $schema: SCHEMA_V2,
        skills: [
          {
            name: "demo",
            description: "d",
            type: "archive",
            url: "https://example.test/a.tar.gz",
            digest: `sha256:${hex}`,
          },
          {
            name: "upper",
            description: "d",
            type: "archive",
            url: "https://example.test/b.tar.gz",
            digest: `SHA256:${"e".repeat(64)}`,
          },
          {
            name: "bare",
            description: "d",
            type: "archive",
            url: "https://example.test/c.tar.gz",
            digest: "f".repeat(64),
          },
          { name: "bad", description: "d", type: "archive", url: "https://example.test/d.tar.gz", digest: "md5:abc" },
        ],
      }),
    );
    // The prefix is accepted, case-insensitively, and the normalized value is bare lowercase hex so a
    // publisher that switches spelling does not look like a content change.
    expect(parsed?.entries.map((entry) => entry.name)).toEqual(["demo", "upper", "bare"]);
    expect(parsed?.entries[0]).toMatchObject({ digest: hex });
  });

  it("reads a digest-prefixed index end to end", async () => {
    const artifact = await tarGz([{ name: "SKILL.md", body: skillManifest("demo") }]);
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json({
        $schema: SCHEMA_V2,
        skills: [
          {
            name: "demo",
            description: "A demo",
            type: "archive",
            url: "https://example.test/demo.tar.gz",
            digest: `sha256:${sha256(artifact)}`,
          },
        ],
      }),
      "https://example.test/demo.tar.gz": () => ({ status: 200, body: artifact }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings[0]?.candidate.fingerprint).toBe(`sha256:${sha256(artifact)}`);
    expect((await firstListing(result).materialize()).map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("drops a legacy entry whose declared file list is over the entry cap", () => {
    const files = Array.from({ length: 1001 }, (_value, index) => `file-${index}.md`);
    const parsed = parseWellKnownIndex(
      JSON.stringify({ skills: [{ name: "huge", description: "d", files: [...files, "SKILL.md"] }] }),
    );
    // The list is bounded before anything is fetched: an unbounded array would be one request and one
    // retained body per member.
    expect(parsed?.entries).toEqual([]);
  });

  it("spends one unpacked-byte budget across a legacy entry's files", async () => {
    const requests: { url: string; maxBytes: number }[] = [];
    // Two files whose total exceeds the Skill's unpacked budget, so the budget — not the per-download
    // cap — is what limits the last one.
    const eightMebibytes = new Uint8Array(8 * 1024 * 1024);
    const fetcher = stubFetcher(
      {
        "https://example.test/.well-known/skills/index.json": json({
          skills: [{ name: "demo", description: "d", files: ["SKILL.md", "a.bin", "b.bin", "tail.md"] }],
        }),
        "https://example.test/.well-known/skills/demo/SKILL.md": () => ({ status: 200, body: skillManifest("demo") }),
        "https://example.test/.well-known/skills/demo/a.bin": () => ({ status: 200, body: eightMebibytes }),
        "https://example.test/.well-known/skills/demo/b.bin": () => ({ status: 200, body: eightMebibytes }),
        "https://example.test/.well-known/skills/demo/tail.md": () => ({ status: 200, body: "tail" }),
      },
      { requests },
    );
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    const files = await result.listings[0]?.materialize();
    expect(files?.map((file) => file.path)).toEqual(["SKILL.md", "a.bin", "b.bin", "tail.md"]);

    // The first file may take the full download allowance; each later file only what the Skill's
    // unpacked budget has left, so a long list of large files cannot retain one full download each.
    const manifestBytes = new TextEncoder().encode(skillManifest("demo")).byteLength;
    const allowance = (suffix: string) => requests.find((entry) => entry.url.endsWith(suffix))?.maxBytes;
    expect(allowance("/demo/SKILL.md")).toBe(SKILL_SOURCE_DOWNLOAD_MAX_BYTES);
    expect(allowance("/demo/a.bin")).toBe(SKILL_SOURCE_DOWNLOAD_MAX_BYTES);
    expect(allowance("/demo/b.bin")).toBe(SKILL_SOURCE_DOWNLOAD_MAX_BYTES);
    expect(allowance("/demo/tail.md")).toBe(
      SKILL_SOURCE_EXTRACT_MAX_BYTES - manifestBytes - 2 * eightMebibytes.byteLength,
    );
  });

  it("bounds a well-known catalog at the candidate ceiling", async () => {
    const skills = Array.from({ length: SKILL_SOURCE_MAX_CANDIDATES + 1 }, (_value, index) => ({
      name: `demo-${index}`,
      description: "d",
      type: "skill-md",
      url: `https://example.test/${index}.md`,
      digest: "a".repeat(64),
    }));
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json({ $schema: SCHEMA_V2, skills }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(result.found).toBe(true);
    if (!result.found) return;
    // A 201-entry index is truncated rather than handed to the response schema, which rejects 201.
    expect(result.listings).toHaveLength(SKILL_SOURCE_MAX_CANDIDATES);
    expect(
      ResolveRemoteSkillsResponseSchema.safeParse({
        source: { kind: "well_known", url: "https://example.test" },
        skills: result.listings.map((listing) => listing.candidate),
      }).success,
    ).toBe(true);
  });

  it("reads at most the configured number of legacy entries", async () => {
    const files = ["SKILL.md"];
    const skills = Array.from({ length: 5 }, (_value, index) => ({
      name: `demo-${index}`,
      description: "d",
      files,
    }));
    const requests: string[] = [];
    const fetcher = stubFetcher(
      {
        "https://example.test/.well-known/skills/index.json": json({ skills }),
        ...Object.fromEntries(
          skills.map((skill) => [
            `https://example.test/.well-known/skills/${skill.name}/SKILL.md`,
            () => {
              requests.push(skill.name);
              return { status: 200, body: skillManifest(skill.name) };
            },
          ]),
        ),
      },
      { requests: undefined },
    );
    const result = await resolveWellKnownSource(fetcher, "https://example.test", { maxCandidates: 2 });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.listings.map((listing) => listing.candidate.name)).toEqual(["demo-0", "demo-1"]);
    // The legacy preview reads each entry to bind it to content, so the cap has to stop the reading
    // too — otherwise a long catalog would still be downloaded.
    expect(requests).toEqual(["demo-0", "demo-1"]);
  });

  it("binds a legacy entry to its content, not only its file list", async () => {
    const original = skillManifest("demo", "The original description");
    let body = original;
    const index = {
      skills: [{ name: "demo", description: "d", files: ["SKILL.md"] }],
    };
    const fetcher = stubFetcher({
      "https://example.test/.well-known/skills/index.json": json(index),
      "https://example.test/.well-known/skills/demo/SKILL.md": () => ({ status: 200, body }),
    });

    const preview = await resolveWellKnownSource(fetcher, "https://example.test");
    expect(preview.found).toBe(true);
    if (!preview.found) return;
    const fingerprint = preview.listings[0]?.candidate.fingerprint ?? "";

    // The file list is unchanged, so only a content-bound identity can notice this.
    body = skillManifest("demo", "A different description");
    const reread = await preview.listings[0]?.fingerprint();
    expect(reread).not.toBe(fingerprint);
    expect(reread).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("never falls back to an origin-root index for a scoped URL", async () => {
    const fetcher = fetcherServing({
      "https://example.test/.well-known/agent-skills/index.json": json({
        $schema: SCHEMA_V2,
        skills: [{ name: "root", description: "d" }],
      }),
    });
    const result = await resolveWellKnownSource(fetcher, "https://example.test/team");
    expect(result).toEqual({ found: false });
  });
});
