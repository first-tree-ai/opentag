import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionCliProofFile, SessionCliProofManager } from "../runtime/session-cli-proof-manager.js";

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
});
