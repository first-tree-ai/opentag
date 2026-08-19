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
    const tagSeparator = encrypted.lastIndexOf(".");
    const tag = Buffer.from(encrypted.slice(tagSeparator + 1), "base64url");
    tag.writeUInt8(tag.readUInt8(0) ^ 1, 0);
    const tampered = `${encrypted.slice(0, tagSeparator + 1)}${tag.toString("base64url")}`;
    expect(() => cipher.decrypt(tampered)).toThrow(/authenticated/);
    expect(() => cipher.decrypt("v2.invalid")).toThrow(/unsupported/);
  });
});
