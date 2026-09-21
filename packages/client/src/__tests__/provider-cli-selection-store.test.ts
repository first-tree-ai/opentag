import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CLI_SELECTION_SCHEMA_VERSION,
  type ProviderCliSelection,
  providerCliSelectionTargetPath,
  RuntimeStorageError,
  readProviderCliSelection,
  resolveProviderCliAccountLayout,
  writePrivateJson,
  writeProviderCliSelection,
} from "../index.js";
import {
  parseProviderCliSelectionRecord,
  providerCliSelectionsEqual,
} from "../runtime/provider-cli/selection-store.js";

const FINGERPRINT = `v1:${"a".repeat(64)}`;
const OTHER_FINGERPRINT = `v1:${"b".repeat(64)}`;

const managed: ProviderCliSelection = {
  kind: "managed",
  artifactId: "1.0.92/linux-x64/deadbeef",
  version: "1.0.92",
  targetPath: "/opt/opentag/versions/lark-cli",
  fingerprint: FINGERPRINT,
};

const external: ProviderCliSelection = {
  kind: "external",
  executablePath: "/usr/local/bin/lark-cli",
  fingerprint: FINGERPRINT,
  trust: "compatible-unverified",
  version: "1.0.93",
};

function record(overrides: Record<string, unknown> = {}, selection: unknown = managed): Record<string, unknown> {
  return {
    schemaVersion: PROVIDER_CLI_SELECTION_SCHEMA_VERSION,
    provider: "feishu",
    generation: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
    selection,
    ...overrides,
  };
}

const tempDirs: string[] = [];

function thrown(run: () => unknown): RuntimeStorageError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeStorageError);
    return error as RuntimeStorageError;
  }
  throw new Error("expected the parser to throw");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseProviderCliSelectionRecord", () => {
  it("accepts managed and external selections", () => {
    expect(parseProviderCliSelectionRecord(record())).toEqual(record());
    expect(parseProviderCliSelectionRecord(record({ provider: "slack" }, external))).toEqual(
      record({ provider: "slack" }, external),
    );
  });

  it("drops unknown selection fields", () => {
    const parsed = parseProviderCliSelectionRecord(record({}, { ...managed, extra: true }));
    expect(parsed.selection).toEqual(managed);
    const parsedExternal = parseProviderCliSelectionRecord(record({}, { ...external, extra: true }));
    expect(parsedExternal.selection).toEqual(external);
  });

  it.each([
    ["a non-object", "text"],
    ["a null value", null],
    ["an unsupported schema version", record({ schemaVersion: 2 })],
    ["a missing schema version", record({ schemaVersion: undefined })],
  ])("rejects %s as an unsupported schema", (_label, value) => {
    const error = thrown(() => parseProviderCliSelectionRecord(value));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI selection schema is unsupported");
  });

  it.each([
    ["an unknown provider", record({ provider: "teams" })],
    ["a string generation", record({ generation: "1" })],
    ["a fractional generation", record({ generation: 1.5 })],
    ["a zero generation", record({ generation: 0 })],
    ["an empty updatedAt", record({ updatedAt: "" })],
    ["an unparseable updatedAt", record({ updatedAt: "yesterday" })],
  ])("rejects %s as a malformed record", (_label, value) => {
    const error = thrown(() => parseProviderCliSelectionRecord(value));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI selection record is malformed");
  });

  it("rejects a selection that is not an object", () => {
    for (const value of [record({ selection: undefined }), record({}, null), record({}, "managed"), record({}, [])]) {
      const error = thrown(() => parseProviderCliSelectionRecord(value));
      expect(error.code).toBe("invalid");
      expect(error.message).toBe("Provider CLI selection is malformed");
    }
  });

  it("rejects an unknown selection kind and names the provider", () => {
    const error = thrown(() => parseProviderCliSelectionRecord(record({ provider: "slack" }, { kind: "bundled" })));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI selection kind is unknown for slack");
  });

  it.each([
    ["a missing artifact id", { ...managed, artifactId: undefined }],
    ["an empty version", { ...managed, version: "" }],
    ["a non-string target path", { ...managed, targetPath: 7 }],
    ["a missing fingerprint", { ...managed, fingerprint: undefined }],
  ])("rejects a managed selection with %s", (_label, selection) => {
    const error = thrown(() => parseProviderCliSelectionRecord(record({}, selection)));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI managed selection is malformed");
  });

  it.each([
    ["a relative target path", { ...managed, targetPath: "versions/lark-cli" }],
    ["an invalid semver version", { ...managed, version: "latest" }],
    ["a malformed fingerprint", { ...managed, fingerprint: "sha256:abc" }],
  ])("rejects a managed selection with %s", (_label, selection) => {
    const error = thrown(() => parseProviderCliSelectionRecord(record({}, selection)));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI managed selection identity is malformed");
  });

  it.each([
    ["a missing executable path", { ...external, executablePath: undefined }],
    ["an empty fingerprint", { ...external, fingerprint: "" }],
    ["an unknown trust", { ...external, trust: "trusted" }],
    ["a missing trust", { ...external, trust: undefined }],
    ["an invalid semver version", { ...external, version: "v1" }],
    ["a malformed fingerprint", { ...external, fingerprint: `v2:${"a".repeat(64)}` }],
  ])("rejects an external selection with %s", (_label, selection) => {
    const error = thrown(() => parseProviderCliSelectionRecord(record({}, selection)));
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI external selection is malformed");
  });

  it("rejects an external selection with a relative executable path", () => {
    const error = thrown(() =>
      parseProviderCliSelectionRecord(record({}, { ...external, executablePath: "bin/lark-cli" })),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Provider CLI external path must be absolute");
  });
});

