import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Resolve the fixed trusted Pi web-tools extension artifact shipped inside the Client package.
 * The artifact is built into `dist/pi-extensions/web-tools.mjs`; resolution never follows
 * environment variables, workspaces, or cwd, so an Agent can never substitute its own extension.
 * An explicit path exists only as a composition/test seam. Failure returns undefined (web tools
 * stay off), never a guessed path.
 */
export async function resolveWebToolsExtensionPath(
  options: { explicitPath?: string } = {},
): Promise<string | undefined> {
  if (options.explicitPath !== undefined) return verifyExtensionFile(options.explicitPath);
  const candidates = [
    // Bundled layout: this module is packed into dist/index.mjs next to dist/pi-extensions/.
    new URL("./pi-extensions/web-tools.mjs", import.meta.url),
    // Source layout (tests/development): src/runtime/ → src/pi-extensions/.
    new URL("../pi-extensions/web-tools.mjs", import.meta.url),
    new URL("../pi-extensions/web-tools.ts", import.meta.url),
  ];
  for (const candidate of candidates) {
    const verified = await verifyExtensionFile(fileURLToPath(candidate));
    if (verified) return verified;
  }
  return undefined;
}

async function verifyExtensionFile(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    if (!(await lstat(resolved)).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}
