import { timingSafeEqual } from "node:crypto";
import { isBlockedAddress, isIpLiteral, isLoopbackHostname } from "@opentag/shared";
import type { ApplicationCipher } from "../../crypto.js";

/**
 * The short link a Feishu setup QR code encodes instead of the full launcher URL.
 *
 * The launcher URL runs past a thousand characters, which makes a symbol too dense for many phone
 * cameras. The link is stateless so that no table is needed and any Server instance can answer it:
 * the token is the attempt ID followed by a MAC of it, and the attempt's own row decides whether the
 * link still works, so it expires, ends and is cancelled with the attempt.
 *
 * A MAC rather than the bare attempt ID, because attempt IDs appear in authenticated API paths and in
 * logs. The MAC also lets a forged token be refused without reading the database, which matters on a
 * route that takes no authentication.
 */
export const FEISHU_QR_LINK_PATH_PREFIX = "/q/";

const MAC_PURPOSE = "feishu-setup-qr-link/v1";
const ATTEMPT_ID_BYTES = 16;
const MAC_BYTES = 16;
/** Base64url of the 32 token bytes, without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function attemptIdBytes(attemptId: string): Buffer {
  const bytes = Buffer.from(attemptId.replaceAll("-", ""), "hex");
  if (bytes.byteLength !== ATTEMPT_ID_BYTES) throw new Error("A setup attempt ID must be a UUID");
  return bytes;
}

function attemptIdFromBytes(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function macOf(cipher: ApplicationCipher, attempt: Buffer): Buffer {
  return cipher.authenticate(MAC_PURPOSE, attempt).subarray(0, MAC_BYTES);
}

export function mintFeishuQrLinkToken(cipher: ApplicationCipher, attemptId: string): string {
  const attempt = attemptIdBytes(attemptId);
  return Buffer.concat([attempt, macOf(cipher, attempt)]).toString("base64url");
}

/** The attempt ID a token was minted for, or undefined for anything this deployment did not mint. */
export function readFeishuQrLinkToken(cipher: ApplicationCipher, token: string): string | undefined {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  // The last character has spare bits, so several spellings decode to one value; only one was minted.
  if (bytes.byteLength !== ATTEMPT_ID_BYTES + MAC_BYTES || bytes.toString("base64url") !== token) return undefined;
  const attempt = bytes.subarray(0, ATTEMPT_ID_BYTES);
  return timingSafeEqual(bytes.subarray(ATTEMPT_ID_BYTES), macOf(cipher, attempt))
    ? attemptIdFromBytes(attempt)
    : undefined;
}

/** Name suffixes that only resolve inside a private network. */
const PRIVATE_NAME_SUFFIXES = [".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"];

/**
 * Whether a phone on the public internet can be expected to open this URL.
 *
 * A QR code pointing at an address the phone cannot reach is worse than a dense one, so anything that
 * is not plainly public HTTPS keeps the full launcher URL. This is deliberately a judgement on the
 * address's shape: a VPN that makes a private name reachable from the phone only costs the shorter
 * symbol, never the connection.
 */
export function isPhoneReachableUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isLoopbackHostname(hostname)) return false;
  if (isIpLiteral(hostname)) return !isBlockedAddress(hostname);
  if (!hostname.includes(".")) return false;
  return !PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
