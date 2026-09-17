import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_V1 = "v1";
const VERSION_V2 = "v2";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CONTEXT_LENGTH = 512;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Ring ID of the implicit one-key ring a bare-key cipher writes v2 envelopes with. */
const IMPLICIT_KEY_ID = "default";

const FORMAT_ERROR = "The encrypted value has an unsupported format";
const AUTHENTICATION_ERROR = "The encrypted value could not be authenticated";
const KEY_LENGTH_ERROR = "The application encryption key must contain exactly 32 bytes";

export interface ApplicationCipherKeyRingOptions {
  /**
   * Dedicated key for the legacy v1 envelope. v1 values are only ever opened with this key and the
   * ring is never consulted for them, so rotating the ring cannot strand legacy ciphertext.
   */
  legacyKey: Uint8Array;
  /**
   * v2 keys by stable key ID. Retired IDs stay in the ring for reads until every v2 ciphertext
   * written with them has rotated away; an envelope that names an unknown ID is denied.
   */
  keys: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;
  /** Ring ID every new v2 envelope is written with. */
  activeKeyId: string;
  /**
   * IM credential material writes stay on the legacy v1 envelope until a deployment opts into
   * v2; reads accept both envelopes either way. Only the explicit write helpers consult this.
   */
  writeVersion?: 1 | 2;
}

function copyKey(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new Error(KEY_LENGTH_ERROR);
  return Buffer.from(key);
}

function canonicalSegment(text: string): Buffer {
  const decoded = Buffer.from(text, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== text) throw new Error(FORMAT_ERROR);
  return decoded;
}

function aadContext(context: string): string {
  if (typeof context !== "string" || context.length === 0 || context.length > MAX_CONTEXT_LENGTH) {
    throw new Error("The encryption context must be a non-empty string of at most 512 characters");
  }
  return context;
}

/** The exact bytes a v2 envelope authenticates: envelope version, key ID, and caller context. */
function v2AssociatedData(keyId: string, context: string): Buffer {
  return Buffer.from(`${VERSION_V2}.${keyId}.${context}`, "utf8");
}

export class ApplicationCipher {
  readonly #legacyKey: Buffer;
  readonly #ring: ReadonlyMap<string, Buffer>;
  readonly #activeKeyId: string;
  readonly #writeVersion: 1 | 2;

  constructor(key: Uint8Array);
  constructor(options: ApplicationCipherKeyRingOptions);
  constructor(keyOrOptions: Uint8Array | ApplicationCipherKeyRingOptions) {
    if (keyOrOptions instanceof Uint8Array) {
      this.#legacyKey = copyKey(keyOrOptions);
      this.#ring = new Map([[IMPLICIT_KEY_ID, Buffer.from(this.#legacyKey)]]);
      this.#activeKeyId = IMPLICIT_KEY_ID;
      this.#writeVersion = 1;
      return;
    }
    this.#legacyKey = copyKey(keyOrOptions.legacyKey);
    const source = keyOrOptions.keys;
    const entries = source instanceof Map ? [...source.entries()] : Object.entries(source ?? {});
    if (entries.length === 0) {
      throw new Error("The application encryption key ring must contain at least one key");
    }
    const ring = new Map<string, Buffer>();
    for (const [keyId, key] of entries) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error("The application encryption key ring contains an invalid key ID");
      }
      ring.set(keyId, copyKey(key));
    }
    if (!ring.has(keyOrOptions.activeKeyId)) {
      throw new Error("The active application encryption key ID must name a key in the key ring");
    }
    if (keyOrOptions.writeVersion !== undefined && keyOrOptions.writeVersion !== 1 && keyOrOptions.writeVersion !== 2) {
      throw new Error("The credential encryption write version must be 1 or 2");
    }
    this.#ring = ring;
    this.#activeKeyId = keyOrOptions.activeKeyId;
    this.#writeVersion = keyOrOptions.writeVersion ?? 1;
  }

  /** Legacy v1 envelope under the dedicated legacy key. No key ID, no AAD. */
  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#legacyKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION_V1, nonce.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(
      ".",
    );
  }

  /**
   * Authenticated v2 envelope under the active ring key. The context is authenticated as AAD
   * together with the envelope version and key ID; the same context must be presented to read.
   */
  encryptBound(plaintext: string, context: string): { ciphertext: string; keyId: string } {
    const associatedData = v2AssociatedData(this.#activeKeyId, aadContext(context));
    const key = this.#ring.get(this.#activeKeyId);
    if (!key) throw new Error("The active application encryption key is not in the key ring");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: [
        VERSION_V2,
        this.#activeKeyId,
        nonce.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join("."),
      keyId: this.#activeKeyId,
    };
  }

  /**
   * Credential-material write path. Writes stay on the legacy v1 envelope for a staged rollout
   * unless the deployment opted into v2; the context is always required so every caller is AAD
   * aware before a single v2 value exists. Reads accept both envelopes either way.
   */
  encryptCredential(plaintext: string, context: string): string {
    if (this.#writeVersion === 2) return this.encryptBound(plaintext, context).ciphertext;
    aadContext(context);
    return this.encrypt(plaintext);
  }

  /**
   * Opens either envelope. v1 values carry no AAD and open with the legacy key regardless of
   * context. v2 values require the exact nonempty context they were written with; a missing or
   * mismatched context, an unknown key ID, and any tampering all fail with the same error.
   */
  decrypt(value: string, context?: string): string {
    const segments = value.split(".");
    if (segments[0] === VERSION_V1) {
      const [, nonceText, ciphertextText, tagText, ...extra] = segments;
      if (!nonceText || !ciphertextText || !tagText || extra.length > 0) throw new Error(FORMAT_ERROR);
      return this.#open(this.#legacyKey, nonceText, ciphertextText, tagText, undefined);
    }
    if (segments[0] === VERSION_V2) {
      const [, keyId, nonceText, ciphertextText, tagText, ...extra] = segments;
      if (!keyId || !KEY_ID_PATTERN.test(keyId) || !nonceText || !ciphertextText || !tagText || extra.length > 0) {
        throw new Error(FORMAT_ERROR);
      }
      const key = this.#ring.get(keyId);
      if (!key || !context) throw new Error(AUTHENTICATION_ERROR);
      return this.#open(key, nonceText, ciphertextText, tagText, v2AssociatedData(keyId, context));
    }
    throw new Error(FORMAT_ERROR);
  }

  #open(key: Buffer, nonceText: string, ciphertextText: string, tagText: string, aad: Buffer | undefined): string {
    // Non-canonical encodings are rejected at parse level; everything after is one uniform
    // authentication failure so a reader learns nothing about which check failed.
    const nonce = canonicalSegment(nonceText);
    const ciphertext = canonicalSegment(ciphertextText);
    const tag = canonicalSegment(tagText);
    try {
      if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) throw new Error("Invalid encrypted value");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(AUTHENTICATION_ERROR);
    }
  }
}
