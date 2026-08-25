import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SLACK_BODY_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export function verifySlackSignature(input: {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  now?: Date;
}): boolean {
  if (input.rawBody.byteLength > MAX_SLACK_BODY_BYTES || !input.timestamp || !input.signature) return false;
  if (!/^\d+$/.test(input.timestamp) || !/^v0=[a-f0-9]{64}$/.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:`)
    .update(input.rawBody)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Reads only bounded App/Team identifiers so the global Events URL can look up a Signing Secret. */
export function preparseSlackRoute(rawBody: Buffer): { appId: string; teamId: string } | undefined {
  if (rawBody.byteLength > MAX_SLACK_BODY_BYTES) return undefined;
  try {
    const value = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const appId = value.api_app_id;
    const teamId = value.team_id ?? value.workspace;
    if (typeof appId !== "string" || typeof teamId !== "string" || appId.length > 255 || teamId.length > 255) {
      return undefined;
    }
    return { appId, teamId };
  } catch {
    return undefined;
  }
}
