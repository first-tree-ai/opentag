import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class ApplicationCipher {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("The application encryption key must contain exactly 32 bytes");
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, nonce.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(
      ".",
    );
  }

  decrypt(value: string): string {
    const [version, nonceText, ciphertextText, tagText, ...extra] = value.split(".");
    if (version !== VERSION || !nonceText || !ciphertextText || !tagText || extra.length > 0) {
      throw new Error("The encrypted value has an unsupported format");
    }
    try {
      const nonce = Buffer.from(nonceText, "base64url");
      const ciphertext = Buffer.from(ciphertextText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("Invalid encrypted value");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("The encrypted value could not be authenticated");
    }
  }
}
