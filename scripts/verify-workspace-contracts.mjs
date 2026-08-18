import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONTRACT_FILENAME = "workspace-contracts.json";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([".turbo", "coverage", "dist", "node_modules"]);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class WorkspaceContractError extends Error {
  constructor(violations) {
    super(`Workspace architecture violations:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
    this.name = "WorkspaceContractError";
    this.violations = violations;
  }
}

function toPosix(filePath) {
  return filePath.split(sep).join("/");
}

function isInside(parentDirectory, candidatePath) {
  const relativePath = relative(parentDirectory, candidatePath);
  return (
    relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function parseWorkspacePatterns(source) {
  const patterns = [];
  let packagesIndent;

  for (const line of source.split(/\r?\n/)) {
    if (packagesIndent === undefined) {
      const packagesMatch = line.match(/^(\s*)packages:\s*(?:#.*)?$/);
      if (packagesMatch) {
        packagesIndent = packagesMatch[1].length;
      }
      continue;
    }

    if (/^\s*(?:#.*)?$/.test(line)) {
      continue;
    }

    const indentation = line.match(/^\s*/)[0].length;
    if (indentation <= packagesIndent) {
      break;
    }

    const itemMatch = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/);
    if (!itemMatch) {
      throw new Error(`Unsupported pnpm workspace entry: ${line.trim()}`);
    }
    patterns.push((itemMatch[1] ?? itemMatch[2] ?? itemMatch[3]).trim());
  }

  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml must define at least one package pattern");
  }

  return patterns;
}

async function expandWorkspacePattern(rootDirectory, pattern) {
  const normalizedPattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (normalizedPattern.startsWith("!") || /[?{}[\]]/.test(normalizedPattern)) {
    throw new Error(`Unsupported pnpm workspace pattern: ${pattern}`);
  }

  let candidates = [rootDirectory];
  for (const segment of normalizedPattern.split("/")) {
    if (segment === "*") {
      const expanded = [];
      for (const candidate of candidates) {
        if (!(await exists(candidate))) {
          continue;
        }
        const entries = await readdir(candidate, { withFileTypes: true });
        expanded.push(
          ...entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => join(candidate, entry.name)),
        );
      }
      candidates = expanded;
      continue;
    }

    if (segment.includes("*")) {
      throw new Error(`Unsupported pnpm workspace pattern: ${pattern}`);
    }
    candidates = candidates.map((candidate) => join(candidate, segment));
  }

  const matches = [];
  for (const candidate of candidates) {
    if (await exists(join(candidate, "package.json"))) {
      matches.push(toPosix(relative(rootDirectory, candidate)));
    }
  }
  return matches;
}

async function discoverWorkspaces(rootDirectory) {
  const workspaceSource = await readFile(join(rootDirectory, "pnpm-workspace.yaml"), "utf8");
  const patterns = parseWorkspacePatterns(workspaceSource);
  const workspacePaths = new Set();
  const unmatchedPatterns = [];

  for (const pattern of patterns) {
    const matches = await expandWorkspacePattern(rootDirectory, pattern);
    if (matches.length === 0) {
      unmatchedPatterns.push(pattern);
    }
    for (const match of matches) {
      workspacePaths.add(match);
    }
  }

  return { patterns, unmatchedPatterns, workspacePaths: [...workspacePaths].sort() };
}

async function collectSourceFiles(directory) {
  const sourceFiles = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        sourceFiles.push(...(await collectSourceFiles(entryPath)));
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      sourceFiles.push(entryPath);
    }
  }

  return sourceFiles;
}

function collectModuleSpecifiers(source, filePath) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function declaredDependencies(manifest) {
  const dependencies = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      dependencies.set(name, { field, range });
    }
  }
  return dependencies;
}

function validateContractConfiguration(contract, violations) {
  if (contract.schemaVersion !== 1) {
    violations.push(`${CONTRACT_FILENAME}: schemaVersion must be 1`);
  }
  if (!contract.workspaces || typeof contract.workspaces !== "object" || Array.isArray(contract.workspaces)) {
    violations.push(`${CONTRACT_FILENAME}: workspaces must be an object keyed by workspace path`);
    return;
  }

  const names = new Set();
  for (const [workspacePath, workspaceContract] of Object.entries(contract.workspaces)) {
    if (
      workspacePath.includes("\\") ||
      isAbsolute(workspacePath) ||
      workspacePath.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      violations.push(`${CONTRACT_FILENAME}: invalid workspace path "${workspacePath}"`);
    }
    if (!workspaceContract || typeof workspaceContract !== "object" || Array.isArray(workspaceContract)) {
      violations.push(`${CONTRACT_FILENAME}: contract for "${workspacePath}" must be an object`);
      continue;
    }
    if (typeof workspaceContract.name !== "string" || workspaceContract.name.length === 0) {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare a package name`);
    } else if (names.has(workspaceContract.name)) {
      violations.push(`${CONTRACT_FILENAME}: duplicate package name "${workspaceContract.name}"`);
    } else {
      names.add(workspaceContract.name);
    }
    if (!Array.isArray(workspaceContract.allowedWorkspaceDependencies)) {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare allowedWorkspaceDependencies`);
    } else if (
      workspaceContract.allowedWorkspaceDependencies.some((dependencyName) => typeof dependencyName !== "string")
    ) {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" contains a non-string workspace dependency`);
    } else if (
      new Set(workspaceContract.allowedWorkspaceDependencies).size !==
      workspaceContract.allowedWorkspaceDependencies.length
    ) {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" contains duplicate workspace dependencies`);
    }
    if (typeof workspaceContract.private !== "boolean") {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare private as a boolean`);
    }
    if (typeof workspaceContract.requiresRootExport !== "boolean") {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare requiresRootExport as a boolean`);
    }
    if (typeof workspaceContract.requiresFiles !== "boolean") {
      violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" must declare requiresFiles as a boolean`);
    }
  }

  for (const [workspacePath, workspaceContract] of Object.entries(contract.workspaces)) {
    if (!workspaceContract || typeof workspaceContract !== "object" || Array.isArray(workspaceContract)) {
      continue;
    }
    for (const dependencyName of workspaceContract.allowedWorkspaceDependencies ?? []) {
      if (!names.has(dependencyName)) {
        violations.push(
          `${CONTRACT_FILENAME}: "${workspacePath}" allows unknown workspace dependency "${dependencyName}"`,
        );
      }
      if (dependencyName === workspaceContract.name) {
        violations.push(`${CONTRACT_FILENAME}: "${workspacePath}" cannot depend on itself`);
      }
    }
  }
}

