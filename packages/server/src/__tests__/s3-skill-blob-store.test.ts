import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3SkillBlobClient, S3SkillBlobStore, SkillServiceError } from "../services/skills/index.js";

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function notFound(name = "NoSuchKey") {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

function store(send: (command: Command) => Promise<unknown>) {
  const client = { send: vi.fn(send as (command: unknown) => Promise<unknown>) };
  return { client, store: new S3SkillBlobStore({ bucket: "skills-bucket", prefix: "skills/", client }) };
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("S3SkillBlobStore", () => {
  it("puts objects under the prefix with the zip content type and the sha256 as metadata", async () => {
    const { client, store: blobs } = store(async () => ({}));
    await blobs.put("owner/skill/digest.zip", Uint8Array.from([1, 2, 3]), "abc");
    const command = client.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "skills-bucket",
      Key: "skills/owner/skill/digest.zip",
      ContentType: "application/zip",
      ContentLength: 3,
      Metadata: { sha256: "abc" },
    });
  });

  it("opens an object as a stream with its content length and maps a missing key to undefined", async () => {
    const { client, store: blobs } = store(async (command) => {
      if (command instanceof GetObjectCommand && command.input.Key === "skills/present.zip") {
        return { Body: Readable.from([Buffer.from("zip-bytes")]), ContentLength: 9 };
      }
      throw notFound();
    });
    const opened = await blobs.open("present.zip");
    expect(opened?.contentLength).toBe(9);
    expect(await collect(opened?.stream as Readable)).toBe("zip-bytes");
    expect(await blobs.open("absent.zip")).toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("treats delete as idempotent and reports head metadata", async () => {
    const { client, store: blobs } = store(async (command) => {
      if (command instanceof DeleteObjectCommand) throw notFound();
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === "skills/absent.zip") throw notFound("NotFound");
        return { ContentLength: 42, LastModified: new Date("2026-09-11T00:00:00Z") };
      }
      throw new Error("unexpected");
    });
    await expect(blobs.delete("gone.zip")).resolves.toBeUndefined();
    expect(await blobs.head("present.zip")).toEqual({ size: 42, lastModified: new Date("2026-09-11T00:00:00Z") });
    expect(await blobs.head("absent.zip")).toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it("lists every page under the prefix and strips the prefix from returned keys", async () => {
    const { client, store: blobs } = store(async (command) => {
      const input = (command as unknown as ListObjectsV2Command).input;
      expect(input.Prefix).toBe("skills/owner/");
      if (!input.ContinuationToken) {
        return {
          Contents: [{ Key: "skills/owner/a.zip", Size: 1, LastModified: new Date(1) }],
          IsTruncated: true,
          NextContinuationToken: "page-2",
        };
      }
      return { Contents: [{ Key: "skills/owner/b.zip", Size: 2, LastModified: new Date(2) }], IsTruncated: false };
    });
    expect(await blobs.list("owner/")).toEqual([
      { key: "owner/a.zip", size: 1, lastModified: new Date(1) },
      { key: "owner/b.zip", size: 2, lastModified: new Date(2) },
    ]);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("maps any other SDK failure to SKILL_STORAGE_UNAVAILABLE", async () => {
    const { store: blobs } = store(async () => {
      throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    });
    await expect(blobs.put("k", new Uint8Array(), "s")).rejects.toMatchObject({
      code: "SKILL_STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(blobs.open("k")).rejects.toBeInstanceOf(SkillServiceError);
    await expect(blobs.healthCheck()).rejects.toMatchObject({ code: "SKILL_STORAGE_UNAVAILABLE" });
  });

  it("health-checks the bucket with HeadBucket", async () => {
    const { client, store: blobs } = store(async () => ({}));
    await blobs.healthCheck();
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it("builds an SDK client configured for GCS interoperability", async () => {
    const client = createS3SkillBlobClient({
      bucket: "b",
      endpoint: "https://storage.googleapis.com",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "secret",
      prefix: "skills/",
      forcePathStyle: true,
    });
    const config = client.config as {
      requestChecksumCalculation(): Promise<string>;
      responseChecksumValidation(): Promise<string>;
      forcePathStyle: boolean | (() => Promise<boolean>);
      region(): Promise<string>;
    };
    expect(await config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
    const forcePathStyle = config.forcePathStyle;
    expect(typeof forcePathStyle === "function" ? await forcePathStyle() : forcePathStyle).toBe(true);
    expect(await config.region()).toBe("auto");
    client.destroy();
  });
});
