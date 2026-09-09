import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberSignInIntent, takeSignInIntent } from "./sign-in-intent.js";

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe("sign-in intent", () => {
  it("carries the method across the load that signs the Account in", () => {
    rememberSignInIntent({ method: "google", registering: false });

    expect(takeSignInIntent()).toEqual({ method: "google", registering: false });
  });

  it("is consumed by the first read, so a second render reports nothing", () => {
    rememberSignInIntent({ method: "password", registering: true });

    expect(takeSignInIntent()).toEqual({ method: "password", registering: true });
    expect(takeSignInIntent()).toBeUndefined();
  });

  it("says nothing when the Account arrived with a session it already had", () => {
    expect(takeSignInIntent()).toBeUndefined();
  });

  it("forgets a press that never became a sign-in", () => {
    // The redirect providers record on the press. Abandon the consent screen, come back an hour
    // later with the session you already had, and this must not report a sign-in that never was.
    vi.useFakeTimers();
    rememberSignInIntent({ method: "google", registering: false });

    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(takeSignInIntent()).toBeUndefined();
  });

  it("still honours an intent that is merely slow, because a consent screen takes time", () => {
    vi.useFakeTimers();
    rememberSignInIntent({ method: "google", registering: false });

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(takeSignInIntent()).toEqual({ method: "google", registering: false });
  });

  it("ignores a stored value that is not an intent rather than reporting a malformed one", () => {
    window.sessionStorage.setItem("opentag:analytics:sign-in-intent", "{ not json");
    expect(takeSignInIntent()).toBeUndefined();

    window.sessionStorage.setItem("opentag:analytics:sign-in-intent", JSON.stringify({ registering: true }));
    expect(takeSignInIntent()).toBeUndefined();
  });

  it("survives a browser that refuses storage instead of failing the sign-in", () => {
    const refusing = {
      sessionStorage: {
        getItem: () => {
          throw new Error("storage is disabled");
        },
        setItem: () => {
          throw new Error("storage is disabled");
        },
        removeItem: () => undefined,
      },
    } as unknown as Window;

    expect(() => rememberSignInIntent({ method: "password", registering: false }, refusing)).not.toThrow();
    expect(takeSignInIntent(refusing)).toBeUndefined();
  });
});
