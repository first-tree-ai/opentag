import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_FILENAME = "workspace-contracts.json";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".turbo", "dist", "node_modules", "coverage"]);

export class WorkspaceContractError extends Error {
  constructor(violations) {
    super(`Workspace contract violations:\n${violations.join("\n")}`);
    this.name = "WorkspaceContractError";
    this.violations = violations;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath}: cannot read JSON (${reason})`);
  }
}

function toPosix(value) {
  return value.split("\\").join("/");
}

function parseWorkspacePatterns(yaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && line.length > 0 && !/^\s/.test(line) && !/^\s*#/.test(line)) {
      inPackages = false;
    }
    if (!inPackages) continue;
    const match = line.match(/^\s+-\s*(?:['"])?([^'"#]+?)(?:['"])?\s*(?:#.*)?$/);
    if (match?.[1].trim() && !match[1].includes(":")) {
      patterns.push(toPosix(match[1].trim()));
    }
  }
  return patterns;
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:[^/]+/)*";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$.*+()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

async function collectPackageJsonFiles(directory, rootDirectory, result = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await collectPackageJsonFiles(join(directory, entry.name), rootDirectory, result);
      }
    } else if (entry.isFile() && entry.name === "package.json") {
      result.push({
        directory: dirname(join(directory, entry.name)),
        workspacePath: toPosix(relative(rootDirectory, directory)),
      });
    }
  }
  return result;
}

async function discoverWorkspaces(rootDirectory, patterns) {
  const packageFiles = await collectPackageJsonFiles(rootDirectory, rootDirectory);
  const selected = new Map();
  const unmatchedPatterns = [];
  for (const pattern of patterns) {
    const matcher = globToRegExp(pattern.replace(/\/$/, ""));
    const matches = packageFiles.filter(({ workspacePath }) => matcher.test(workspacePath));
    if (matches.length === 0) unmatchedPatterns.push(pattern);
    for (const match of matches) selected.set(match.workspacePath, match);
  }
  return {
    unmatchedPatterns,
    workspaces: [...selected.values()].sort((left, right) => left.workspacePath.localeCompare(right.workspacePath)),
  };
}

function packageTargetIsInside(workspaceDirectory, candidatePath) {
  const path = resolve(candidatePath);
  const root = resolve(workspaceDirectory);
  return path === root || path.startsWith(`${root}/`);
}

async function collectSourceFiles(directory, result = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await collectSourceFiles(entryPath, result);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      result.push(entryPath);
    }
  }
  return result;
}

function collectModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [/\b(?:from|import)\s*["']([^"']+)["']/g, /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function exportKeys(exportsField) {
  if (typeof exportsField === "string" || Array.isArray(exportsField) || exportsField === null) return new Set(["."]);
  if (!exportsField || typeof exportsField !== "object") return new Set();
  return new Set(Object.keys(exportsField).filter((key) => key === "." || key.startsWith("./")));
}

function collectExportTargets(value, targets = []) {
  if (typeof value === "string") targets.push(value);
  else if (Array.isArray(value)) for (const item of value) collectExportTargets(item, targets);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectExportTargets(item, targets);
  return targets;
}

function rootExportValue(exportsField) {
  if (typeof exportsField === "string" || Array.isArray(exportsField) || exportsField === null) return exportsField;
  if (exportsField && typeof exportsField === "object" && Object.hasOwn(exportsField, ".")) return exportsField["."];
  return undefined;
}

function filesCoverTarget(files, target) {
  const normalizedTarget = target.replace(/^\.\//, "");
  return files.some((entry) => {
    if (typeof entry !== "string" || entry.startsWith("!")) return false;
    const normalizedEntry = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (normalizedEntry.includes("*")) return globToRegExp(normalizedEntry).test(normalizedTarget);
    return normalizedTarget === normalizedEntry || normalizedTarget.startsWith(`${normalizedEntry}/`);
  });
}

function isGeneratedPath(rootDirectory, filePath) {
  return toPosix(relative(rootDirectory, filePath))
    .split("/")
    .some((segment) => segment === "paraglide" || /(?:\.gen|\.generated)(?:\.|$)/.test(segment));
}

function contractAllowed(workspaceContract) {
  return new Set(workspaceContract.allowedWorkspaceDependencies ?? []);
}

function validateContractWorkspaceEntry(workspacePath, workspaceContract, names, violations) {
  if (isAbsolute(workspacePath) || workspacePath.split("/").some((segment) => segment === "." || segment === "..")) {
    violations.push(`${CONTRACT_FILENAME}: invalid workspace path "${workspacePath}"`);
  }
  if (!workspaceContract || typeof workspaceContract !== "object") {
    violations.push(`${CONTRACT_FILENAME}: contract for "${workspacePath}" must be an object`);
    return;
  }
  if (typeof workspaceContract.name !== "string" || workspaceContract.name.length === 0) {
    violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare a package name`);
  } else if (names.has(workspaceContract.name)) {
    violations.push(`${CONTRACT_FILENAME}: duplicate package name "${workspaceContract.name}"`);
  } else names.add(workspaceContract.name);
  if (!Array.isArray(workspaceContract.allowedWorkspaceDependencies)) {
    violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare allowedWorkspaceDependencies`);
  }
  for (const dependencyName of workspaceContract.allowedWorkspaceDependencies ?? []) {
    if (typeof dependencyName !== "string")
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" has a non-string dependency`);
    if (dependencyName === workspaceContract.name)
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" cannot depend on itself`);
  }
}

