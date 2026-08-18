import { type ChannelName, getChannelConfig } from "@opentag/shared";
import packageManifest from "../package.json" with { type: "json" };

export const CHANNEL: ChannelName = "dev";
export const CLI_PACKAGE_NAME = packageManifest.name;
export const CLI_VERSION = packageManifest.version;

if (CLI_PACKAGE_NAME !== getChannelConfig(CHANNEL).packageName) {
  throw new Error(`CLI package ${CLI_PACKAGE_NAME} does not match the ${CHANNEL} channel`);
}
