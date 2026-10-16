#!/usr/bin/env node
/**
 * `pnpm catalog:add` — scaffold a marketplace catalog entry from a live MCP endpoint.
 *
 * It probes the endpoint, prints the YAML entry it would add together with the facts it found, and
 * with `--write` appends the entry to `mcp-catalog.yaml`. It never fabricates a credential and never
 * writes the generated module: run `pnpm catalog:generate` after reviewing the entry.
 */
import { appendFile, copyFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkOutboundUrl } from "@opentag/shared";
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "../mcp-catalog.gen.js";
import { type ScaffoldInput, scaffoldEntry } from "./entry.js";
import { type McpProbeResult, type ProbeAuthKind, probeMcpEndpoint } from "./probe.js";

const USAGE = `Usage: pnpm catalog:add --url <endpoint> [options]

  --url <url>            the remote Streamable HTTP MCP endpoint (required)
  --id <slug>            entry id and definition name (default: derived from serverInfo)
  --category <id>        a category id from mcp-categories.yaml
  --title <text>         card title, English (default: serverInfo.title)
  --title-zh <text>      card title, Chinese
  --description <text>   card description, English
  --description-zh <text>
  --website <url>        the provider's site
  --auth <kind>          override the probed method: oauth | bearer | none
  --order <n>            position within the category (default: last + 10)
  --icon-file <path>     copy this SVG or PNG into icons/ as <id>.<ext>
  --write                append the entry to mcp-catalog.yaml (default: print only)
  --json                 print a machine-readable report
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function authOf(value: string | undefined): ProbeAuthKind | undefined {
  if (value === undefined) return undefined;
  if (value === "oauth" || value === "bearer" || value === "none") return value;
  return fail(`--auth must be oauth, bearer, or none; got "${value}"`);
}

type Values = ReturnType<typeof parseCli>;

function parseCli() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      id: { type: "string" },
      category: { type: "string" },
      title: { type: "string" },
      "title-zh": { type: "string" },
      description: { type: "string" },
      "description-zh": { type: "string" },
      website: { type: "string" },
      auth: { type: "string" },
      order: { type: "string" },
      "icon-file": { type: "string" },
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return values;
}

/** Map the flags onto the scaffold input, leaving unset flags absent so the probe's facts apply. */
function toScaffoldInput(values: Values, url: string, probe: Extract<McpProbeResult, { ok: true }>): ScaffoldInput {
  const order = values.order === undefined ? undefined : Number(values.order);
  if (order !== undefined && !Number.isFinite(order)) fail("--order must be a number");
  const optional: Partial<Record<keyof ScaffoldInput, string | number | ProbeAuthKind | undefined>> = {
    id: values.id,
    category: values.category,
    titleEn: values.title,
    titleZh: values["title-zh"],
    descriptionEn: values.description,
    descriptionZh: values["description-zh"],
    website: values.website,
    authKind: authOf(values.auth),
    order,
  };
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined));
  return { url, probe, ...present };
}

function report(
  values: Values,
  scaffold: { id: string; yaml: string },
  probe: Extract<McpProbeResult, { ok: true }>,
  todos: readonly string[],
): void {
  if (values.json) {
    const summary = {
      id: scaffold.id,
      written: values.write,
      evidence: probe.evidence,
      tools: probe.toolNames,
      todos,
      yaml: scaffold.yaml,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  process.stdout.write(`${scaffold.yaml}\n`);
  process.stdout.write(`probe: ${probe.evidence}\n`);
  process.stdout.write(
    values.write ? "written to packages/mcp-presets/mcp-catalog.yaml\n" : "dry run: pass --write to append it\n",
  );
  if (todos.length > 0)
    process.stdout.write(`\nReview before committing:\n${todos.map((todo) => `  - ${todo}`).join("\n")}\n`);
  process.stdout.write("\nThen run: pnpm catalog:generate\n");
}

async function main(): Promise<void> {
  const values = parseCli();
  if (values.help || values.url === undefined) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const verdict = checkOutboundUrl(values.url, { allowLoopback: false });
  if ("failure" in verdict) fail(`${values.url}: ${verdict.failure.message}`);
  if (verdict.url.protocol !== "https:") fail("the catalog lists https endpoints only");
  const url = verdict.url.toString();

  const probe = await probeMcpEndpoint(url);
  if (!probe.ok) fail(probe.reason);

  const scaffold = scaffoldEntry(toScaffoldInput(values, url, probe), MCP_CATALOG_ENTRIES, MCP_CATALOG_CATEGORIES);

  let yaml = scaffold.yaml;
  let todos = scaffold.todos;
  const iconSource = values["icon-file"];
  if (iconSource !== undefined) {
    const iconFile = `${scaffold.id}.${iconSource.toLowerCase().endsWith(".png") ? "png" : "svg"}`;
    await copyFile(iconSource, new URL(`../../icons/${iconFile}`, import.meta.url));
    yaml = yaml.replace(`icon: ${scaffold.iconFile}`, `icon: ${iconFile}`);
    todos = todos.filter((todo) => !todo.startsWith("icon:"));
  }
  if (values.write) await appendFile(new URL("../../mcp-catalog.yaml", import.meta.url), `\n${yaml}`);
  report(values, { id: scaffold.id, yaml }, probe, todos);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
