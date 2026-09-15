import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { SkillStorageConfig } from "../../config.js";
import { skillStorageUnavailable } from "./errors.js";
import type { OpenedSkillBlob, SkillBlobHead, SkillBlobObject, SkillBlobStore } from "./skill-blob-store.js";

/** The one SDK seam the store needs, so tests inject a fake instead of a network. */
export interface S3SkillBlobClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3SkillBlobStoreOptions {
  bucket: string;
  /** Prepended to every key; empty or ending in `/`. */
  prefix: string;
  client: S3SkillBlobClient;
}

interface S3ErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as S3ErrorLike;
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchBucket" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * Build the SDK client for an S3-compatible endpoint. Checksums stay `WHEN_REQUIRED`: newer SDKs otherwise attach
 * CRC32 trailers that the Google Cloud Storage XML API rejects, and object bodies are already sha256-addressed.
 */
export function createS3SkillBlobClient(config: SkillStorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export class S3SkillBlobStore implements SkillBlobStore {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3SkillBlobClient;

  constructor(options: S3SkillBlobStoreOptions) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix;
    this.#client = options.client;
  }

  static fromConfig(config: SkillStorageConfig, client: S3SkillBlobClient = createS3SkillBlobClient(config)) {
    return new S3SkillBlobStore({ bucket: config.bucket, prefix: config.prefix, client });
  }

  async healthCheck(): Promise<void> {
    await this.#send(new HeadBucketCommand({ Bucket: this.#bucket }));
  }

  async put(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
    await this.#send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#objectKey(key),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "application/zip",
        Metadata: { sha256 },
      }),
    );
  }

  async open(key: string): Promise<OpenedSkillBlob | undefined> {
    const response = await this.#sendOrNotFound(
      new GetObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
    );
    if (!response) return undefined;
    const { Body, ContentLength } = response as { Body?: unknown; ContentLength?: number };
    if (!(Body instanceof Readable) || typeof ContentLength !== "number") throw skillStorageUnavailable();
    return { stream: Body, contentLength: ContentLength };
  }

  async delete(key: string): Promise<void> {
    await this.#sendOrNotFound(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }));
  }

  async head(key: string): Promise<SkillBlobHead | undefined> {
    const response = await this.#sendOrNotFound(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
    );
    if (!response) return undefined;
    const { ContentLength, LastModified } = response as { ContentLength?: number; LastModified?: Date };
    return { size: ContentLength ?? 0, lastModified: LastModified ?? new Date(0) };
  }

  async list(prefix: string): Promise<SkillBlobObject[]> {
    const objects: SkillBlobObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = (await this.#send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#objectKey(prefix),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      )) as {
        Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const item of page.Contents ?? []) {
        if (typeof item.Key !== "string" || !item.Key.startsWith(this.#prefix)) continue;
        objects.push({
          key: item.Key.slice(this.#prefix.length),
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? new Date(0),
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  #objectKey(key: string): string {
    return `${this.#prefix}${key}`;
  }

  async #send(command: unknown): Promise<unknown> {
    try {
      return await this.#client.send(command);
    } catch {
      throw skillStorageUnavailable();
    }
  }

  async #sendOrNotFound(command: unknown): Promise<unknown | undefined> {
    try {
      return await this.#client.send(command);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw skillStorageUnavailable();
    }
  }
}
