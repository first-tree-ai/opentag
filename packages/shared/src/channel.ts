import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import definitions from "./channel-config.json" with { type: "json" };

export const ChannelNameSchema = z.enum(["dev", "staging", "prod"]);
export type ChannelName = z.infer<typeof ChannelNameSchema>;

export interface ChannelConfig {
  binName: string;
  channel: ChannelName;
  defaultHome: string;
  defaultServerUrl?: string;
  displayName: string;
  packageName: string;
  serviceId: string;
}

const ChannelDefinitionSchema = z
  .object({
    binName: z.string().min(1),
    defaultHomeDirectory: z.string().startsWith("."),
    defaultServerUrl: z.string().url().optional(),
    displayName: z.string().min(1),
    packageName: z.string().min(1),
    serviceId: z.string().min(1),
  })
  .strict();

const ChannelDefinitionsSchema = z.object({
  dev: ChannelDefinitionSchema,
  prod: ChannelDefinitionSchema,
  staging: ChannelDefinitionSchema,
});
const channelDefinitions = ChannelDefinitionsSchema.parse(definitions);

export function getChannelConfig(channel: ChannelName, userHome = homedir()): ChannelConfig {
  const definition = channelDefinitions[channel];
  return {
    binName: definition.binName,
    channel,
    defaultHome: join(userHome, definition.defaultHomeDirectory),
    ...(definition.defaultServerUrl ? { defaultServerUrl: definition.defaultServerUrl } : {}),
    displayName: definition.displayName,
    packageName: definition.packageName,
    serviceId: definition.serviceId,
  };
}
