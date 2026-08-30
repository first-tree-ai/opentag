import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { probeProviderCliExecutable, requireProviderCliCatalogEntry } from "../index.js";

describe("probeProviderCliExecutable", () => {
  it("isolates provider config and credentials in a cleaned private home", async () => {
    const entry = requireProviderCliCatalogEntry("feishu");
    const observedHomes: string[] = [];
    const result = await probeProviderCliExecutable("/fixture/lark-cli", entry, {
      execFile: async (_file, args, options) => {
        const probeHome = options.env.HOME;
        expect(probeHome).toBeTruthy();
        if (!probeHome) throw new Error("missing probe HOME");
        observedHomes.push(probeHome);
        expect(options.env.PATH?.split(":")[0]).toContain("node");
        expect(options.env.XDG_CONFIG_HOME).toBe(`${probeHome}/config`);
        expect(options.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBe("1");
        return args.includes("--version")
          ? { stdout: `lark-cli version ${entry.version}\n`, stderr: "" }
          : { stdout: "surface-ok\n", stderr: "" };
      },
    });

    expect(result).toEqual({ status: "ok", version: entry.version });
    expect(new Set(observedHomes).size).toBe(1);
    await expect(access(observedHomes[0] ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Slack update suppression and a private config directory", async () => {
    const entry = requireProviderCliCatalogEntry("slack");
    const invocations: string[][] = [];
    const result = await probeProviderCliExecutable("/fixture/slack", entry, {
      execFile: async (_file, args, options) => {
        invocations.push([...args]);
        const configIndex = args.indexOf("--config-dir");
        expect(args).toContain("--skip-update");
        expect(configIndex).toBeGreaterThanOrEqual(0);
        expect(args[configIndex + 1]).toBe(`${options.env.HOME}/slack`);
        return args.includes("version")
          ? { stdout: `Using slack v${entry.version}\n`, stderr: "" }
          : { stdout: "surface-ok\n", stderr: "" };
      },
    });

    expect(result).toEqual({ status: "ok", version: entry.version });
    expect(invocations).toHaveLength(2);
  });
});
