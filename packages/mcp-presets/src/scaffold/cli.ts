import { appendFile, copyFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkOutboundUrl } from "@opentag/shared";
import type { McpCatalogCategory, McpCatalogEntry } from "../mcp-catalog.gen.js";
import { type ScaffoldInput, scaffoldEntry } from "./entry.js";
import { type McpProbeResult, type ProbeAuthKind, probeMcpEndpoint } from "./probe.js";

export const USAGE = `Usage: pnpm catalog:add --url <endpoint> [options]

  --url <url>            the remote Streamable HTTP MCP endpoint (required)
  --id <slug>            entry slug and definition name (default: derived from serverInfo)
  --category <id>        a category id from mcp-categories.yaml
  --name <text>          card name, English (default: serverInfo.title or name)
  --name-zh <text>       card name, Chinese
  --summary <text>       card description, English
  --summary-zh <text>    card description, Chinese
  --homepage <url>       the provider's site
  --auth <kind>          override the probed method: oauth | bearer | none
  --order <n>            position within the category (default: last + 10)
  --icon-file <path>     copy this SVG or PNG into icons/ as <slug>.<ext>
  --write                append the entry to mcp-catalog.yaml (default: print only)
  --json                 print a machine-readable report
`;

export interface CliDeps {
  /** The `packages/mcp-presets` directory as a file URL ending in `/`. */
  readonly packageDir: URL;
  readonly entries: readonly McpCatalogEntry[];
  readonly categories: readonly McpCatalogCategory[];
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch?: typeof fetch;
}

class CliError extends Error {}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      url: { type: "string" },
      id: { type: "string" },
      category: { type: "string" },
      name: { type: "string" },
      "name-zh": { type: "string" },
      summary: { type: "string" },
      "summary-zh": { type: "string" },
      homepage: { type: "string" },
      auth: { type: "string" },
      order: { type: "string" },
      "icon-file": { type: "string" },
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values;
}

type Values = ReturnType<typeof parseCli>;
type OkProbe = Extract<McpProbeResult, { ok: true }>;

function authOf(value: string | undefined): ProbeAuthKind | undefined {
  if (value === undefined) return undefined;
  if (value === "oauth" || value === "bearer" || value === "none") return value;
  throw new CliError(`--auth must be oauth, bearer, or none; got "${value}"`);
}

/** Map the flags onto the scaffold input, leaving unset flags absent so the probe's facts apply. */
function toScaffoldInput(values: Values, url: string, probe: OkProbe): ScaffoldInput {
  const order = values.order === undefined ? undefined : Number(values.order);
  if (order !== undefined && !Number.isFinite(order)) throw new CliError("--order must be a number");
  const optional: Record<string, string | number | undefined> = {
    id: values.id,
    category: values.category,
    nameEn: values.name,
    nameZh: values["name-zh"],
    summaryEn: values.summary,
    summaryZh: values["summary-zh"],
    homepage: values.homepage,
    authKind: authOf(values.auth),
    order,
  };
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined));
  return { url, probe, ...present };
}

function render(values: Values, id: string, yaml: string, probe: OkProbe, todos: readonly string[]): string {
  if (values.json) {
    return `${JSON.stringify({ id, written: values.write, evidence: probe.evidence, tools: probe.tools.length, todos, yaml })}\n`;
  }
  return [
    `${yaml}\n`,
    `probe: ${probe.evidence}\n`,
    values.write ? "written to packages/mcp-presets/mcp-catalog.yaml\n" : "dry run: pass --write to append it\n",
    todos.length > 0 ? `\nReview before committing:\n${todos.map((todo) => `  - ${todo}`).join("\n")}\n` : "",
    "\nThen run: pnpm catalog:generate\n",
  ].join("");
}

async function execute(argv: readonly string[], deps: CliDeps): Promise<void> {
  const values = parseCli(argv);
  if (values.help || values.url === undefined) {
    deps.stdout(USAGE);
    if (!values.help) throw new CliError("--url is required");
    return;
  }

  const verdict = checkOutboundUrl(values.url, { allowLoopback: false });
  if ("failure" in verdict) throw new CliError(`${values.url}: ${verdict.failure.message}`);
  if (verdict.url.protocol !== "https:") throw new CliError("the catalog lists https endpoints only");
  const url = verdict.url.toString();

  const probe = await probeMcpEndpoint(url, deps.fetch === undefined ? {} : { fetch: deps.fetch });
  if (!probe.ok) throw new CliError(probe.reason);

  const scaffold = scaffoldEntry(toScaffoldInput(values, url, probe), deps.entries, deps.categories);
  let yaml = scaffold.yaml;
  let todos = scaffold.todos;
  const iconSource = values["icon-file"];
  if (iconSource !== undefined) {
    const iconFile = `${scaffold.id}.${iconSource.toLowerCase().endsWith(".png") ? "png" : "svg"}`;
    await copyFile(iconSource, new URL(`icons/${iconFile}`, deps.packageDir));
    yaml = yaml.replace(`icon: ${scaffold.iconFile}`, `icon: ${iconFile}`);
    todos = todos.filter((todo) => !todo.startsWith("icon:"));
  }
  if (values.write) await appendFile(new URL("mcp-catalog.yaml", deps.packageDir), `\n${yaml}`);
  deps.stdout(render(values, scaffold.id, yaml, probe, todos));
}

/** Run the command and return its exit code; every failure is reported on stderr, never thrown. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    await execute(argv, deps);
    return 0;
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
