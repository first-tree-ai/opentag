import { webcrypto } from "node:crypto";
import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_ERROR_CODES,
  type SkillErrorCode,
  type SkillSource,
} from "@opentag/shared/browser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  archiveFormatForFile,
  checkSkillArchiveFile,
  formatArchiveBytes,
  sha256Hex,
  skillErrorMessage,
  skillRejectionMessage,
  skillSourceLabel,
} from "./skills-page-model.js";

beforeAll(() => {
  // jsdom does not always expose WebCrypto's subtle digest; the model only needs `subtle`.
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
});

describe("archiveFormatForFile", () => {
  it.each([
    ["notes.zip", "zip"],
    ["notes.ZIP", "zip"],
    ["notes.skill", "zip"],
    ["notes.SKILL", "zip"],
    ["notes.tar.gz", "tar.gz"],
    ["notes.TAR.GZ", "tar.gz"],
    ["notes.tgz", "tar.gz"],
  ])("maps %s to %s", (name, expected) => {
    expect(archiveFormatForFile(name)).toBe(expected);
  });

  it.each(["notes.tar", "notes", "notes.zip.txt", ""])("rejects %s", (name) => {
    expect(archiveFormatForFile(name)).toBeNull();
  });
});

describe("checkSkillArchiveFile", () => {
  it("accepts a known archive at the size limit", () => {
    expect(checkSkillArchiveFile({ name: "notes.zip", size: SKILL_ARCHIVE_MAX_BYTES })).toEqual({
      ok: true,
      format: "zip",
    });
  });

  it("rejects an archive over the size limit before it is read", () => {
    expect(checkSkillArchiveFile({ name: "notes.zip", size: SKILL_ARCHIVE_MAX_BYTES + 1 })).toEqual({
      ok: false,
      rejection: "too_large",
    });
  });

  it("rejects an unknown extension", () => {
    expect(checkSkillArchiveFile({ name: "notes.txt", size: 10 })).toEqual({
      ok: false,
      rejection: "unsupported_format",
    });
  });

  it("accepts the exact filename this page downloads a bundle as", () => {
    // W2: a bundle downloaded from the page arrives named `<skill>.tar.gz` and must be re-uploadable.
    expect(checkSkillArchiveFile({ name: "demo.tar.gz", size: 10 })).toEqual({ ok: true, format: "tar.gz" });
  });
});

describe("sha256Hex", () => {
  it("hashes a known blob to lowercase hex", async () => {
    // sha256("hello")
    expect(await sha256Hex(new Blob(["hello"]))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("hashes the empty blob", async () => {
    expect(await sha256Hex(new Blob([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("formatArchiveBytes", () => {
  it("keeps bytes exact below a kibibyte", () => {
    expect(formatArchiveBytes(512)).toBe("512 B");
  });

  it("rounds kibibytes and mebibytes to one decimal", () => {
    expect(formatArchiveBytes(2048)).toBe("2 KB");
    expect(formatArchiveBytes(16 * 1024 * 1024)).toBe("16 MB");
  });
});

describe("skillSourceLabel", () => {
  it("has a sentence for every source", () => {
    const sources: SkillSource[] = ["web_upload", "cli_upload", "agent_upload"];
    expect(new Set(sources.map(skillSourceLabel)).size).toBe(sources.length);
  });
});

describe("skillErrorMessage", () => {
  it("maps every contract error code, to a distinct sentence", () => {
    const codes = Object.values(SKILL_ERROR_CODES) as SkillErrorCode[];
    const messages = codes.map((code) => skillErrorMessage(code));
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(codes.length);
  });

  it("falls back to a generic sentence for a missing or unknown code", () => {
    expect(skillErrorMessage(undefined)).toBe(skillErrorMessage("SOMETHING_ELSE"));
  });
});

describe("skillRejectionMessage", () => {
  it("distinguishes an oversized archive from an unsupported extension", () => {
    expect(skillRejectionMessage("too_large")).not.toBe(skillRejectionMessage("unsupported_format"));
  });
});