function validateContractConfiguration(contract, violations) {
  if (contract?.schemaVersion !== 1 || !contract.workspaces || typeof contract.workspaces !== "object") {
    violations.push(`${CONTRACT_FILENAME}: schemaVersion must be 1 and workspaces must be an object`);
    return;
  }
  const names = new Set();
  for (const [workspacePath, workspaceContract] of Object.entries(contract.workspaces)) {
    validateContractWorkspaceEntry(workspacePath, workspaceContract, names, violations);
  }
}

function validateExportSurface({ contract, manifest, workspacePath }, violations) {
  const manifestPath = `${workspacePath}/package.json`;
  const rootExport = rootExportValue(manifest.exports);
  if (!contract.requiresRootExport) return;
  if (rootExport === undefined) {
    violations.push(`${manifestPath}: public export "." is missing for workspace package "${manifest.name}"`);
    return;
  }
  const targets = collectExportTargets(rootExport);
  if (targets.length === 0)
    violations.push(`${manifestPath}: public export "." has no target for workspace package "${manifest.name}"`);
  for (const target of targets) {
    const invalid =
      typeof target !== "string" ||
      !target.startsWith("./") ||
      target.includes("\\") ||
      target
        .slice(2)
        .split("/")
        .some((part) => part === "." || part === ".." || part === "node_modules");
    if (invalid) {
      violations.push(
        `${manifestPath}: public export "." target "${target}" is invalid for workspace package "${manifest.name}"`,
      );
    } else if (contract.requiresFiles && Array.isArray(manifest.files) && !filesCoverTarget(manifest.files, target)) {
      violations.push(
        `${manifestPath}: public export "." target "${target}" is outside files boundary for workspace package "${manifest.name}"`,
      );
    }
  }
}

function validateManifestDependencies({ contract, manifest, workspacePath }, workspaceNames, violations) {
  const manifestPath = `${workspacePath}/package.json`;
  const allowed = contractAllowed(contract);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependencyName, range] of Object.entries(manifest[field] ?? {})) {
      if (!workspaceNames.has(dependencyName)) continue;
      if (!allowed.has(dependencyName))
        violations.push(`${manifestPath}: forbidden dependency edge to workspace package "${dependencyName}"`);
      if (range !== "workspace:*")
        violations.push(
          `${manifestPath}: internal dependency "${dependencyName}" must use range "workspace:*" (found "${range}")`,
        );
    }
  }
}

function declaredDependencyNames(manifest) {
  const declared = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
  }
  return declared;
}

function validateRelativeImport(
  { rootDirectory, sourceFile, displayPath, specifier, workspace, workspaces },
  violations,
) {
  const resolvedImport = resolve(dirname(sourceFile), specifier);
  const target = workspaces.find(
    (candidate) => candidate !== workspace && packageTargetIsInside(candidate.directory, resolvedImport),
  );
  if (!target) return;
  const generated = isGeneratedPath(rootDirectory, resolvedImport) ? " (generated file)" : "";
  violations.push(
    `${displayPath}: relative import "${specifier}" crosses into workspace package "${target.manifest.name}"${generated}`,
  );
}

function validatePackageImport({ displayPath, specifier, target, allowed, declared }, violations) {
  const subpath = specifier.slice(target.manifest.name.length);
  if (subpath) {
    const key = `.${subpath}`;
    const keys = exportKeys(target.manifest.exports);
    if (specifier.includes("/src/") || specifier.includes("/dist/") || !keys.has(key)) {
      violations.push(
        `${displayPath}: import "${specifier}" bypasses the public export surface of workspace package "${target.manifest.name}"`,
      );
    }
  }
  if (!allowed.has(target.manifest.name))
    violations.push(`${displayPath}: imports forbidden workspace package "${target.manifest.name}"`);
  if (!declared.has(target.manifest.name))
    violations.push(`${displayPath}: imports undeclared workspace package "${target.manifest.name}"`);
}

