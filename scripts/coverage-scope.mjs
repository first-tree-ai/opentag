/**
 * What unit coverage measures: the one definition both the measurement (`unit-coverage.mjs`,
 * `vitest.coverage.config.ts`) and the patch gate (`unit-coverage-gate.mjs`) read.
 *
 * The gate used to keep its own list of which changed files to judge. It drifted from what the
 * coverage run instruments, so the gate blamed lines in files no report could ever contain (test
 * helpers, smoke harnesses, tooling config) as "missing coverage entry", which no test could fix.
 * With one scope, a file the gate judges is a file the run measures, and a measured file that comes
 * back without an entry really did go unmeasured.
 */

/**
 * Each Vitest project alongside the workspace source roots its suite is the only one able to execute.
 *
 * `root` mirrors that project's own `root` in `vitest.coverage.config.ts`, because a `coverage.include`
 * glob is resolved against it -- see `projectCoverageIncludes` in `unit-coverage.mjs`. `sources` lists
 * every measured source root of the workspace, not only `src`: verification scripts under a package's
 * `scripts` directory are executable code too.
 *
 * `workers` overrides the config's default worker count for a project whose suite owns spawned-CLI
 * timing tests. `cli` and `client` assert on fixed windows around child processes - a 1000ms
 * `vi.waitFor` for a shell shim to write its marker, a 5000-15000ms test timeout - and both packages'
 * own `test` scripts already run with `--maxWorkers=1`. Measuring them at the config default while v8
 * instrumentation slows every process start failed those unchanged tests intermittently, so the runner
 * now reproduces each package's own condition. Includes, assertions, timeouts, floors and the patch
 * threshold stay exactly as they are.
 */
export const COVERAGE_PROJECTS = [
  { name: "cli", root: "apps/cli", sources: ["apps/cli/src"], workers: 1 },
  { name: "web", root: "apps/web", sources: ["apps/web/src"] },
  { name: "shared", root: "packages/shared", sources: ["packages/shared/src"] },
  { name: "skill-presets", root: "packages/skill-presets", sources: ["packages/skill-presets/src"] },
  { name: "mcp-presets", root: "packages/mcp-presets", sources: ["packages/mcp-presets/src"] },
  { name: "client", root: "packages/client", sources: ["packages/client/src"], workers: 1 },
  { name: "server", root: "packages/server", sources: ["packages/server/src", "packages/server/scripts"] },
];

/** Every measured source root of the repository, repository-relative. */
export const MEASURED_SOURCE_ROOTS = COVERAGE_PROJECTS.flatMap((project) => project.sources);

/** The extensions every measured root includes (`<root>/**\/*.{ts,tsx}`). */
export const MEASURED_SOURCE_EXTENSIONS = ["ts", "tsx"];

/** Paths inside a measured root that coverage deliberately leaves out, as `coverage.exclude` globs. */
export const MEASURED_SOURCE_EXCLUDES = ["**/src/__tests__/**", "**/src/smoke/**", "**/src/paraglide/**"];

const EXCLUDED_SEGMENT_PAIRS = MEASURED_SOURCE_EXCLUDES.map((pattern) => {
  const match = /^\*\*\/([^/*]+)\/([^/*]+)\/\*\*$/.exec(pattern);
  if (!match) throw new Error(`Unsupported coverage exclude pattern: ${pattern}`);
  return [match[1], match[2]];
});

function normalizePath(value) {
  const path = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function isExcluded(segments) {
  return EXCLUDED_SEGMENT_PAIRS.some(([parent, child]) =>
    segments.some((segment, index) => segment === parent && segments[index + 1] === child),
  );
}

/** Whether a path lies inside one of the measured workspaces, measured or not. */
export function isInsideMeasuredProject(value) {
  const path = normalizePath(value);
  return COVERAGE_PROJECTS.some((project) => path.startsWith(`${project.root}/`));
}

/**
 * Whether the coverage run instruments this repository-relative path: inside a measured root, with a
 * measured extension, outside the deliberate excludes, and neither a test file (Vitest never measures
 * the files it runs as tests) nor a declaration file (which compiles to nothing).
 */
export function isMeasuredSourcePath(value) {
  const path = normalizePath(value);
  if (!MEASURED_SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`))) return false;
  const segments = path.split("/");
  if (segments.includes("..") || isExcluded(segments)) return false;
  const name = segments.at(-1) ?? "";
  if (/\.d\.tsx?$/.test(name)) return false;
  if (/\.(?:test|spec)\.tsx?$/.test(name)) return false;
  return MEASURED_SOURCE_EXTENSIONS.some((extension) => name.endsWith(`.${extension}`));
}
