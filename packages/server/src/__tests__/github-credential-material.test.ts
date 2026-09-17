import { describe, expect, it } from "vitest";
import { ApplicationCipher } from "../services/crypto.js";
import { GitHubCredentialCipher, type GitHubUserCredentialBinding } from "../services/github-credential-material.js";

const cipher = new ApplicationCipher(new Uint8Array(32).fill(7));
const material = new GitHubCredentialCipher(cipher);
const binding: GitHubUserCredentialBinding = {
  connectionId: "aabbccdd-1234-4234-8234-123456789abc",
  accountId: "aabbccdd-1234-4234-8234-123456789abd",
  githubHost: "github.com",
  appId: "123",
  githubUserId: "456",
};
const credential = { accessToken: "access-secret", refreshToken: "refresh-secret" };
const oauthBinding = {
  connectionId: binding.connectionId,
  accountId: binding.accountId,
  githubHost: binding.githubHost,
  appId: binding.appId,
  flowId: "aabbccdd-1234-4234-8234-123456789abe",
};

describe("GitHub credential material", () => {
  it("seals the access/refresh pair in v2 even while IM remains on v1 writes", () => {
    const encrypted = material.encryptUserCredential(binding, credential);
    expect(encrypted.ciphertext).toMatch(/^v2\./);
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(material.decryptUserCredential(binding, encrypted)).toEqual(credential);
  });

  it.each([
    { connectionId: "aabbccdd-1234-4234-8234-123456789abf" },
    { accountId: "aabbccdd-1234-4234-8234-123456789abf" },
    { appId: "124" },
    { githubUserId: "457" },
  ])("rejects moving the encrypted pair to a different identity %j", (other) => {
    const encrypted = material.encryptUserCredential(binding, credential);
    expect(() => material.decryptUserCredential({ ...binding, ...other }, encrypted)).toThrow(/authenticated/);
  });

  it("rejects key metadata mismatch and legacy envelopes", () => {
    const encrypted = material.encryptUserCredential(binding, credential);
    expect(() => material.decryptUserCredential(binding, { ...encrypted, keyId: "other" })).toThrow(/authenticated/);
    expect(() =>
      material.decryptUserCredential(binding, {
        ciphertext: cipher.encrypt(JSON.stringify(credential)),
        keyId: "default",
      }),
    ).toThrow(/authenticated/);
  });

  it("binds PKCE to the exact flow and a distinct purpose", () => {
    const verifier = "v".repeat(43);
    const encrypted = material.encryptOAuthSecret(oauthBinding, verifier);
    expect(material.decryptOAuthSecret(oauthBinding, encrypted)).toBe(verifier);
    expect(() => material.decryptOAuthSecret({ ...oauthBinding, flowId: binding.accountId }, encrypted)).toThrow(
      /authenticated/,
    );
    expect(() => material.decryptUserCredential(binding, encrypted)).toThrow(/authenticated/);
  });

  it("does not include malformed decrypted JSON or secret input in errors", () => {
    expect(() => material.encryptUserCredential(binding, { ...credential, refreshToken: "" })).toThrow(
      "GitHub credential material could not be encrypted",
    );
    const encrypted = material.encryptUserCredential(binding, credential);
    expect(() => material.decryptUserCredential(binding, { ...encrypted, ciphertext: "access-secret" })).toThrow(
      "GitHub credential material could not be authenticated",
    );
  });
});
