import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessLister = (pid: number) => Promise<readonly number[]>;

async function readProcChildren(pid: number): Promise<readonly number[]> {
  try {
    // BSD syntax works on both the Linux container and a macOS dev host (`--ppid` does not).
    const { stdout } = await execFileAsync("ps", ["ax", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    const children: number[] = [];
    for (const line of stdout.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (parent === pid && typeof child === "number" && Number.isInteger(child) && child > 1) children.push(child);
    }
    return children;
  } catch {
    return [];
  }
}

export async function processExists(pid: number): Promise<boolean> {
  try {
    await access(`/proc/${pid}`);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export async function collectDescendantPids(
  pid: number,
  listChildren: ProcessLister = readProcChildren,
): Promise<readonly number[]> {
  const found = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || found.has(current)) continue;
    found.add(current);
    for (const child of await listChildren(current)) queue.push(child);
  }
  return [...found];
}

export async function waitForProcessTreeGone(
  pids: readonly number[],
  options: { readonly timeoutMs?: number; readonly exists?: (pid: number) => Promise<boolean> } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const exists = options.exists ?? processExists;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live: number[] = [];
    for (const pid of pids) {
      if (await exists(pid)) live.push(pid);
    }
    if (live.length === 0) return;
    if (Date.now() >= deadline) throw new Error(`process tree still alive: ${live.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
