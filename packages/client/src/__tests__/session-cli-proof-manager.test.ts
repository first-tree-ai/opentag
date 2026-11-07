import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSessionCliProofFile,
  readSessionRunInputsHeader,
  SessionCliProofManager,
  sessionRunInputsPath,
} from "../runtime/session-cli-proof-manager.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("SessionCliProofManager", () => {
  it("atomically materializes a runtime-managed proof and removes it on cleanup", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-proof-"));
    homes.push(home);
    const manager = new SessionCliProofManager(home);
    const sessionId = randomUUID();
    const proof = { proofId: randomUUID(), token: "x".repeat(43) };
    const path = await manager.materialize(sessionId, proof);
    expect(await readSessionCliProofFile(path)).toEqual(proof);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain(sessionId);
    await manager.cleanup(sessionId);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes what the current Run is working on, beside the proof", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-proof-"));
    homes.push(home);
    const manager = new SessionCliProofManager(home);
    const sessionId = randomUUID();
    const path = manager.pathForSession(sessionId);
    const [own, steered, delivered] = [randomUUID(), randomUUID(), randomUUID()];
    await expect(readSessionRunInputsHeader(path)).resolves.toBeUndefined();
    await manager.addRunInput(sessionId, { kind: "session-message", messageId: steered });
    await expect(readSessionRunInputsHeader(path)).resolves.toBeUndefined();

    await manager.beginRun(sessionId, "run-1", [{ kind: "session-message", messageId: own }]);
    await manager.addRunInput(sessionId, { kind: "session-message", messageId: steered });
    await manager.addRunInput(sessionId, { kind: "delivery", deliveryId: delivered });
    await expect(readSessionRunInputsHeader(path)).resolves.toBe(`m:${own},m:${steered},d:${delivered}`);
    expect((await stat(sessionRunInputsPath(path))).mode & 0o777).toBe(0o600);

    await manager.removeRunInput(sessionId, { kind: "delivery", deliveryId: delivered });
    await manager.removeRunInput(sessionId, { kind: "delivery", deliveryId: delivered });
    // The same Run's retry keeps what it was given; another Run does not.
    await manager.beginRun(sessionId, "run-1", []);
    await expect(readSessionRunInputsHeader(path)).resolves.toBe(`m:${own},m:${steered}`);
    await manager.endRun(sessionId, "someone-else");
    await expect(readSessionRunInputsHeader(path)).resolves.toBe(`m:${own},m:${steered}`);
    await manager.beginRun(sessionId, "run-2", [{ kind: "delivery", deliveryId: delivered }]);
    await expect(readSessionRunInputsHeader(path)).resolves.toBe(`d:${delivered}`);
    await manager.endRun(sessionId, "run-2");
    await expect(stat(sessionRunInputsPath(path))).rejects.toMatchObject({ code: "ENOENT" });
    await manager.beginRun(sessionId, "run-3", [{ kind: "delivery", deliveryId: delivered }]);
    await manager.cleanup(sessionId);
    await expect(readSessionRunInputsHeader(path)).resolves.toBeUndefined();
  });

  it("leaves no list behind when one cannot be written, and reads a broken one as none", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-proof-"));
    homes.push(home);
    const logger = { warn: vi.fn() };
    const manager = new SessionCliProofManager(home, logger);
    const sessionId = randomUUID();
    const path = manager.pathForSession(sessionId);
    await manager.materialize(randomUUID(), { proofId: randomUUID(), token: "x".repeat(43) });
    await mkdir(sessionRunInputsPath(path));
    await manager.beginRun(sessionId, "run-1", [{ kind: "delivery", deliveryId: randomUUID() }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_RUN_INPUTS_WRITE_FAILED", sessionId }),
      expect.any(String),
    );
    await expect(readSessionRunInputsHeader(path)).resolves.toBeUndefined();
    await rm(sessionRunInputsPath(path), { recursive: true });
    await writeFile(sessionRunInputsPath(path), '{"inputs":[1]}');
    await expect(readSessionRunInputsHeader(path)).resolves.toBeUndefined();
  });
});
