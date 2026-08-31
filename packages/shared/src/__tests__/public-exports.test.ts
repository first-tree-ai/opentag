import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as publicBarrel from "../index.js";

const expectedExports = JSON.parse(
  readFileSync(new URL("./public-exports.snapshot.json", import.meta.url), "utf8"),
) as string[];

describe("@opentag/shared public exports", () => {
  it("match the checked-in sorted export snapshot", () => {
    expect(Object.keys(publicBarrel).sort()).toEqual(expectedExports);
  });
});
