import { describe, expect, it } from "vitest";
import {
  AccountSandboxRunnerStopRequestSchema,
  RunnerClientFrameSchema,
  RunnerServerFrameSchema,
} from "../cloud-runner.js";
import { RunnerWorkspaceObjectSchema } from "../runner-workspace.js";

describe("workspace persistence wire boundary", () => {
  it("requires an explicit current allocation generation to save or discard workspace files", () => {
    expect(AccountSandboxRunnerStopRequestSchema.parse({ environmentGeneration: 4 })).toEqual({
      environmentGeneration: 4,
    });
    expect(AccountSandboxRunnerStopRequestSchema.parse({ environmentGeneration: 0 })).toEqual({
      environmentGeneration: 0,
    });
    const discard = { discardUnsavedChanges: true, environmentGeneration: 4 };
    expect(AccountSandboxRunnerStopRequestSchema.parse(discard)).toEqual(discard);
    for (const invalid of [
      {},
      { environmentGeneration: -1 },
      { discardUnsavedChanges: true },
      { ...discard, environmentGeneration: 0 },
      { ...discard, environmentGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...discard, environmentGeneration: "4" },
      { ...discard, force: true },
    ]) {
      expect(AccountSandboxRunnerStopRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("negotiates independently of legacy delivery and rejects unsupported versions", () => {
    const auth = { type: "auth", token: "test-bootstrap", cloudDeliveryVersion: 1 };
    expect(RunnerClientFrameSchema.safeParse(auth).success).toBe(true);
    expect(RunnerClientFrameSchema.safeParse({ ...auth, workspaceVersion: 1 }).success).toBe(true);
    expect(RunnerClientFrameSchema.safeParse({ ...auth, workspaceVersion: 2 }).success).toBe(false);
    const requestId = "ac369c69-9119-483f-8029-b516ea8f43fe";
    expect(RunnerServerFrameSchema.parse({ type: "workspace:seal", requestId })).toEqual({
      type: "workspace:seal",
      requestId,
    });
    expect(RunnerClientFrameSchema.safeParse({ type: "workspace:seal:result", requestId, ok: true }).success).toBe(
      true,
    );
    // Storage credentials and destination paths never enter the control protocol.
    expect(
      RunnerServerFrameSchema.safeParse({ type: "workspace:seal", requestId, storageUri: "gs://other/object" }).success,
    ).toBe(false);
  });

  it("retains opaque object generations beyond JavaScript's integer precision", () => {
    const object = {
      generation: "18446744073709551615",
      metageneration: "12",
      ownerGeneration: 2,
      saved: true,
      sealed: false,
      bytes: 64,
      sha256: "a".repeat(64),
      md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
    };
    expect(RunnerWorkspaceObjectSchema.parse(object).generation).toBe(object.generation);
    for (const patch of [
      { generation: Number(object.generation) },
      { generation: "../other" },
      { ownerGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { bytes: 128 * 1024 * 1024 + 1 },
      { sha256: "truncated" },
    ]) {
      expect(RunnerWorkspaceObjectSchema.safeParse({ ...object, ...patch }).success).toBe(false);
    }
  });
});
