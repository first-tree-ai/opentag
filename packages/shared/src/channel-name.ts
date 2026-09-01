import { z } from "zod";

/**
 * Release channel names. Kept free of Node.js imports so browser bundles and protocol schemas can
 * reference channels without pulling in `node:os`/`node:path`.
 */
export const ChannelNameSchema = z.enum(["dev", "staging", "prod"]);
export type ChannelName = z.infer<typeof ChannelNameSchema>;
