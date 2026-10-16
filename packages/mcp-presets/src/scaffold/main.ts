#!/usr/bin/env node
/**
 * `pnpm catalog:add` — scaffold a marketplace catalog entry from a live MCP endpoint.
 *
 * It probes the endpoint, prints the YAML entry it would add together with the facts it found, and
 * with `--write` appends the entry to `mcp-catalog.yaml`. It never fabricates a credential and never
 * writes the generated module: run `pnpm catalog:generate` after reviewing the entry.
 */
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../mcp-catalog.gen.js";
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  packageDir: new URL("../../", import.meta.url),
  entries: MCP_CATALOG_ENTRIES,
  categories: MCP_CATALOG_CATEGORIES,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