function validateManifest(workspace, workspaceNames, violations) {
  const { contract, manifest, workspacePath } = workspace;
  const manifestPath = `${workspacePath}/package.json`;

  if (manifest.name !== contract.name) {
    violations.push(`${manifestPath}: name must be "${contract.name}", found "${manifest.name ?? "missing"}"`);
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    violations.push(`${manifestPath}: version must be a valid semantic version`);
  }
  if (manifest.private !== contract.private) {
    violations.push(`${manifestPath}: private must be ${String(contract.private)}`);
  }
  if (manifest.type !== "module") {
    violations.push(`${manifestPath}: type must be "module"`);
  }
  if (contract.requiresRootExport && (!manifest.exports || !("." in manifest.exports))) {
    violations.push(`${manifestPath}: exports must define the public "." entry point`);
  }
  if (contract.requiresFiles && (!Array.isArray(manifest.files) || manifest.files.length === 0)) {
    violations.push(`${manifestPath}: files must declare the published artifact boundary`);
  }

  const allowedDependencies = new Set(contract.allowedWorkspaceDependencies ?? []);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependencyName, range] of Object.entries(manifest[field] ?? {})) {
      if (!workspaceNames.has(dependencyName)) {
        continue;
      }
      if (!allowedDependencies.has(dependencyName)) {
        violations.push(`${manifestPath}: ${field} cannot depend on workspace package "${dependencyName}"`);
      }
      if (typeof range !== "string" || !range.startsWith("workspace:")) {
        violations.push(`${manifestPath}: internal dependency "${dependencyName}" must use the workspace: protocol`);
      }
    }
  }
}