async function validateWorkspaceImports(rootDirectory, workspace, workspaces, byName, names, violations) {
  const declared = declaredDependencyNames(workspace.manifest);
  const allowed = contractAllowed(workspace.contract);
  for (const sourceFile of await collectSourceFiles(workspace.directory)) {
    const displayPath = toPosix(relative(rootDirectory, sourceFile));
    const source = await readFile(sourceFile, "utf8");
    for (const specifier of collectModuleSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        validateRelativeImport(
          { rootDirectory, sourceFile, displayPath, specifier, workspace, workspaces },
          violations,
        );
        continue;
      }
      const targetName = names.find((name) => specifier === name || specifier.startsWith(`${name}/`));
      if (!targetName || targetName === workspace.manifest.name) continue;
      validatePackageImport({ displayPath, specifier, target: byName.get(targetName), allowed, declared }, violations);
    }
  }
}

async function validateImports(rootDirectory, workspaces, violations) {
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const names = [...byName.keys()].sort((left, right) => right.length - left.length);
  for (const workspace of workspaces) {
    await validateWorkspaceImports(rootDirectory, workspace, workspaces, byName, names, violations);
  }
}

function validateManifest(workspace, workspaceNames, violations) {
  const { contract, manifest, workspacePath } = workspace;
  const manifestPath = `${workspacePath}/package.json`;
  if (manifest.name !== contract.name)
    violations.push(`${manifestPath}: name does not match contract (target "${contract.name}")`);
  if (manifest.private !== true)
    violations.push(`${manifestPath}: workspace must be private (target "${manifest.name ?? "missing"}")`);
  if (manifest.type !== "module")
    violations.push(`${manifestPath}: type must be "module" (target "${manifest.name ?? "missing"}")`);
  validateExportSurface(workspace, violations);
  if (contract.requiresFiles && (!Array.isArray(manifest.files) || manifest.files.length === 0))
    violations.push(`${manifestPath}: files boundary is missing for workspace package "${manifest.name}"`);
  validateManifestDependencies(workspace, workspaceNames, violations);
}

export async function verifyWorkspaceContract({
  rootDirectory = process.cwd(),
  contractPath = join(rootDirectory, CONTRACT_FILENAME),
} = {}) {
  const root = resolve(rootDirectory);
  const violations = [];
  const contract = await readJson(contractPath);
  validateContractConfiguration(contract, violations);
  const workspaceYaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const discovery = await discoverWorkspaces(root, parseWorkspacePatterns(workspaceYaml));
  for (const pattern of discovery.unmatchedPatterns)
    violations.push(`pnpm-workspace.yaml: pattern "${pattern}" matches no workspace package (target "${pattern}")`);
  const contractPaths = new Set(Object.keys(contract.workspaces ?? {}));
  const discoveredPaths = new Set(discovery.workspaces.map(({ workspacePath }) => workspacePath));
  for (const { workspacePath } of discovery.workspaces)
    if (!contractPaths.has(workspacePath))
      violations.push(
        `${workspacePath}/package.json: workspace is not registered in ${CONTRACT_FILENAME} (target "${workspacePath}")`,
      );
  for (const workspacePath of contractPaths)
    if (!discoveredPaths.has(workspacePath))
      violations.push(
        `${CONTRACT_FILENAME}: registered workspace "${workspacePath}" is not selected by pnpm-workspace.yaml (target "${workspacePath}")`,
      );
  const workspaces = [];
  for (const { directory, workspacePath } of discovery.workspaces) {
    const workspaceContract = contract.workspaces?.[workspacePath];
    if (!workspaceContract) continue;
    const manifest = await readJson(join(directory, "package.json"));
    workspaces.push({ contract: workspaceContract, directory, manifest, workspacePath });
  }
  const names = new Set(workspaces.map((workspace) => workspace.manifest.name));
  if (names.size !== workspaces.length)
    violations.push("workspace package names must be unique (target workspace package name)");
  for (const workspace of workspaces) validateManifest(workspace, names, violations);
  await validateImports(root, workspaces, violations);
  if (violations.length > 0) throw new WorkspaceContractError([...new Set(violations)].sort());
  return {
    workspaceCount: workspaces.length,
    allowedDependencyCount: workspaces.reduce(
      (count, workspace) => count + (workspace.contract.allowedWorkspaceDependencies?.length ?? 0),
      0,
    ),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyWorkspaceContract();
    console.log(
      `Workspace contract verified (${result.workspaceCount} workspaces, ${result.allowedDependencyCount} allowed dependency edges).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
