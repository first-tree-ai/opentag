import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createLogger } from "../../observability/logger.js";
import { ensurePrivateDirectory, readSecureFile } from "../../storage/durable-file.js";
import { type ProviderCliAccountLayout, providerCliLockFilePath } from "./account-layout.js";
import type { ProviderCliProvider } from "./types.js";

/**
 * Account/provider exclusive mutation lock.
 *
 * Implemented inside `packages/client` on top of the secure durable-file primitives;
 * it deliberately does not depend on the daemon process lease in `apps/cli`. The lock
 * is an `O_CREAT | O_EXCL` file under the account-global state directory. A stale lock
 * whose holder process is gone is broken; a live holder fails the operation as busy.
 */

export class ProviderCliLockBusyError extends Error {
  override readonly name = "ProviderCliLockBusyError";
  constructor(provider: ProviderCliProvider) {
    super(`Another OpenTag process is modifying the ${provider} Provider CLI`);
  }
}

export interface ProviderCliLockDeps {
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Total acquire attempts before reporting busy. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const logger = createLogger("runtime-provider-cli-lock");

interface LockRecord {
  readonly pid: number;
  readonly token: string;
}

function parseLockRecord(content: string): LockRecord | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.token !== "string" ||
      record.token.length === 0
    ) {
      return undefined;
    }
    return { pid: record.pid, token: record.token };
  } catch (error) {
    logger.debug({ code: "lock_record_invalid", error: String(error) }, "Provider CLI lock record was invalid");
    return undefined;
  }
}

export async function withProviderCliLock<T>(
  layout: ProviderCliAccountLayout,
  provider: ProviderCliProvider,
  run: () => Promise<T>,
  deps: ProviderCliLockDeps = {},
): Promise<T> {
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 50;
  const retryDelayMs = deps.retryDelayMs ?? 100;

  await ensurePrivateDirectory(layout.root, layout.state);
  const lockPath = providerCliLockFilePath(layout, provider);
  const token = randomUUID();

  let acquired = false;
  for (let attempt = 0; attempt < maxAttempts && !acquired; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token } satisfies LockRecord), "utf8");
      await handle.sync();
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readSecureFile(lockPath).catch((readError: unknown) => {
        logger.debug({ code: "lock_read_failed", error: String(readError) }, "Provider CLI lock read failed");
        return undefined;
      });
      const record = existing === undefined ? undefined : parseLockRecord(existing);
      // A missing, malformed, or dead-holder lock is stale and may be broken.
      if (!record || !isAlive(record.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt + 1 < maxAttempts) await sleep(retryDelayMs);
    } finally {
      await handle?.close();
    }
  }
  if (!acquired) throw new ProviderCliLockBusyError(provider);

  try {
    return await run();
  } finally {
    // Only release the lock this operation still owns.
    const current = await readSecureFile(lockPath).catch((error: unknown) => {
      logger.debug({ code: "lock_release_read_failed", error: String(error) }, "Provider CLI lock release read failed");
      return undefined;
    });
    const record = current === undefined ? undefined : parseLockRecord(current);
    if (record?.token === token) {
      await rm(lockPath, { force: true });
    }
  }
}
