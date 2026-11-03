import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type MachineFingerprintSources, readMachineFingerprint } from "../core/computer/machine-fingerprint.js";

function sources(overrides: Partial<MachineFingerprintSources> = {}): MachineFingerprintSources {
  return {
    platform: "linux",
    uid: 1000,
    readText: async (path) => (path === "/etc/machine-id" ? "6F0F893CD9C04057B5EEB8DA48A4EB77\n" : ""),
    macPlatformUuid: async () => "",
    realpath: async (path) => path,
    ...overrides,
  };
}

const expected = (machineId: string, uid: number, home: string) =>
  createHash("sha256").update(`opentag-machine-v1\0${machineId}\0${uid}\0${home}`).digest("hex");

describe("machine fingerprint", () => {
  it("hashes the Linux machine ID with the OS user and the resolved openTag home", async () => {
    const fingerprint = await readMachineFingerprint(
      "/home/ada/.opentag",
      sources({
        realpath: async () => "/data/ada/.opentag",
      }),
    );
    expect(fingerprint).toBe(expected("6f0f893cd9c04057b5eeb8da48a4eb77", 1000, "/data/ada/.opentag"));
    expect(fingerprint).not.toContain("6f0f893c");
  });

  it("separates OS users and homes on one machine", async () => {
    const a = await readMachineFingerprint("/home/ada/.opentag", sources());
    const b = await readMachineFingerprint("/home/ada/.opentag", sources({ uid: 1001 }));
    const c = await readMachineFingerprint("/home/ada/.opentag-dev", sources());
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("falls back to the dbus machine ID and to nothing when neither is usable", async () => {
    const dbus = await readMachineFingerprint(
      "/h",
      sources({
        readText: async (path) => (path === "/var/lib/dbus/machine-id" ? "abc123\n" : "uninitialized\n"),
      }),
    );
    expect(dbus).toBe(expected("abc123", 1000, "/h"));
    await expect(
      readMachineFingerprint(
        "/h",
        sources({
          readText: async () => {
            throw new Error("ENOENT");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the macOS platform UUID and nothing on Windows", async () => {
    const mac = await readMachineFingerprint(
      "/Users/ada/.opentag",
      sources({
        platform: "darwin",
        macPlatformUuid: async () => "1C2D3E4F-0000-1111-2222-333344445555",
      }),
    );
    expect(mac).toBe(expected("1c2d3e4f-0000-1111-2222-333344445555", 1000, "/Users/ada/.opentag"));
    await expect(readMachineFingerprint("C:\\opentag", sources({ platform: "win32" }))).resolves.toBeUndefined();
  });
});
