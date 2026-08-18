import { readFileSync } from "node:fs";

const definitions = JSON.parse(
  readFileSync(new URL("../packages/shared/src/channel-config.json", import.meta.url), "utf8"),
);

for (const channel of ["dev", "staging", "prod"]) {
  const definition = definitions[channel];
  if (!definition?.binName || !definition.packageName || !definition.serviceId) {
    throw new Error(`shared channel configuration is incomplete for ${channel}`);
  }
}

export const CHANNEL_CONFIG = Object.freeze(definitions);
