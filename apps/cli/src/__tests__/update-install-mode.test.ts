import { describe, expect, it } from "vitest";
import { detectInstallMode } from "../core/update/install-mode.js";

describe("install mode detection", () => {
  it("detects a portable install from the shim environment", () => {
    expect(
      detectInstallMode({
        OPENTAG_INSTALL_MODE: "portable",
        OPENTAG_PORTABLE_ROOT: "/home/test/.local/share/opentag/staging",
        OPENTAG_PORTABLE_BIN_DIR: "/home/test/.local/bin",
      }),
    ).toEqual({
      mode: "portable",
      root: "/home/test/.local/share/opentag/staging",
      binDir: "/home/test/.local/bin",
    });
  });

  it("normalizes the managed installer's stable current link to the portable prefix", () => {
    expect(
      detectInstallMode({
        OPENTAG_INSTALL_MODE: "portable",
        OPENTAG_PORTABLE_ROOT: "/home/test/.local/share/opentag/staging/current",
        OPENTAG_PORTABLE_BIN_DIR: "/home/test/.local/bin",
      }),
    ).toEqual({
      mode: "portable",
      root: "/home/test/.local/share/opentag/staging",
      binDir: "/home/test/.local/bin",
    });
  });

  it("falls back to npm-global for npm installs and malformed portable environments", () => {
    expect(detectInstallMode({})).toEqual({ mode: "npm-global" });
    expect(detectInstallMode({ OPENTAG_INSTALL_MODE: "npm" })).toEqual({ mode: "npm-global" });
    expect(detectInstallMode({ OPENTAG_INSTALL_MODE: "portable" })).toEqual({ mode: "npm-global" });
    expect(
      detectInstallMode({
        OPENTAG_INSTALL_MODE: "portable",
        OPENTAG_PORTABLE_ROOT: "relative/root",
        OPENTAG_PORTABLE_BIN_DIR: "/home/test/.local/bin",
      }),
    ).toEqual({ mode: "npm-global" });
  });
});
