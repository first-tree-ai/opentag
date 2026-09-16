import { GitBranchRefSchema } from "@opentag/shared";

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
export interface GitReceiveCommands {
  updates: GitRefUpdate[];
  capabilities: Set<string>;
}
export const GIT_ZERO_SHA = "0".repeat(40);
const Sha = /^[0-9a-f]{40}$/;

/** Parse only the bounded command header; the binary pack remains a streamed file. */
export function parseGitReceiveCommands(header: Uint8Array): GitReceiveCommands {
  const bytes = Buffer.from(header);
  const updates: GitRefUpdate[] = [];
  const capabilities = new Set<string>();
  const refs = new Set<string>();
  let offset = 0;
  while (offset + 4 <= bytes.length && offset < 16384) {
    const lengthText = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new GitPublicationError("invalid_request");
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      if (updates.length === 0) throw new GitPublicationError("invalid_request");
      return { updates, capabilities };
    }
    if (length < 5 || offset + length > bytes.length || updates.length >= 32)
      throw new GitPublicationError("invalid_request");
    const line = bytes
      .subarray(offset + 4, offset + length)
      .toString("utf8")
      .replace(/\n$/, "");
    const update = parseRefLine(line, updates.length === 0, capabilities);
    if (refs.has(update.ref)) throw new GitPublicationError("invalid_request");
    updates.push(update);
    refs.add(update.ref);
    offset += length;
  }
  throw new GitPublicationError("invalid_request");
}

function parseRefLine(line: string, first: boolean, capabilities: Set<string>): GitRefUpdate {
  const parts = line.split("\0");
  if (parts.length > 2 || (!first && parts.length > 1)) throw new GitPublicationError("invalid_request");
  const command = parts[0]?.split(" ");
  if (command?.length !== 3) throw new GitPublicationError("invalid_request");
  const [oldSha = "", newSha = "", ref = ""] = command;
  if (!Sha.test(oldSha) || !Sha.test(newSha) || !GitBranchRefSchema.safeParse(ref).success) {
    throw new GitPublicationError("invalid_request");
  }
  for (const capability of parts[1]?.split(" ") ?? []) capabilities.add(capability);
  return { oldSha, newSha, ref };
}

export function gitPacket(payload: Uint8Array | string): Buffer {
  const bytes = Buffer.from(payload);
  if (bytes.length + 4 > 65520) throw new GitPublicationError("resource_limit");
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

/** A protocol-level rejection, with safe fixed text and the client's requested side-band framing. */
export function gitReceiveFailure(commands: GitReceiveCommands): Buffer {
  const report = Buffer.concat([
    gitPacket("unpack ok\n"),
    ...commands.updates.map((update) => gitPacket(`ng ${update.ref} OpenTag publication rejected\n`)),
    Buffer.from("0000"),
  ]);
  return commands.capabilities.has("side-band-64k")
    ? Buffer.concat([gitPacket(Buffer.concat([Buffer.from([1]), report])), Buffer.from("0000")])
    : report;
}
