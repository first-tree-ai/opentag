import { createHash } from "node:crypto";
import { SKILL_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { openDocumentSource } from "../services/skills/source/document-source.js";
import { SkillSourceFetcher } from "../services/skills/source/source-fetcher.js";
import { buildStoredZip, skillManifest, tarGz } from "./support/skill-archive-fixtures.js";
import { staticTransport } from "./support/skill-source-fixtures.js";

/**
 * The direct-download path: the format comes from the bytes, and a URL that publishes no Skill is a
 * source with no Skills rather than an error code of its own.
 */

const PUBLIC = "93.184.216.34";

type StubAnswer = { status: number; body?: Uint8Array | string };

/**
 * A fetcher whose transport answers from one handler.
 *
 * The document cases all use the same URL or a URL they do not need to name exactly, so a handler is
 * clearer here than the route map the other suites use.
 */
function fetcherServing(handler: (url: string) => StubAnswer | undefined): SkillSourceFetcher {
  return new SkillSourceFetcher({
    allowLoopback: false,
    resolveAddresses: async () => [PUBLIC],
    transport: (request) => {
      const answer = handler(request.url.toString());
      if (answer === undefined) return Promise.resolve({ status: 404, bytes: new Uint8Array() });
      if (answer.status < 200 || answer.status >= 300) {
        return Promise.resolve({ status: answer.status, bytes: new Uint8Array() });
      }
      const body = answer.body;
      const bytes = body === undefined ? new Uint8Array() : typeof body === "string" ? text(body) : body;
      return Promise.resolve({ status: answer.status, bytes });
    },
  });
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const text = (value: string) => new TextEncoder().encode(value);

describe("openDocumentSource", () => {
  it("reads a gzip archive and lists its files", async () => {
    const archive = await tarGz([
      { name: "my-skill/SKILL.md", body: skillManifest("demo") },
      { name: "my-skill/extra.md", body: "extra" },
    ]);
    const fetcher = fetcherServing(() => ({ status: 200, body: archive }));
    const document = await openDocumentSource(fetcher, "https://example.test/download/my-skill");
    expect(document.format).toBe("tar.gz");
    expect(document.snapshot.files.map((file) => file.path).sort()).toEqual(["my-skill/SKILL.md", "my-skill/extra.md"]);
    await document.snapshot.dispose();
  });

  it("reads an extensionless download by its magic bytes", async () => {
    const archive = await tarGz([{ name: "SKILL.md", body: skillManifest("demo") }]);
    const fetcher = fetcherServing(() => ({ status: 200, body: archive }));
    const document = await openDocumentSource(fetcher, "https://example.test/download/demo");
    expect(document.format).toBe("tar.gz");
    await document.snapshot.dispose();
  });

  it("reads a zip archive even when the URL claims otherwise", async () => {
    const archive = buildStoredZip([{ name: "SKILL.md", body: skillManifest("demo") }]);
    const fetcher = fetcherServing(() => ({ status: 200, body: archive }));
    const document = await openDocumentSource(fetcher, "https://example.test/demo.tar.gz");
    expect(document.format).toBe("zip");
    expect(document.snapshot.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    await document.snapshot.dispose();
  });

  it("reads a bare SKILL.md as a one-file Skill", async () => {
    const fetcher = fetcherServing(() => ({ status: 200, body: skillManifest("demo") }));
    const document = await openDocumentSource(fetcher, "https://example.test/SKILL.md");
    expect(document.format).toBe("skill_md");
    expect(document.snapshot.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    await document.snapshot.dispose();
  });

  it("reports text that is not a SKILL.md as a source with no Skills", async () => {
    const fetcher = fetcherServing(() => ({ status: 200, body: "# just notes\n" }));
    expect(await code(openDocumentSource(fetcher, "https://example.test/notes.md"))).toBe(
      SKILL_ERROR_CODES.SOURCE_NO_SKILLS,
    );
  });

  it("reports an empty download as a source with no Skills", async () => {
    const fetcher = fetcherServing(() => ({ status: 200, body: new Uint8Array() }));
    expect(await code(openDocumentSource(fetcher, "https://example.test/empty"))).toBe(
      SKILL_ERROR_CODES.SOURCE_NO_SKILLS,
    );
  });

  it("refuses an archive whose members are invalid", async () => {
    const archive = await tarGz([{ name: "../escape/SKILL.md", body: skillManifest("demo") }]);
    const fetcher = fetcherServing(() => ({ status: 200, body: archive }));
    expect(await code(openDocumentSource(fetcher, "https://example.test/bad"))).toBe(SKILL_ERROR_CODES.ARCHIVE_INVALID);
  });

  it("bounds the download before it reads anything", async () => {
    const fetcher = new SkillSourceFetcher({
      allowLoopback: false,
      resolveAddresses: async () => [PUBLIC],
      maxBytes: 8,
      // The cap is enforced by the transport, so the stub that stands in for it enforces it too.
      transport: staticTransport({
        "https://example.test/big": () => ({ status: 200, body: new Uint8Array(64) }),
      }),
    });
    expect(await code(openDocumentSource(fetcher, "https://example.test/big"))).toBe(
      SKILL_ERROR_CODES.SOURCE_TOO_LARGE,
    );
  });

  it("reports a missing download as unreachable", async () => {
    const fetcher = fetcherServing(() => ({ status: 404, body: "nope" }));
    expect(await code(openDocumentSource(fetcher, "https://example.test/gone"))).toBe(
      SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
    );
  });

  it("treats a missing document as absent rather than failed when the caller allows it", async () => {
    const fetcher = fetcherServing(() => ({ status: 404, body: "nope" }));
    const response = await fetcher.fetchBytesAllowMissing("https://example.test/gone");
    expect(response.status).toBe(404);
    expect(response.bytes.byteLength).toBe(0);
  });
});

describe("digest helpers", () => {
  it("hashes the bytes a test hands to an index", () => {
    const bytes = text("demo");
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  });
});
