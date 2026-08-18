import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

async function ensurePrivateHome(home: string): Promise<void> {
  await mkdir(home, { mode: 0o700, recursive: true });
  const status = await lstat(home);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("The OpenTag home must be a real directory");
  }
  await chmod(home, 0o700);
}

export async function readPrivateJson<T>(
  home: string,
  fileName: string,
  validate: (value: unknown) => T,
): Promise<T | undefined> {
  const path = join(home, fileName);
  try {
    const homeStatus = await lstat(home);
    if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) {
      throw new Error("The OpenTag home must be a real directory");
    }
    const fileStatus = await lstat(path);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
      throw new Error(`The OpenTag ${fileName} file must be a regular file`);
    }
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writePrivateJson(home: string, fileName: string, value: unknown): Promise<void> {
  await ensurePrivateHome(home);
  const destination = join(home, fileName);
  try {
    const status = await lstat(destination);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`The OpenTag ${fileName} file must be a regular file`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const temporary = join(dirname(destination), `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}
