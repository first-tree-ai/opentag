import { describe, expect, it } from "vitest";
import { assertPublicDestination } from "../destination.js";

describe("assertPublicDestination", () => {
  it("accepts public addresses and rejects private, empty, and unresolvable hosts", async () => {
    await expect(assertPublicDestination("a.test", async () => ["93.184.216.34"])).resolves.toBeUndefined();
    await expect(assertPublicDestination("a.test", async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(
      /non-public/,
    );
    await expect(assertPublicDestination("a.test", async () => [])).rejects.toThrow(/no address/);
    await expect(
      assertPublicDestination("a.test", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/cannot resolve/);
  });
});
