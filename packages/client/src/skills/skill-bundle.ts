import { createHash } from "node:crypto";

/**
 * Integrity check for a Skill bundle, shared by runtime sync and the CLI's `skill pull`.
 *
 * The platform reports each Skill's exact compressed byte length and lowercase-hex SHA-256; both
 * must match before a downloaded bundle is trusted enough to materialize.
 */

export interface ExpectedSkillBundle {
  readonly archiveBytes: number;
  /** Lowercase hex SHA-256 over the compressed archive bytes. */
  readonly archiveSha256: string;
  /** Used only to make a failure message identify the Skill. */
  readonly name?: string;
}

export function verifySkillBundle(bytes: Uint8Array, expected: ExpectedSkillBundle): Uint8Array {
  const label = expected.name === undefined ? "Skill bundle" : `Skill bundle ${expected.name}`;
  if (bytes.byteLength !== expected.archiveBytes) {
    throw new Error(`${label} has ${bytes.byteLength} bytes, expected ${expected.archiveBytes}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.archiveSha256) {
    throw new Error(`${label} failed its sha256 check`);
  }
  return bytes;
}
