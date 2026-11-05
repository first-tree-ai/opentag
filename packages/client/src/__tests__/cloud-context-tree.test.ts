import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCloudContextTree } from "../runner/cloud-context-tree.js";
import { managedAgentSlug } from "../runtime/managed-instructions.js";

const roots: string[] = [];
const GRANT = { GH_TOKEN: "execution", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" };
const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
async function fixture() {
  const workspace = await temporaryDirectory("ct-cloud-");
  const projectRoot = join(workspace, ".opentag/context-tree/project");
  const treeRoot = join(workspace, ".opentag/context-tree/home/.context-tree/snapshots/commit/docs");
  await mkdir(treeRoot, { recursive: true });
  const input = {
    workspace,
    contextTrees: [source],
    environment: GRANT,
    path: process.env.PATH ?? "",
    scratch: join(workspace, "scratch"),
  };
  const pack = { root: workspace, cliPath: join(workspace, "cli.mjs"), skillsPath: workspace };
  return { workspace, projectRoot, treeRoot, input, pack };
}
it("saves the selection and writes the shim without syncing or touching repository configuration", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, ".context-tree.json"), "repository owned");
  const other = { ...source, path: "notes" };
  const result = await prepareCloudContextTree(
    { ...f.input, contextTrees: [source, other] },
    { contextTreePackage: f.pack },
  );
  expect(result.status).toEqual({
    status: "configured",
    connections: [
      { ...source, status: "available", projectPath: f.projectRoot },
      { ...other, status: "available", projectPath: f.projectRoot },
    ],
  });
  expect(JSON.parse(await readFile(join(f.projectRoot, ".context-tree.json"), "utf8")).trees).toEqual([source, other]);
  expect(await readFile(join(f.workspace, ".context-tree.json"), "utf8")).toBe("repository owned");
  if (!result.binDirectory) throw new Error("Missing shim");
  const shim = await readFile(join(result.binDirectory, "context-tree"), "utf8");
  expect(shim).toContain(`HOME='${join(f.workspace, ".opentag/context-tree/home")}'`);
  expect(shim).not.toContain(GRANT.GH_TOKEN);
});
it("returns the same status for every preparation of an unchanged selection", async () => {
  const f = await fixture();
  const first = await prepareCloudContextTree(f.input, { contextTreePackage: f.pack });
  const second = await prepareCloudContextTree(
    { ...f.input, environment: { ...GRANT, GH_TOKEN: "next-execution" } },
    { contextTreePackage: f.pack },
  );
  expect(second).toEqual(first);
});
it("reports a missing package as unavailable without a shim", async () => {
  const f = await fixture();
  const result = await prepareCloudContextTree(f.input, { contextTreePackage: null });
  expect(result.status).toMatchObject({ connections: [{ status: "unavailable", reason: "PACKAGE_MISSING" }] });
  expect(result.binDirectory).toBeUndefined();
});
it("revokes selection without deleting cached files or exposing a CLI", async () => {
  const f = await fixture();
  const result = await prepareCloudContextTree({ ...f.input, environment: {} }, { contextTreePackage: f.pack });
  expect(result.status).toMatchObject({ connections: [{ reason: "GITHUB_PERMISSION" }] });
  expect(result.binDirectory).toBeUndefined();
  expect(JSON.parse(await readFile(join(f.projectRoot, ".context-tree.json"), "utf8")).trees).toEqual([]);
  await expect(access(f.treeRoot)).resolves.toBeUndefined();
});
it("reports an aborted preparation as a timeout without a shim", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await prepareCloudContextTree(
    { ...f.input, signal: controller.signal },
    { contextTreePackage: f.pack },
  );
  expect(result.status).toMatchObject({ connections: [{ status: "unavailable", reason: "TIMEOUT" }] });
  expect(result.binDirectory).toBeUndefined();
  await expect(access(join(f.input.scratch, "context-tree-bin"))).rejects.toMatchObject({ code: "ENOENT" });
});

describe("managedAgentSlug", () => {
  it.each([
    ["You run inside OpenTag.\n\nOpenTag Agent slug: tree-agent", "tree-agent"],
    ["OpenTag Agent slug: a1\nTrailing line.", "a1"],
    ["OpenTag Agent slug: Tree-Agent", "Tree-Agent"],
    ["OpenTag Agent slug: 研发助理-2", "研发助理-2"],
    ["OpenTag Agent slug: -leading", undefined],
    ["OpenTag Agent slug: not a slug!", undefined],
    ["no slug here", undefined],
    ["", undefined],
  ])("extracts from %j", (platform, expected) => {
    expect(managedAgentSlug(platform)).toBe(expected);
  });
});
