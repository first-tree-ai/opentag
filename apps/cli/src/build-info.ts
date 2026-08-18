import packageManifest from "../package.json" with { type: "json" };

const SOURCE_PACKAGE_NAME = "open-tag";
const STAGING_PACKAGE_NAME = "open-tag-staging";

if (packageManifest.name !== SOURCE_PACKAGE_NAME && packageManifest.name !== STAGING_PACKAGE_NAME) {
  throw new Error(`Unsupported OpenTag CLI package identity: ${packageManifest.name}`);
}

export const CLI_PACKAGE_NAME = packageManifest.name;
export const CLI_VERSION = packageManifest.version;
export const CLI_BINARY_NAME = packageManifest.name === STAGING_PACKAGE_NAME ? "opentag-staging" : "opentag";
