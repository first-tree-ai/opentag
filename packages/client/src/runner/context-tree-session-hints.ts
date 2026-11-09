import { z } from "zod";
import type { ContextTreeSessionHints } from "../runtime/context-tree-commands.js";
import { type NativeSandbox, SANDBOX_NODE } from "./native-sandbox.js";

export const CONTEXT_TREE_SESSION_HINT_SOURCE = `
import { constants, closeSync, fstatSync, mkdirSync, chmodSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw new Error(); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) throw new Error();
  const root = join(input.workspace, '.opentag/context-tree/command-sessions');
  const path = join(root, input.id + '.json');
  let data = '';
  if (input.operation === 'read') {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 4096) throw new Error();
      const buffer = Buffer.alloc(4097);
      let length = 0, count = 0;
      while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
      if (length > 4096) throw new Error();
      data = buffer.subarray(0, length).toString('utf8');
    } finally { closeSync(fd); }
  } else if (input.operation === 'write') {
    if (typeof input.hint !== 'string' || Buffer.byteLength(input.hint) > 4096) throw new Error();
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    writeFileSync(path, input.hint, { mode: 0o600, flag: 'wx' });
  } else if (input.operation === 'remove') {
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else throw new Error();
  process.stdout.write(JSON.stringify({ data }));
} catch { process.stderr.write('Context Tree routing hint unavailable'); process.exitCode = 1; }
`;

export function createSandboxContextTreeSessionHints(
  sandbox: Pick<NativeSandbox, "exec">,
  workspace: string,
): ContextTreeSessionHints {
  const run = async (
    operation: "read" | "write" | "remove",
    id: string,
    signal: AbortSignal | undefined,
    hint?: string,
  ) => {
    signal?.throwIfAborted();
    const result = await sandbox.exec(SANDBOX_NODE, ["--input-type=module", "-e", CONTEXT_TREE_SESSION_HINT_SOURCE], {
      timeoutMs: 5000,
      ...(signal ? { signal } : {}),
      stdin: JSON.stringify({
        workspace,
        operation,
        id: z.string().uuid().parse(id),
        ...(hint === undefined ? {} : { hint }),
      }),
    });
    signal?.throwIfAborted();
    if (result.code !== 0) throw new Error("Cloud Context Tree routing hint unavailable");
    return z
      .object({ data: z.string().max(4096) })
      .strict()
      .parse(JSON.parse(result.stdout)).data;
  };
  return {
    read: (id, signal) => run("read", id, signal),
    write: async (id, hint) => {
      await run("write", id, undefined, hint);
    },
    remove: async (id) => {
      await run("remove", id, undefined);
    },
  };
}
