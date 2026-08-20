import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertWithin,
  ensurePrivateDirectory,
  readSecureFile,
  validatePrivateDirectory,
  writeDurableJson,
} from "./durable-file.js";

export async function readPrivateJson<T>(
  home: string,
  filePath: string,
  validate: (value: unknown) => T,
): Promise<T | undefined> {
  const root = resolve(home);
  const path = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  assertWithin(root, path);
  if (!(await validatePrivateDirectory(root, dirname(path)))) return undefined;
  const content = await readSecureFile(path);
  return content === undefined ? undefined : validate(JSON.parse(content));
}

export async function writePrivateJson(home: string, filePath: string, value: unknown): Promise<void> {
  const root = resolve(home);
  const destination = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  assertWithin(root, destination);
  await ensurePrivateDirectory(root, dirname(destination));
  await writeDurableJson(destination, value);
}
