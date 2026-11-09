export class GitPublicationError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "scope_denied"
      | "resource_limit"
      | "invalid_objects"
      | "remote_conflict"
      | "tree_invalid"
      | "unavailable",
  ) {
    super(`Git publication failed: ${code}`);
    this.name = "GitPublicationError";
  }
}
export interface GitRefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

export async function contextTreePushBody(
  body: AsyncIterable<Uint8Array>,
  branch: string,
): Promise<AsyncIterable<Uint8Array>> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let header = Buffer.alloc(0);
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new GitPublicationError("scope_denied");
      chunks.push(next.value);
      header = Buffer.concat([header, next.value.subarray(0, 65536 - header.length)]);
      if (validPushHeader(header, branch)) break;
      if (header.length >= 65536) throw new GitPublicationError("resource_limit");
    }
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
  return (async function* () {
    try {
      yield* chunks;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  })();
}

function validPushHeader(bytes: Buffer, branch: string): boolean {
  let offset = 0;
  let count = 0;
  while (offset + 4 <= bytes.length) {
    const prefix = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/u.test(prefix)) throw new GitPublicationError("scope_denied");
    const length = Number.parseInt(prefix, 16);
    if (length === 0) {
      if (count !== 1) throw new GitPublicationError("scope_denied");
      return true;
    }
    if (length < 4) throw new GitPublicationError("scope_denied");
    if (offset + length > bytes.length) return false;
    const command = bytes
      .subarray(offset + 4, offset + length)
      .toString("utf8")
      .split("\0")[0]
      ?.trimEnd();
    if (++count !== 1 || !isBranchUpdate(command, branch)) throw new GitPublicationError("scope_denied");
    offset += length;
  }
  return false;
}

function isBranchUpdate(command: string | undefined, branch: string): boolean {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/heads\/.+)$/u.exec(command ?? "");
  return match !== null && !/^0+$/u.test(match[2] ?? "") && match[3] === `refs/heads/${branch}`;
}
