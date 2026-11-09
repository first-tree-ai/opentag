/**
 * The benchmark's command line, parsed where it can be tested.
 *
 * The entry point used to read `process.argv` itself, and an absent flag made `indexOf` return -1 so
 * the value came from `argv[0]` — the Node binary. A wrong evidence directory written under the Node
 * installation is exactly the kind of failure an executed run catches and a type check does not, so the
 * parsing lives here with cases for every shape it accepts or refuses.
 */
export interface BenchmarkArgs {
  /** The evidence phase, which names `results-<phase>.json` and `explain/<phase>/`. */
  phase: string;
  /** Absolute directory the evidence is written to. */
  output: string;
}

export interface ParseArgsOptions {
  /** Used when `--output` is absent. */
  defaultOutput: string;
  /** Resolves a relative `--output` against the caller's directory. */
  resolvePath(path: string): string;
}

const PHASE = /^[a-z0-9-]+$/;

/** Read `--name value` pairs, refusing a flag that has no value and one this program does not know. */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const known = new Set(["--phase", "--output"]);
  const flags = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    if (!known.has(name)) throw new Error(`Unknown argument "${name}"; expected --phase and --output`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    flags.set(name, value);
  }
  return flags;
}

export function parseBenchmarkArgs(argv: readonly string[], options: ParseArgsOptions): BenchmarkArgs {
  const flags = parseFlags(argv);
  const phase = flags.get("--phase") ?? "";
  if (phase === "") throw new Error("Pass --phase <label>");
  if (!PHASE.test(phase)) throw new Error(`The phase "${phase}" must match ${PHASE.source}`);
  const output = flags.get("--output");
  return { phase, output: options.resolvePath(output ?? options.defaultOutput) };
}