describe("selection helpers", () => {
  it("resolves the executed target path regardless of kind", () => {
    expect(providerCliSelectionTargetPath(managed)).toBe(managed.targetPath);
    expect(providerCliSelectionTargetPath(external)).toBe(external.executablePath);
  });

  it("compares managed selections by artifact, target and fingerprint", () => {
    expect(providerCliSelectionsEqual(managed, { ...managed })).toBe(true);
    expect(providerCliSelectionsEqual(managed, { ...managed, version: "9.9.9" })).toBe(true);
    expect(providerCliSelectionsEqual(managed, { ...managed, artifactId: "other" })).toBe(false);
    expect(providerCliSelectionsEqual(managed, { ...managed, targetPath: "/elsewhere/lark-cli" })).toBe(false);
    expect(providerCliSelectionsEqual(managed, { ...managed, fingerprint: OTHER_FINGERPRINT })).toBe(false);
  });

  it("compares external selections by executable path and fingerprint", () => {
    expect(providerCliSelectionsEqual(external, { ...external })).toBe(true);
    expect(providerCliSelectionsEqual(external, { ...external, trust: "catalog-verified", version: "2.0.0" })).toBe(
      true,
    );
    expect(providerCliSelectionsEqual(external, { ...external, executablePath: "/other/lark-cli" })).toBe(false);
    expect(providerCliSelectionsEqual(external, { ...external, fingerprint: OTHER_FINGERPRINT })).toBe(false);
  });

  it("never equates selections of different kinds", () => {
    expect(providerCliSelectionsEqual(managed, external)).toBe(false);
    expect(providerCliSelectionsEqual(external, managed)).toBe(false);
    // Defensive fallthrough for a kind the type system does not know about.
    const unknown = { kind: "bundled", fingerprint: FINGERPRINT } as unknown as ProviderCliSelection;
    expect(providerCliSelectionsEqual(unknown, unknown)).toBe(false);
  });
});

describe("readProviderCliSelection and writeProviderCliSelection", () => {
  it("round-trips a record and increments the generation on every replace", async () => {
    const accountHome = await mkdtemp(join(tmpdir(), "opentag-selection-store-"));
    tempDirs.push(accountHome);
    const layout = resolveProviderCliAccountLayout(accountHome);
    await expect(readProviderCliSelection(layout, "feishu")).resolves.toBeUndefined();

    const now = new Date("2026-09-01T12:00:00.000Z");
    const first = await writeProviderCliSelection(layout, "feishu", managed, undefined, now);
    expect(first).toEqual({
      schemaVersion: PROVIDER_CLI_SELECTION_SCHEMA_VERSION,
      provider: "feishu",
      generation: 1,
      updatedAt: now.toISOString(),
      selection: managed,
    });
    await expect(readProviderCliSelection(layout, "feishu")).resolves.toEqual(first);

    const second = await writeProviderCliSelection(layout, "feishu", external, first);
    expect(second.generation).toBe(2);
    expect(second.selection).toEqual(external);
    expect(Number.isNaN(Date.parse(second.updatedAt))).toBe(false);
    await expect(readProviderCliSelection(layout, "feishu")).resolves.toEqual(second);
    await expect(readProviderCliSelection(layout, "slack")).resolves.toBeUndefined();
  });

  it("rejects a state file whose provider does not match its name", async () => {
    const accountHome = await mkdtemp(join(tmpdir(), "opentag-selection-store-"));
    tempDirs.push(accountHome);
    const layout = resolveProviderCliAccountLayout(accountHome);
    const written = await writeProviderCliSelection(layout, "feishu", external, undefined);
    // Re-home the feishu record under the slack state file name.
    await writeProviderCliSelection(layout, "slack", external, undefined);
    await writePrivateJson(layout.root, join(layout.state, "slack.json"), written);
    await expect(readProviderCliSelection(layout, "slack")).rejects.toMatchObject({
      name: "RuntimeStorageError",
      code: "invalid",
      message: "Provider CLI selection provider does not match its state file",
    });
  });
});
