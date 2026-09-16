import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyIsolatedPiConfig, PI_CONFIG_WHITELIST, removeIsolatedPiConfig } from "../runner/config.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
describe("isolated Pi config copy", () => {
  it("copies only the whitelist and can filter a provider", async () => {
    const source = await temp("opentag-pi-cfg-src-");
    const destination = join(await temp("opentag-pi-cfg-dst-"), "pi");
    await writeFile(
      join(source, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key: "secret" }, openai: { type: "api_key", key: "other" } })}\n`,
    );
    await writeFile(
      join(source, "models.json"),
      `${JSON.stringify({
        models: [
          { id: "a", provider: "deepseek" },
          { id: "b", provider: "openai" },
        ],
      })}\n`,
    );
    await writeFile(join(source, "sessions.jsonl"), "nope\n");
    await writeFile(
      join(source, "settings.json"),
      `${JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-v4.1-flash-expires-on-0910", defaultThinkingLevel: "max", theme: "dark" })}\n`,
    );
    await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] });
    expect(PI_CONFIG_WHITELIST).toEqual(["auth.json", "models.json", "settings.json"]);
    const auth = JSON.parse(await readFile(join(destination, "auth.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(auth)).toEqual(["deepseek"]);
    const models = JSON.parse(await readFile(join(destination, "models.json"), "utf8")) as {
      models: Array<{ provider: string }>;
    };
    expect(models.models).toEqual([{ id: "a", provider: "deepseek" }]);
    expect(JSON.parse(await readFile(join(destination, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4.1-flash-expires-on-0910",
      defaultThinkingLevel: "max",
    });
    await expect(lstat(join(destination, "sessions.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink source and relative paths", async () => {
    const root = await temp("opentag-pi-cfg-link-");
    const real = join(root, "real");
    await mkdir(real);
    await symlink(real, join(root, "link"));
    await expect(
      copyIsolatedPiConfig({ source: join(root, "link"), destination: join(root, "dst"), providers: ["deepseek"] }),
    ).rejects.toThrow(/real directory/);
    await expect(
      copyIsolatedPiConfig({ source: "relative", destination: "/tmp/x", providers: ["deepseek"] }),
    ).rejects.toThrow(/absolute/);
    await expect(copyIsolatedPiConfig({ source: real, destination: join(root, "dst"), providers: [] })).rejects.toThrow(
      /provider filter/,
    );
  });

  it("rejects a preexisting destination, a planted destination symlink, and ancestor symlinks", async () => {
    const root = await temp("opentag-pi-cfg-pre-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    const outside = join(root, "outside.json");
    await writeFile(outside, "untouched\n");

    // Preexisting destination directory is rejected outright.
    const existing = join(root, "existing");
    await mkdir(existing);
    await expect(copyIsolatedPiConfig({ destination: existing, source, providers: ["deepseek"] })).rejects.toThrow(
      /fresh/,
    );

    // A planted destination symlink can never redirect writes outside.
    const planted = join(root, "planted");
    await symlink(outside, planted);
    await expect(copyIsolatedPiConfig({ destination: planted, source, providers: ["deepseek"] })).rejects.toThrow(
      /fresh/,
    );
    expect(await readFile(outside, "utf8")).toBe("untouched\n");

    // A symlinked destination parent is rejected even when the leaf is fresh.
    const realParent = join(root, "real-parent");
    await mkdir(realParent);
    const aliasParent = join(root, "alias-parent");
    await symlink(realParent, aliasParent);
    await expect(
      copyIsolatedPiConfig({ destination: join(aliasParent, "pi"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/real directory/);
  });

  it("rejects physical overlap with the source and shell-command indirections, cleaning partial copies", async () => {
    const root = await temp("opentag-pi-cfg-over-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    await expect(
      copyIsolatedPiConfig({ destination: join(source, "nested"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/overlaps/);

    const evil = join(root, "evil");
    await mkdir(evil);
    await writeFile(
      join(evil, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key: "!security find-generic-password" } })}\n`,
    );
    const destination = join(root, "dst");
    await expect(copyIsolatedPiConfig({ destination, source: evil, providers: ["deepseek"] })).rejects.toThrow(
      /shell-command credential indirection/,
    );
    // The rejected copy must not leave a partial destination behind.
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips whitelisted documents that are absent and removes copies on demand", async () => {
    const root = await temp("opentag-pi-cfg-sparse-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    const destination = join(root, "dst");
    await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] });
    // Only auth.json existed; the other whitelisted names are skipped, not invented.
    await expect(readdir(destination)).resolves.toEqual(["auth.json"]);
    await removeIsolatedPiConfig(destination);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a destination whose parent does not exist", async () => {
    const root = await temp("opentag-pi-cfg-noparent-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    await expect(
      copyIsolatedPiConfig({ destination: join(root, "missing", "dst"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/existing real directory/);
  });

  it("reports malformed JSON with the filename only, never source fragments", async () => {
    const root = await temp("opentag-pi-cfg-badjson-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), "canary1234567890\n");
    const destination = join(root, "dst");
    const failure = await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("auth.json is not valid JSON");
    expect((failure as Error).message).not.toContain("canary");
    expect((failure as Error).message).not.toContain("1234567890");
    // The rejected copy must not leave a partial destination behind.
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rebuilds models.json from recognized fields only, dropping secret-bearing extras", async () => {
    const root = await temp("opentag-pi-cfg-models-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(
      join(source, "models.json"),
      `${JSON.stringify({
        models: [
          { id: "keep", provider: "deepseek", contextWindow: 128000 },
          { id: "drop", provider: "openai" },
        ],
        providers: { deepseek: { baseUrl: "https://example.invalid" }, openai: { baseUrl: "https://other.invalid" } },
        telemetry: { endpoint: "https://example.invalid/t" },
        apiToken: "canary1234567890",
      })}\n`,
    );
    const destination = join(root, "dst");
    await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] });
    const raw = await readFile(join(destination, "models.json"), "utf8");
    expect(raw).not.toContain("canary1234567890");
    expect(raw).not.toContain("telemetry");
    expect(raw).not.toContain("other.invalid");
    const models = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(models).sort()).toEqual(["models", "providers"]);
    expect(models.models).toEqual([{ id: "keep", provider: "deepseek", contextWindow: 128000 }]);
    expect(models.providers).toEqual({ deepseek: { baseUrl: "https://example.invalid" } });
  });

  it.each([null, ["canary1234567890"], "canary1234567890", 1, true])(
    "rejects a non-object models.json document: %j",
    async (document) => {
      const root = await temp("opentag-pi-cfg-root-");
      const source = join(root, "src");
      const destination = join(root, "dst");
      await mkdir(source);
      await writeFile(join(source, "models.json"), JSON.stringify(document));
      await expect(copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] })).rejects.toThrow(
        "models.json must be a JSON object",
      );
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects malformed models.json shapes with fixed messages and no fragments", async () => {
    const root = await temp("opentag-pi-cfg-badmodels-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(
      join(source, "models.json"),
      `${JSON.stringify({ models: { deepseek: { id: "x" } }, canary: "canary1234567890" })}\n`,
    );
    const destination = join(root, "dst");
    const failure = await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/malformed models field/);
    expect((failure as Error).message).not.toContain("canary1234567890");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const second = join(root, "src2");
    await mkdir(second);
    await writeFile(join(second, "models.json"), `${JSON.stringify({ providers: ["deepseek"] })}\n`);
    await expect(
      copyIsolatedPiConfig({ destination: join(root, "dst2"), source: second, providers: ["deepseek"] }),
    ).rejects.toThrow(/malformed providers field/);
  });
});
