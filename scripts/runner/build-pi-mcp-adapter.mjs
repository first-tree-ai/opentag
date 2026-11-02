import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { build } from "tsdown";
import { resolveInstalledDependencyPackage } from "../portable/runtime-dependencies.mjs";

export const PI_MCP_ADAPTER_RUNTIME_ENTRY = "opentag-runtime.mjs";

export async function buildPiMcpAdapter(packageDirectory, piPackageDirectory) {
  packageDirectory = realpathSync(packageDirectory);
  piPackageDirectory = realpathSync(piPackageDirectory);
  const manifest = join(piPackageDirectory, "package.json");
  const require = createRequire(manifest);
  const tui = resolveInstalledDependencyPackage(manifest, "@earendil-works/pi-tui");
  const entries = {
    "@earendil-works/pi-coding-agent": join(piPackageDirectory, "dist/index.js"),
    "@earendil-works/pi-tui": join(tui.root, "dist/index.js"),
    typebox: require.resolve("typebox"),
    "typebox/compile": require.resolve("typebox/compile"),
    "typebox/value": require.resolve("typebox/value"),
  };
  const paths = Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => {
      const path = relative(packageDirectory, entry).split(sep).join("/");
      return [name, path.startsWith(".") ? path : `./${path}`];
    }),
  );
  await build({
    config: false,
    tsconfig: false,
    entry: { "opentag-runtime": join(packageDirectory, "index.ts") },
    outDir: packageDirectory,
    clean: false,
    format: "esm",
    platform: "node",
    target: "node24",
    dts: false,
    sourcemap: false,
    report: false,
    logLevel: "silent",
    deps: { neverBundle: true },
    outputOptions: { paths },
  });
  return join(packageDirectory, PI_MCP_ADAPTER_RUNTIME_ENTRY);
}
