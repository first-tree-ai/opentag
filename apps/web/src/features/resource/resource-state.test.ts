import { describe, expect, it } from "vitest";
import { ApiError } from "../../api.js";
import { toResourceState } from "./resource-state.js";

interface Value {
  label: string;
}

const stale: Value = { label: "stale" };
const failure = new Error("The Server is unreachable");
/** Withdraws the claim that the value was observed, the way the Agent surfaces do. */
const markUnconfirmed = (value: Value): Value => ({ ...value, label: `${value.label} (unconfirmed)` });

/** Shaped like a real query result, where `data` is optional but the resource type is not. */
function query(data: Value | undefined, error: Error | null) {
  return { data, error, isError: error !== null };
}

describe("toResourceState", () => {
  it("is loading before the first response", () => {
    expect(toResourceState(query(undefined, null))).toEqual({ kind: "loading" });
  });

  it("is ready once a response has arrived", () => {
    expect(toResourceState(query(stale, null))).toEqual({ kind: "ready", value: stale });
  });

  it("is an error when the first read failed, so there is nothing to show", () => {
    expect(toResourceState(query(undefined, failure), markUnconfirmed)).toEqual({ kind: "error", error: failure });
  });

  it("keeps showing the value a background failure could not replace, marked as unconfirmed", () => {
    expect(toResourceState(query(stale, failure), markUnconfirmed)).toEqual({
      kind: "ready",
      value: { label: "stale (unconfirmed)" },
    });
  });

  it("surfaces a background failure as an error when the caller has no way to mark the value", () => {
    expect(toResourceState(query(stale, failure))).toEqual({ kind: "error", error: failure });
  });

  it.each([401, 403, 404, 410])("surfaces a %d as an error even with a value in hand", (status) => {
    // Gone or forbidden is not a transient loss of contact, so stale data must not paper over it.
    const terminal = new ApiError(status, "Denied");
    expect(toResourceState(query(stale, terminal), markUnconfirmed)).toEqual({ kind: "error", error: terminal });
  });

  it("degrades on a non-terminal ApiError, which is a Server that may yet answer", () => {
    const transient = new ApiError(503, "Unavailable");
    expect(toResourceState(query(stale, transient), markUnconfirmed)).toEqual({
      kind: "ready",
      value: { label: "stale (unconfirmed)" },
    });
  });

  it("substitutes an error when the query reports a failure without one", () => {
    const state = toResourceState({ data: undefined as Value | undefined, error: null, isError: true });
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.error.message).toBe("The request failed");
  });

  it("treats an absent resource as loaded when it resolves to null, not undefined", () => {
    // `imBinding` answers 204 for an Agent with no messaging. That has to read as ready-and-empty,
    // never as still-loading, so the API layer resolves it to null.
    const absent = toResourceState({ data: null as Value | null | undefined, error: null, isError: false });
    expect(absent).toEqual({ kind: "ready", value: null });
  });
});