async function validateImports(rootDirectory, workspaces, violations) {
  const byName = new Map(
    workspaces
      .filter((workspace) => typeof workspace.manifest.name === "string")
      .map((workspace) => [workspace.manifest.name, workspace]),
  );
  const namesByLength = [...byName.keys()].sort((left, right) => right.length - left.length);

  for (const workspace of workspaces) {
    const declared = declaredDependencies(workspace.manifest);
    const allowed = new Set(workspace.contract.allowedWorkspaceDependencies ?? []);
    const sourceFiles = await collectSourceFiles(workspace.directory);

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      const displayPath = toPosix(relative(rootDirectory, sourceFile));
      for (const specifier of collectModuleSpecifiers(source, sourceFile)) {
        if (specifier.startsWith(".")) {
          const resolvedImport = resolve(dirname(sourceFile), specifier);
          const targetWorkspace = workspaces.find(
            (candidate) => candidate !== workspace && isInside(candidate.directory, resolvedImport),
          );
          if (targetWorkspace) {
            violations.push(
              `${displayPath}: relative import "${specifier}" crosses into workspace "${targetWorkspace.manifest.name}"`,
            );
          }
          continue;
        }

        const targetName = namesByLength.find(
          (workspaceName) => specifier === workspaceName || specifier.startsWith(`${workspaceName}/`),
        );
        if (!targetName || targetName === workspace.manifest.name) {
          continue;
        }

        if (specifier !== targetName) {
          violations.push(`${displayPath}: import "${specifier}" bypasses the public root export of "${targetName}"`);
        }
        if (!allowed.has(targetName)) {
          violations.push(`${displayPath}: imports forbidden workspace package "${targetName}"`);
        }
        if (!declared.has(targetName)) {
          violations.push(`${displayPath}: imports undeclared workspace package "${targetName}"`);
        }
      }
    }
  }
}

export async function verifyWorkspaceContracts({
  rootDirectory = process.cwd(),
  contractPath = join(rootDirectory, CONTRACT_FILENAME),
} = {}) {
  const resolvedRoot = resolve(rootDirectory);
  const contract = await readJson(contractPath);
  const discovery = await discoverWorkspaces(resolvedRoot);
  const violations = [];
  validateContractConfiguration(contract, violations);

  for (const pattern of discovery.unmatchedPatterns) {
    violations.push(`pnpm-workspace.yaml: pattern "${pattern}" does not match a package.json`);
  }

  const contractPaths = Object.keys(contract.workspaces ?? {}).sort();
  const discoveredPaths = new Set(discovery.workspacePaths);
  for (const workspacePath of discovery.workspacePaths) {
    if (!contract.workspaces?.[workspacePath]) {
      violations.push(`${workspacePath}/package.json: workspace is not registered in ${CONTRACT_FILENAME}`);
    }
  }
  for (const workspacePath of contractPaths) {
    if (!discoveredPaths.has(workspacePath)) {
      violations.push(
        `${CONTRACT_FILENAME}: registered workspace "${workspacePath}" is not selected by pnpm-workspace.yaml`,
      );
    }
  }

  const workspaces = [];
  for (const workspacePath of discovery.workspacePaths) {
    const workspaceContract = contract.workspaces?.[workspacePath];
    if (!workspaceContract) {
      continue;
    }
    const directory = join(resolvedRoot, workspacePath);
    workspaces.push({
      contract: workspaceContract,
      directory,
      manifest: await readJson(join(directory, "package.json")),
      workspacePath,
    });
  }

  const manifestNames = workspaces
    .map((workspace) => workspace.manifest.name)
    .filter((packageName) => typeof packageName === "string");
  const workspaceNames = new Set(manifestNames);
  if (manifestNames.length === workspaces.length && workspaceNames.size !== workspaces.length) {
    violations.push("workspace package names must be unique");
  }
  for (const workspace of workspaces) {
    validateManifest(workspace, workspaceNames, violations);
  }
  await validateImports(resolvedRoot, workspaces, violations);

  if (violations.length > 0) {
    throw new WorkspaceContractError([...new Set(violations)].sort());
  }

  return {
    allowedDependencyCount: contractPaths.reduce(
      (count, workspacePath) => count + contract.workspaces[workspacePath].allowedWorkspaceDependencies.length,
      0,
    ),
    workspaceCount: workspaces.length,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyWorkspaceContracts();
    console.log(
      `Workspace architecture verified (${result.workspaceCount} workspaces, ${result.allowedDependencyCount} allowed dependency edges).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
