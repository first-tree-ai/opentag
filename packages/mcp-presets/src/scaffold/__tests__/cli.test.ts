import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../../mcp-catalog.gen.js";
import { runCli } from "../cli.js";
import { anonymousFetch } from "./support.js";

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
