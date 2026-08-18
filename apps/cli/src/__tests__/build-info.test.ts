import { describe, expect, it } from "vitest";
import packageManifest from "../../package.json" with { type: "json" };
import { CHANNEL, CLI_PACKAGE_NAME, CLI_VERSION } from "../build-info.js";
import { createProgram } from "../cli/program.js";
import { channelConfig } from "../core/channel.js";

describe("CLI build information", () => {
  it("derives the source identity from the package manifest", () => {
    expect(CLI_PACKAGE_NAME).toBe(packageManifest.name);
    expect(CHANNEL).toBe("dev");
    expect(channelConfig.binName).toBe(Object.keys(packageManifest.bin)[0]);
    expect(CLI_VERSION).toBe(packageManifest.version);
  });

  it("configures Commander from the same build information", () => {
    const program = createProgram();

    expect(program.name()).toBe(channelConfig.binName);
    expect(program.version()).toBe(CLI_VERSION);
  });
});
