import { afterEach, describe, expect, it } from "vitest";
import { rememberSignInIntent, takeSignInIntent } from "./sign-in-intent.js";

afterEach(() => window.sessionStorage.clear());

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
