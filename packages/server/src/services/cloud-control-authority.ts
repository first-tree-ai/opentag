import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  TrustedCloudControlIdentity,
  TrustedCloudControlVerifier,
} from "../runtime-credentials/trusted-control.js";
import {
  controlRecords,
  createControlFile,
  ensureControlDirectory,
  readControlFile,
} from "./session-control-store/private-files.js";

const Identity = z
  .object({ credentialId: z.string().uuid(), computerId: z.string().uuid(), installationId: z.string().uuid() })
  .strict();
const Record = Identity.extend({
  version: z.literal(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
type ControlIdentity = z.infer<typeof Identity>;

/**
 * Deployment-side Cloud bootstrap authority. Issue/rotate/revoke are trusted orchestration methods,
 * never public Account or Sandbox HTTP endpoints. Only hashes are persisted on the Server volume.
 */
export class FileCloudControlAuthority implements TrustedCloudControlVerifier {
  constructor(
    readonly options: { root: string; now?: () => number; onRevoked?: (identity: ControlIdentity) => Promise<void> },
  ) {}
  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  async issue(input: {
    computerId: string;
    installationId: string;
    ttlMs?: number;
  }): Promise<ControlIdentity & { credential: string; expiresAt: string }> {
    const ttl = input.ttlMs ?? 3_600_000;
    if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 86_400_000)
      throw new Error("Invalid Cloud control lifetime");
    await ensureControlDirectory(this.options.root);
    await this.pruneExpired();
    if ((await controlRecords(this.options.root, ".control.json", 1024)).length >= 1024)
      throw new Error("Cloud control authority capacity exceeded");
    const identity = Identity.parse({
      credentialId: randomUUID(),
      computerId: input.computerId,
      installationId: input.installationId,
    });
    const secret = `${identity.credentialId}.${randomBytes(32).toString("base64url")}`;
    const record = Record.parse({
      ...identity,
      version: 1,
      tokenHash: hash(secret),
      issuedAt: new Date(this.#now()).toISOString(),
      expiresAt: new Date(this.#now() + ttl).toISOString(),
    });
    if (!(await createControlFile(this.#path(identity.credentialId), JSON.stringify(record))))
      throw new Error("Cloud control issuance conflict");
    return { ...identity, credential: `otcloud-control.${secret}`, expiresAt: record.expiresAt };
  }

  async verifyControlCredential(
    credential: string,
  ): Promise<(TrustedCloudControlIdentity & ControlIdentity) | undefined> {
    const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(credential);
    if (!match?.[1]) return undefined;
    const record = await this.#read(match[1]);
    if (!record || !timingSafeEqual(Buffer.from(record.tokenHash, "hex"), Buffer.from(hash(credential), "hex")))
      return undefined;
    return Identity.parse({
      credentialId: record.credentialId,
      computerId: record.computerId,
      installationId: record.installationId,
    });
  }

  /** Re-read on control frames and data requests; copied old credentials cannot survive revocation. */
  async isActive(input: ControlIdentity): Promise<boolean> {
    const identity = Identity.safeParse(input);
    if (!identity.success) return false;
    const record = await this.#read(identity.data.credentialId);
    return (
      !!record &&
      record.computerId === identity.data.computerId &&
      record.installationId === identity.data.installationId
    );
  }

  async revoke(credentialId: string): Promise<void> {
    const record = await this.#read(credentialId);
    if (!record) return;
    await createControlFile(
      join(this.options.root, `${record.credentialId}.revoked.json`),
      JSON.stringify({ revokedAt: new Date(this.#now()).toISOString() }),
    );
    await this.options.onRevoked?.({
      credentialId: record.credentialId,
      computerId: record.computerId,
      installationId: record.installationId,
    });
  }

  /** Bounded retention: expired credentials can never authenticate again; retain live revocations. */
  async pruneExpired(): Promise<number> {
    await ensureControlDirectory(this.options.root);
    let removed = 0;
    for (const name of await controlRecords(this.options.root, ".control.json", 1024)) {
      const path = join(this.options.root, name);
      const raw = await readControlFile(path);
      if (raw === undefined) continue;
      const record = Record.parse(JSON.parse(raw));
      if (Date.parse(record.expiresAt) > this.#now()) continue;
      const revocation = join(this.options.root, `${record.credentialId}.revoked.json`);
      if (await readControlFile(revocation)) await unlink(revocation);
      await unlink(path);
      removed++;
    }
    return removed;
  }

  /** Issue first so the trusted controller can reconnect, then explicitly revoke its predecessor. */
  async rotate(credentialId: string): Promise<ControlIdentity & { credential: string; expiresAt: string }> {
    const record = await this.#read(credentialId);
    if (!record) throw new Error("Cloud control credential is inactive");
    return this.issue({ computerId: record.computerId, installationId: record.installationId });
  }

  #path(credentialId: string): string {
    const id = z.string().uuid().parse(credentialId);
    return join(this.options.root, `${id}.control.json`);
  }
  async #read(credentialId: string) {
    if (!z.string().uuid().safeParse(credentialId).success) return undefined;
    await ensureControlDirectory(this.options.root);
    const raw = await readControlFile(this.#path(credentialId));
    if (!raw || (await readControlFile(join(this.options.root, `${credentialId}.revoked.json`)))) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Cloud control authority record");
    }
    const parsed = Record.safeParse(data);
    if (!parsed.success || parsed.data.credentialId !== credentialId)
      throw new Error("Invalid Cloud control authority record");
    if (Date.parse(parsed.data.issuedAt) > this.#now() || Date.parse(parsed.data.expiresAt) <= this.#now())
      return undefined;
    return parsed.data;
  }
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
