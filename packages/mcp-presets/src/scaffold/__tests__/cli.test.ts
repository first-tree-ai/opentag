import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { runCli } from "../cli.js";
import { anonymousFetch, legacyOnly } from "./support.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "catalog-add-"));
  await mkdir(join(dir, "icons"));
  await writeFile(join(dir, "mcp-catalog.yaml"), "# catalog\n");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[], fetchImpl = anonymousFetch()) =>
    runCli(args, {
      packageDir: pathToFileURL(`${dir}/`),
      entries: MCP_CATALOG_ENTRIES,
      categories: MCP_CATALOG_CATEGORIES,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      fetch: fetchImpl,
      lookup: async () => ["93.184.216.34"],
    });
  return { dir, out, err, run };
}

const category = MCP_CATALOG_CATEGORIES[0]?.id ?? "";

describe("catalog:add", () => {
  it("prints the entry as a dry run and leaves the catalog alone", async () => {
    const { dir, out, run } = await fixture();
    expect(await run(["--url", "https://mcp.acme.test/mcp", "--category", category])).toBe(0);
    expect(out.join("")).toContain("id: mcp/acme");
    expect(out.join("")).toContain("dry run");
    expect(await readFile(join(dir, "mcp-catalog.yaml"), "utf8")).toBe("# catalog\n");
  });

  it("appends the entry and copies the icon with --write", async () => {
    const { dir, out, run } = await fixture();
    const icon = join(dir, "source.png");
    await writeFile(icon, "png");
    expect(
      await run(["--url", "https://mcp.acme.test/mcp", "--category", category, "--write", "--icon-file", icon]),
    ).toBe(0);
    const yaml = await readFile(join(dir, "mcp-catalog.yaml"), "utf8");
    expect(yaml).toContain("icon: acme.png");
    expect(await readFile(join(dir, "icons", "acme.png"), "utf8")).toBe("png");
    expect(out.join("")).not.toContain("icon: add");
  });

  it("does not copy the icon on a dry run", async () => {
    const { dir, out, run } = await fixture();
    const icon = join(dir, "source.svg");
    await writeFile(icon, "svg");
    expect(await run(["--url", "https://mcp.acme.test/mcp", "--category", category, "--icon-file", icon])).toBe(0);
    expect(out.join("")).toContain("was not copied");
    await expect(readFile(join(dir, "icons", "acme.svg"), "utf8")).rejects.toThrow();
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const { dir, err } = await fixture();
    const code = await runCli(["--url", "https://mcp.acme.test/mcp", "--category", category], {
      packageDir: pathToFileURL(`${dir}/`),
      entries: MCP_CATALOG_ENTRIES,
      categories: MCP_CATALOG_CATEGORIES,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
      fetch: anonymousFetch(),
      lookup: async () => ["10.0.0.5"],
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("non-public");
    // There is no bypass flag: an unknown option is a usage error, not a way around the policy.
    expect(
      await runCli(["--url", "https://mcp.acme.test/mcp", "--category", category, "--skip-dns-check"], {
        packageDir: pathToFileURL(`${dir}/`),
        entries: MCP_CATALOG_ENTRIES,
        categories: MCP_CATALOG_CATEGORIES,
        stdout: () => undefined,
        stderr: () => undefined,
        fetch: anonymousFetch(),
        lookup: async () => ["10.0.0.5"],
      }),
    ).toBe(1);
  });

  it("does not persist an entry whose tool inventory is incomplete", async () => {
    const { dir, err, run } = await fixture();
    const broken = legacyOnly((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: { cursor?: string } };
      const ok = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      if (body.method === "initialize") return ok({ protocolVersion: "2025-06-18", serverInfo: { name: "Acme" } });
      if (body.method === "tools/list" && body.params?.cursor === undefined) {
        return ok({ tools: [{ name: "read", annotations: { readOnlyHint: true } }], nextCursor: "n" });
      }
      return body.method.startsWith("notifications/")
        ? new Response(null, { status: 202 })
        : new Response("", { status: 500 });
    }) as unknown as typeof fetch);
    const args = ["--url", "https://mcp.acme.test/mcp", "--category", category];
    expect(await run([...args, "--write"], broken)).toBe(1);
    expect(err.join("")).toContain("risk is unproven");
    expect(await readFile(join(dir, "mcp-catalog.yaml"), "utf8")).toBe("# catalog\n");
    expect(await run(args, broken)).toBe(0); // a dry run still prints, flagged for review
  });

  it("requires --category", async () => {
    const { err, run } = await fixture();
    expect(await run(["--url", "https://mcp.acme.test/mcp"])).toBe(1);
    expect(err.join("")).toContain("--category");
  });

  it("never replaces an existing icon and leaves the catalog untouched", async () => {
    const { dir, run } = await fixture();
    await writeFile(join(dir, "icons", "acme.png"), "original");
    const source = join(dir, "source.png");
    await writeFile(source, "replacement");
    expect(
      await run(["--url", "https://mcp.acme.test/mcp", "--category", category, "--write", "--icon-file", source]),
    ).toBe(1);
    expect(await readFile(join(dir, "icons", "acme.png"), "utf8")).toBe("original");
    expect(await readFile(join(dir, "mcp-catalog.yaml"), "utf8")).toBe("# catalog\n");
  });

  it("removes the icon it created when the catalog append fails", async () => {
    const { dir, run } = await fixture();
    await rm(join(dir, "mcp-catalog.yaml"));
    await mkdir(join(dir, "mcp-catalog.yaml")); // appending to a directory fails with EISDIR
    const source = join(dir, "source.png");
    await writeFile(source, "png");
    expect(
      await run(["--url", "https://mcp.acme.test/mcp", "--category", category, "--write", "--icon-file", source]),
    ).toBe(1);
    await expect(readFile(join(dir, "icons", "acme.png"), "utf8")).rejects.toThrow();
  });

  it("prints JSON when asked", async () => {
    const { out, run } = await fixture();
    expect(await run(["--url", "https://mcp.acme.test/mcp", "--category", category, "--json"])).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ id: "acme", written: false, tools: 3 });
  });

  it("applies flag overrides", async () => {
    const { out, run } = await fixture();
    const args = [
      "--url",
      "https://mcp.acme.test/mcp",
      "--category",
      category,
      "--id",
      "acme-docs",
      "--name",
      "Acme",
      "--name-zh",
      "极致",
      "--summary",
      "S",
      "--summary-zh",
      "摘要",
      "--homepage",
      "https://acme.test",
      "--auth",
      "bearer",
      "--order",
      "5",
    ];
    expect(await run(args)).toBe(0);
    const text = out.join("");
    expect(text).toContain("id: mcp/acme-docs");
    expect(text).toContain("default_kind: bearer");
    expect(text).toContain("order: 5");
  });

  it("reports usage errors with exit code 1", async () => {
    const { err, run } = await fixture();
    expect(await run([])).toBe(1);
    expect(await run(["--help"])).toBe(0);
    expect(await run(["--url", "http://mcp.acme.test/mcp"])).toBe(1);
    expect(await run(["--url", "https://127.0.0.1/mcp"])).toBe(1);
    expect(await run(["--url", "https://mcp.acme.test/mcp", "--auth", "x"])).toBe(1);
    expect(await run(["--url", "https://mcp.acme.test/mcp", "--order", "x"])).toBe(1);
    expect(
      await run(
        ["--url", "https://mcp.acme.test/mcp"],
        (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      ),
    ).toBe(1);
    expect(err.length).toBeGreaterThanOrEqual(6);
  });
});
