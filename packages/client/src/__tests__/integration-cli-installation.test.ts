import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeIntegrationCliInstallations } from "../runtime/integration-cli-installation.js";
import * as providerDetector from "../runtime/provider-cli/detector.js";
import * as providerProbe from "../runtime/provider-cli/probe.js";
import * as selectionStore from "../runtime/provider-cli/selection-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("Integration CLI install-only discovery", () => {
  it("reports a canonical ordinary executable found on caller PATH", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    const executable = join(bin, "lark-cli");
    await mkdir(bin);
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

    await expect(probeIntegrationCliInstallations(isolatedProbe(root, bin))).resolves.toEqual([
      {
        cli: "feishu",
        displayName: "Lark CLI",
        path: await realpath(executable),
        source: "caller-path",
        status: "installed",
      },
      { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
    ]);
  });

  it("reports a missing Integration CLI as not-installed", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    await mkdir(bin);

    await expect(probeIntegrationCliInstallations(isolatedProbe(root, bin))).resolves.toEqual([
      { cli: "feishu", displayName: "Lark CLI", status: "not-installed" },
      { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
    ]);
  });

  it("uses the account home to reject protected macOS candidates before inspecting them", async () => {
    const accountHome = "/Users/opentag-account";
    const callerHome = "/Users/opentag-caller";
    const protectedBin = join(accountHome, "Desktop", "bin");
    const accessSpy = vi.fn(async () => {
      throw new Error("protected candidate must not be accessed");
    });
    const realpathSpy = vi.fn(async () => {
      throw new Error("protected candidate must not be resolved");
    });
    const statSpy = vi.fn(async () => {
      throw new Error("protected candidate must not be stat-ed");
    });

    await expect(
      probeIntegrationCliInstallations({
        access: accessSpy,
        accountHome,
        desktopAppDirs: () => [],
        environment: { HOME: callerHome, PATH: protectedBin },
        platform: "darwin",
        realpath: realpathSpy,
        stat: statSpy,
        wellKnownDirs: () => [],
      }),
    ).resolves.toEqual([
      { cli: "feishu", displayName: "Lark CLI", status: "not-installed" },
      { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
    ]);
    expect(accessSpy).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("finds an OpenTag-managed launcher at the reviewed account-global path", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "empty-bin");
    const managedBin = join(root, ".opentag", "provider-cli", "bin");
    const executable = join(managedBin, "lark-cli");
    await mkdir(bin);
    await mkdir(managedBin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

    await expect(
      probeIntegrationCliInstallations({
        accountHome: root,
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        environment: { HOME: root, PATH: bin },
        home: root,
        platform: "linux",
      }),
    ).resolves.toEqual([
      {
        cli: "feishu",
        displayName: "Lark CLI",
        path: await realpath(executable),
        source: "well-known",
        status: "installed",
      },
      { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
    ]);
  });

  it("reports the canonical realpath through a symlink", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    const alias = join(root, "alias");
    await mkdir(bin);
    await mkdir(alias);
    const executable = join(bin, "slack");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await symlink(executable, join(alias, "slack"));

    await expect(probeIntegrationCliInstallations(isolatedProbe(root, alias))).resolves.toEqual([
      { cli: "feishu", displayName: "Lark CLI", status: "not-installed" },
      {
        cli: "slack",
        displayName: "Slack CLI",
        path: await realpath(executable),
        source: "caller-path",
        status: "installed",
      },
    ]);
  });

  it("does not treat Codex desktop-app locations as Integration CLI sources", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    const desktop = join(root, "desktop");
    await mkdir(bin);
    await mkdir(desktop);
    await writeFile(join(desktop, "lark-cli"), "#!/bin/sh\n", { mode: 0o700 });

    await expect(
      probeIntegrationCliInstallations({
        ...isolatedProbe(root, bin),
        desktopAppDirs: () => [desktop],
      }),
    ).resolves.toEqual([
      { cli: "feishu", displayName: "Lark CLI", status: "not-installed" },
      { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
    ]);
  });

  it("does not execute the CLI, inspect auth or selection, or access the network", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    const sentinel = join(root, "executed");
    const lark = join(bin, "lark-cli");
    const slack = join(bin, "slack");
    await writeFile(lark, `#!/bin/sh\ntouch "${sentinel}"\necho 'lark-cli version 1.0.92'\n`, { mode: 0o700 });
    await writeFile(slack, `#!/bin/sh\ntouch "${sentinel}"\necho 'Using slack v4.7.0'\n`, { mode: 0o700 });
    await chmod(lark, 0o700);
    await chmod(slack, 0o700);
    await writeFile(join(root, "credentials.json"), '{"token":"secret"}\n', { mode: 0o600 });
    await writeFile(join(root, "selection.json"), '{"executablePath":"/opt/managed/lark-cli"}\n', { mode: 0o600 });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const probeSpy = vi.spyOn(providerProbe, "probeProviderCliExecutable");
    const detectSpy = vi.spyOn(providerDetector, "detectProviderCliCandidates");
    const selectionSpy = vi.spyOn(selectionStore, "readProviderCliSelection");

    const result = await probeIntegrationCliInstallations(isolatedProbe(root, bin));

    expect(result).toEqual([
      {
        cli: "feishu",
        displayName: "Lark CLI",
        path: await realpath(lark),
        source: "caller-path",
        status: "installed",
      },
      {
        cli: "slack",
        displayName: "Slack CLI",
        path: await realpath(slack),
        source: "caller-path",
        status: "installed",
      },
    ]);
    await expect(sentinelExists(sentinel)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(detectSpy).not.toHaveBeenCalled();
    expect(selectionSpy).not.toHaveBeenCalled();
  });
});

function isolatedProbe(home: string, path: string) {
  return {
    candidateAllowed: () => true,
    desktopAppDirs: () => [],
    environment: { HOME: home, PATH: path },
    home,
    platform: "linux" as const,
    wellKnownDirs: () => [],
  };
}

async function sentinelExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-integration-cli-installation-"));
  temporaryRoots.push(root);
  return root;
}
