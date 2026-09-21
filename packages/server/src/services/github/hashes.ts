import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A one-time OAuth state value; only its SHA-256 hash is ever persisted. */
export function generateOAuthState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, stateHash: sha256Hex(state) };
}
