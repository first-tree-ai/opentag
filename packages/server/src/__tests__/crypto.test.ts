import { describe, expect, it } from "vitest";
import { ApplicationCipher } from "../services/crypto.js";

const legacyKey = new Uint8Array(32).fill(7);
const ringKeys = {
  "im-2026-08": new Uint8Array(32).fill(11),
  "im-2026-09": new Uint8Array(32).fill(23),
};

function ringCipher(activeKeyId: string, writeVersion: 1 | 2 = 1, keys = ringKeys) {
  return new ApplicationCipher({ legacyKey, keys, activeKeyId, writeVersion });
}

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

  it("round-trips the v2 envelope with its key ID and exact context", () => {
    const cipher = ringCipher("im-2026-09");
    const bound = cipher.encryptBound("invite-secret", "github-connection-credential:connection-1");
    expect(bound.keyId).toBe("im-2026-09");
    expect(bound.ciphertext).toMatch(/^v2\.im-2026-09\./);
    expect(bound.ciphertext).not.toContain("invite-secret");
    expect(cipher.decrypt(bound.ciphertext, "github-connection-credential:connection-1")).toBe("invite-secret");
  });

  it("fails v2 reads with one uniform error for context, key, and tampering failures", () => {
    const cipher = ringCipher("im-2026-09");
    const bound = cipher.encryptBound("invite-secret", "record:a");
    const failure = /^The encrypted value could not be authenticated$/;
    // Missing, empty, and mismatched contexts are all authentication failures.
    expect(() => cipher.decrypt(bound.ciphertext)).toThrow(failure);
    expect(() => cipher.decrypt(bound.ciphertext, "")).toThrow(failure);
    expect(() => cipher.decrypt(bound.ciphertext, "record:b")).toThrow(failure);
    expect(() => cipher.decrypt(bound.ciphertext, "record:a ")).toThrow(failure);
    // An envelope written under a different key fails identically.
    const other = new ApplicationCipher(new Uint8Array(32).fill(99));
    expect(() => other.decrypt(bound.ciphertext, "record:a")).toThrow(failure);
    // Tampering with the authenticated key ID or the tag fails identically.
    const renamed = bound.ciphertext.replace("v2.im-2026-09.", "v2.im-2026-08.");
    expect(() => cipher.decrypt(renamed, "record:a")).toThrow(failure);
    const tagSeparator = bound.ciphertext.lastIndexOf(".");
    const tag = Buffer.from(bound.ciphertext.slice(tagSeparator + 1), "base64url");
    tag.writeUInt8(tag.readUInt8(0) ^ 1, 0);
    expect(() =>
      cipher.decrypt(`${bound.ciphertext.slice(0, tagSeparator + 1)}${tag.toString("base64url")}`, "record:a"),
    ).toThrow(failure);
  });

  it("keeps plaintext, ciphertext, and context out of error details", () => {
    const cipher = ringCipher("im-2026-09");
    const bound = cipher.encryptBound("plaintext-marker", "context-marker:record-1");
    for (const read of [
      () => cipher.decrypt(bound.ciphertext),
      () => cipher.decrypt(bound.ciphertext, "context-marker:record-2"),
      () => cipher.decrypt("v2.im-2026-09.invalid"),
    ]) {
      try {
        read();
        throw new Error("read should have failed");
      } catch (error) {
        const detail = JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack });
        expect(detail).not.toContain("plaintext-marker");
        expect(detail).not.toContain(bound.ciphertext.slice(15, 40));
        expect(detail).not.toContain("context-marker");
      }
    }
  });

  it("parses strictly: segment counts, key ID charset, canonical encodings, and lengths", () => {
    const cipher = ringCipher("im-2026-09");
    const bound = cipher.encryptBound("invite-secret", "record:a");
    const [, keyId = "", nonce = "", ciphertext = "", tag = ""] = bound.ciphertext.split(".");
    const unsupported = /^The encrypted value has an unsupported format$/;
    expect(() => cipher.decrypt(`${bound.ciphertext}.extra`, "record:a")).toThrow(unsupported);
    expect(() => cipher.decrypt(`v2.${keyId}.${nonce}.${ciphertext}`, "record:a")).toThrow(unsupported);
    expect(() => cipher.decrypt(`v2.BAD-ID.${nonce}.${ciphertext}.${tag}`, "record:a")).toThrow(unsupported);
    expect(() => cipher.decrypt(`v2..${nonce}.${ciphertext}.${tag}`, "record:a")).toThrow(unsupported);
    // Non-canonical base64url (padding, alphabet violations) is rejected before any key use.
    expect(() => cipher.decrypt(`v2.${keyId}.${nonce}==.${ciphertext}.${tag}`, "record:a")).toThrow(unsupported);
    expect(() => cipher.decrypt(`v2.${keyId}.${nonce}+.${ciphertext}.${tag}`, "record:a")).toThrow(unsupported);
    // Truncated nonce and tag fail the length checks.
    expect(() => cipher.decrypt(`v2.${keyId}.${nonce.slice(0, 8)}.${ciphertext}.${tag}`, "record:a")).toThrow(
      /authenticated/,
    );
    expect(() => cipher.decrypt(`v2.${keyId}.${nonce}.${ciphertext}.${tag.slice(0, 8)}`, "record:a")).toThrow(
      /authenticated/,
    );
  });

  it("reads v1 values with or without a context so staged rollouts can dual-read", () => {
    const legacy = new ApplicationCipher(legacyKey);
    const v1 = legacy.encrypt("invite-secret");
    const rotated = ringCipher("im-2026-09");
    expect(rotated.decrypt(v1)).toBe("invite-secret");
    expect(rotated.decrypt(v1, "im-binding-credential:feishu:binding-1")).toBe("invite-secret");
    // v1 values are only ever opened with the dedicated legacy key, never with ring material.
    const withoutLegacy = new ApplicationCipher({
      legacyKey: new Uint8Array(32).fill(3),
      keys: ringKeys,
      activeKeyId: "im-2026-09",
    });
    expect(() => withoutLegacy.decrypt(v1)).toThrow(/authenticated/);
  });

  it("writes new keys while reading retired ones, and denies unknown key IDs", () => {
    const retiring = ringCipher("im-2026-08");
    const oldValue = retiring.encryptBound("secret", "record:a");
    const current = ringCipher("im-2026-09");
    // Rotation keeps the retired ID in the ring: old values read, new values write the current ID.
    expect(current.decrypt(oldValue.ciphertext, "record:a")).toBe("secret");
    expect(current.encryptBound("secret", "record:a").keyId).toBe("im-2026-09");
    // Dropping the retired ID denies its envelopes without revealing why.
    const dropped = new ApplicationCipher({
      legacyKey,
      keys: { "im-2026-09": ringKeys["im-2026-09"] },
      activeKeyId: "im-2026-09",
    });
    expect(() => dropped.decrypt(oldValue.ciphertext, "record:a")).toThrow(
      /^The encrypted value could not be authenticated$/,
    );
  });

  it("keeps the credential write path on v1 by default and binds contexts only when opted into v2", () => {
    const context = "im-binding-credential:feishu:binding-1";
    const legacyDefault = ringCipher("im-2026-09", 1);
    const v1 = legacyDefault.encryptCredential("secret", context);
    expect(v1).toMatch(/^v1\./);
    expect(legacyDefault.decrypt(v1, context)).toBe("secret");
    const optedIn = ringCipher("im-2026-09", 2);
    const v2 = optedIn.encryptCredential("secret", context);
    expect(v2).toMatch(/^v2\.im-2026-09\./);
    expect(optedIn.decrypt(v2, context)).toBe("secret");
    expect(() => optedIn.decrypt(v2, "im-binding-credential:feishu:binding-2")).toThrow(/authenticated/);
    // The context is required even while writes stay on v1, so every caller is AAD aware.
    expect(() => legacyDefault.encryptCredential("secret", "")).toThrow(/context/);
  });

  it("copies key material and rejects malformed construction", () => {
    const source = new Uint8Array(32).fill(5);
    const cipher = new ApplicationCipher(source);
    const encrypted = cipher.encrypt("secret");
    source.fill(0);
    expect(cipher.decrypt(encrypted)).toBe("secret");
    const ringSource = new Uint8Array(32).fill(6);
    const rotated = new ApplicationCipher({ legacyKey, keys: { main: ringSource }, activeKeyId: "main" });
    const bound = rotated.encryptBound("secret", "record:a");
    ringSource.fill(0);
    expect(rotated.decrypt(bound.ciphertext, "record:a")).toBe("secret");

    expect(() => new ApplicationCipher(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(
      () =>
        new ApplicationCipher({
          legacyKey: new Uint8Array(31),
          keys: { main: new Uint8Array(32) },
          activeKeyId: "main",
        }),
    ).toThrow(/32 bytes/);
    expect(() => new ApplicationCipher({ legacyKey, keys: {}, activeKeyId: "main" })).toThrow(/at least one key/);
    expect(
      () => new ApplicationCipher({ legacyKey, keys: { main: new Uint8Array(32) }, activeKeyId: "other" }),
    ).toThrow(/active application encryption key ID/i);
    expect(
      () => new ApplicationCipher({ legacyKey, keys: { "BAD ID": new Uint8Array(32) }, activeKeyId: "BAD ID" }),
    ).toThrow(/invalid key ID/);
    expect(() => new ApplicationCipher({ legacyKey, keys: { main: new Uint8Array(16) }, activeKeyId: "main" })).toThrow(
      /32 bytes/,
    );
    expect(() => ringCipher("im-2026-09", 3 as never)).toThrow(/write version/);
    expect(() => cipher.encryptBound("secret", "")).toThrow(/context/);
    expect(() => cipher.encryptBound("secret", "x".repeat(513))).toThrow(/context/);
  });
});
