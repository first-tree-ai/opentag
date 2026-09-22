import { isIP } from "node:net";
import { z } from "zod";

/**
 * Which peers may set `X-Forwarded-*`: nobody (`false`), everybody (`true`), or the listed
 * addresses, CIDR ranges, and `@fastify/proxy-addr` presets. A hop count is deliberately not
 * accepted: Fastify cannot validate the immediate peer from a count and ignores it.
 */
export type TrustProxyConfig = boolean | string[];

const PROXY_ADDRESS_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

function isProxyAddress(entry: string): boolean {
  if (PROXY_ADDRESS_PRESETS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split("/");
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** `OPENTAG_TRUST_PROXY`: unset or `false`, `true`, or a comma-separated address/CIDR/preset list. */
export const TrustProxySchema = z
  .string()
  .optional()
  .transform((raw, context): TrustProxyConfig => {
    const value = raw?.trim().toLowerCase() ?? "";
    if (value === "" || value === "false") return false;
    if (value === "true") return true;
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const invalid = entries.filter((entry) => !isProxyAddress(entry));
    if (entries.length === 0 || invalid.length > 0) {
      context.addIssue({
        code: "custom",
        message: `OPENTAG_TRUST_PROXY must be true, false, or a comma-separated list of IP addresses, CIDR ranges, or loopback/linklocal/uniquelocal (invalid: ${invalid.join(", ") || "empty list"})`,
      });
      return z.NEVER;
    }
    return entries;
  });
