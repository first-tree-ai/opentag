import { describe, expect, it } from "vitest";
import { ApiError } from "../../api.js";
import { toResourceState } from "./query-state.js";

const stale = { label: "stale" };
const failure = new Error("The Server is unreachable");
/** Withdraws the claim that the value was observed, the way the Agent surfaces do. */
const markUnconfirmed = (value: { label: string }) => ({ ...value, label: `${value.label} (unconfirmed)` });

describe("toResourceState", () => {
  it("is loading before the first response", () => {
    expect(toResourceState({ data: undefined, error: null, isError: false })).toEqual({ kind: "loading" });
  });

  it("is ready once a response has arrived", () => {
    expect(toResourceState({ data: stale, error: null, isError: false })).toEqual({ kind: "ready", value: stale });
  });

  it("is an error when the first read failed, so there is nothing to show", () => {
    expect(toResourceState({ data: undefined, error: failure, isError: true }, markUnconfirmed)).toEqual({
      kind: "error",
      error: failure,
    });
  });

  it("keeps showing the value a background failure could not replace, marked as unconfirmed", () => {
    expect(toResourceState({ data: stale, error: failure, isError: true }, markUnconfirmed)).toEqual({
      kind: "ready",
      value: { label: "stale (unconfirmed)" },
    });
  });

  it("surfaces a background failure as an error when the caller has no way to mark the value", () => {
    expect(toResourceState({ data: stale, error: failure, isError: true })).toEqual({
      kind: "error",
      error: failure,
    });
  });

  it.each([401, 403, 404, 410])(
    "surfaces a %d as an error even with a value in hand and a way to mark it",
    (status) => {
      // Gone or forbidden is not a transient loss of contact, so stale data must not paper over it.
      const terminal = new ApiError(status, "Denied");
      expect(toResourceState({ data: stale, error: terminal, isError: true }, markUnconfirmed)).toEqual({
        kind: "error",
        error: terminal,
      });
    },
  );

  it("degrades on a non-terminal ApiError, which is a Server that may yet answer", () => {
    const transient = new ApiError(503, "Unavailable");
    expect(toResourceState({ data: stale, error: transient, isError: true }, markUnconfirmed)).toEqual({
      kind: "ready",
      value: { label: "stale (unconfirmed)" },
    });
  });

  it("substitutes an error when the query reports a failure without one", () => {
    const state = toResourceState({ data: undefined, error: null, isError: true });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.error.message).toBe("The request failed");
  });
});
