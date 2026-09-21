import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const leaseMocks = vi.hoisted(() => ({
  acquireProcessFileLease: vi.fn(),
  inspectProcessFileLease: vi.fn(),
}));

vi.mock("../core/daemon/process-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/daemon/process-lease.js")>()),
  acquireProcessFileLease: leaseMocks.acquireProcessFileLease,
  inspectProcessFileLease: leaseMocks.inspectProcessFileLease,
}));

import { DaemonOwnerStartupError, inspectDaemonOwner } from "../core/daemon/ownership.js";
import { ProcessLeaseUnverifiableError } from "../core/daemon/process-lease.js";
import { acquireServiceOperationLease } from "../core/daemon/service/shared.js";
import { DaemonServiceError } from "../core/daemon/service/types.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(path);
  return path;
}

describe("daemon owner inspection error mapping", () => {
  it("maps an unverifiable lease holder to an UNVERIFIABLE startup error", async () => {
    const cause = new ProcessLeaseUnverifiableError("Cannot verify whether process 42 still owns owner.json");
    leaseMocks.inspectProcessFileLease.mockRejectedValue(cause);
    const error = await inspectDaemonOwner(await temporaryDirectory("opentag-owner-unverifiable-")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonOwnerStartupError);
    expect(error).toMatchObject({ code: "UNVERIFIABLE", message: cause.message, cause });
  });

  it("wraps non-Error rejections and passes Error rejections through", async () => {
    leaseMocks.inspectProcessFileLease.mockRejectedValueOnce("disk on fire");
    await expect(inspectDaemonOwner(await temporaryDirectory("opentag-owner-string-"))).rejects.toThrow(
      new Error("disk on fire"),
    );
    const plain = new Error("EIO");
    leaseMocks.inspectProcessFileLease.mockRejectedValueOnce(plain);
    await expect(inspectDaemonOwner(await temporaryDirectory("opentag-owner-plain-"))).rejects.toBe(plain);
  });
});

describe("service operation lease error mapping", () => {
  it("maps an unverifiable lease to a CONFIGURATION service error", async () => {
    const cause = new ProcessLeaseUnverifiableError("Cannot verify whether process 42 still owns the service lease");
    leaseMocks.acquireProcessFileLease.mockRejectedValue(cause);
    const error = await acquireServiceOperationLease(await temporaryDirectory("opentag-service-lease-")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonServiceError);
    expect(error).toMatchObject({ code: "CONFIGURATION", message: cause.message, cause });
  });

  it("rethrows unexpected lease failures unchanged", async () => {
    const unexpected = new Error("EACCES");
    leaseMocks.acquireProcessFileLease.mockRejectedValue(unexpected);
    await expect(acquireServiceOperationLease(await temporaryDirectory("opentag-service-lease-"))).rejects.toBe(
      unexpected,
    );
  });
});
