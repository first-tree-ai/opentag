import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileCloudControlAuthority } from "../services/cloud-control-authority.js";

let root: string, now: number;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-cloud-control-"));
  now = Date.now();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("persists only hashes and verifies exact Cloud identity across Server restart", async () => {
  const issuer = new FileCloudControlAuthority({ root, now: () => now });
  const issued = await issuer.issue({ computerId: randomUUID(), installationId: randomUUID() });
  const restored = new FileCloudControlAuthority({ root, now: () => now });
  const identity = {
    credentialId: issued.credentialId,
    computerId: issued.computerId,
    installationId: issued.installationId,
  };
  expect(await restored.verifyControlCredential(issued.credential.slice("otcloud-control.".length))).toEqual(identity);
  expect(await restored.isActive({ ...identity, computerId: randomUUID() })).toBe(false);
  for (const name of await readdir(root))
    expect(await readFile(join(root, name), "utf8")).not.toContain(issued.credential.split(".").at(-1));
});
it("supports replacement, explicit predecessor revocation, and hard expiry", async () => {
  const onRevoked = vi.fn(async () => undefined);
  const authority = new FileCloudControlAuthority({ root, now: () => now, onRevoked });
  const first = await authority.issue({ computerId: randomUUID(), installationId: randomUUID() });
  const second = await authority.rotate(first.credentialId);
  await authority.revoke(first.credentialId);
  expect(await authority.verifyControlCredential(first.credential.slice("otcloud-control.".length))).toBeUndefined();
  expect(await authority.verifyControlCredential(second.credential.slice("otcloud-control.".length))).toMatchObject({
    credentialId: second.credentialId,
  });
  expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ credentialId: first.credentialId }));
  now += 3_600_000;
  expect(await authority.verifyControlCredential(second.credential.slice("otcloud-control.".length))).toBeUndefined();
});
it("rejects forged tokens and path traversal without creating credentials", async () => {
  const authority = new FileCloudControlAuthority({ root, now: () => now });
  expect(await authority.verifyControlCredential("../../secrets")).toBeUndefined();
  expect(await authority.verifyControlCredential(`${randomUUID()}.${"A".repeat(43)}`)).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

it("prunes expired credentials without deleting an active replacement", async () => {
  const authority = new FileCloudControlAuthority({ root, now: () => now });
  const old = await authority.issue({ computerId: randomUUID(), installationId: randomUUID(), ttlMs: 60_000 });
  const replacement = await authority.issue({ computerId: old.computerId, installationId: old.installationId });
  now += 60_001;
  expect(await authority.pruneExpired()).toBe(1);
  expect(await authority.verifyControlCredential(old.credential.slice("otcloud-control.".length))).toBeUndefined();
  expect(
    await authority.verifyControlCredential(replacement.credential.slice("otcloud-control.".length)),
  ).toMatchObject({ credentialId: replacement.credentialId });
});
