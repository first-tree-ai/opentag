import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { creationErrorMessage } from "./page.js";

describe("creationErrorMessage", () => {
  it("says a taken name in the reader's language, noting names ignore case", () => {
    const cause = new ApiError(409, "An active Agent with this name already exists", "AGENT_NAME_CONFLICT");
    expect(creationErrorMessage(cause)).toBe("An Agent with this name already exists. Names aren't case-sensitive.");
  });

  it("keeps any other failure's own message", () => {
    expect(creationErrorMessage(new Error("Computer is offline"))).toBe("Computer is offline");
  });
});
