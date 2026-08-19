import { describe, expect, it } from "vitest";
import { ApplicationCipher } from "../services/crypto.js";

describe("ApplicationCipher", () => {
  it("round-trips versioned AES-GCM ciphertext without exposing plaintext", () => {
    const cipher = new ApplicationCipher(new Uint8Array(32).fill(7));
    const encrypted = cipher.encrypt("invite-secret");
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("invite-secret");
    expect(cipher.decrypt(encrypted)).toBe("invite-secret");
  });

  it("fails closed for tampered or malformed ciphertext", () => {
    const cipher = new ApplicationCipher(new Uint8Array(32).fill(7));
    const encrypted = cipher.encrypt("invite-secret");
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    expect(() => cipher.decrypt(`${encrypted.slice(0, -1)}${replacement}`)).toThrow(/authenticated/);
    expect(() => cipher.decrypt("v2.invalid")).toThrow(/unsupported/);
  });
});
