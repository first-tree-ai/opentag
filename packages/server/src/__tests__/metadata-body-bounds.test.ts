import { expect, it } from "vitest";
import { createChannelTargetPoller } from "../services/channel-target/index.js";
import { S3SkillObjectStore } from "../services/skills/index.js";

function streamed(prefix: string, units: number, suffix: string, unit = "x") {
  const encoder = new TextEncoder();
  let remaining = units,
    phase = 0,
    bytes = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        let text: string;
        if (phase === 0) {
          text = prefix;
          phase = 1;
        } else if (remaining > 0) {
          const size = Math.min(4096, remaining);
          text = unit.repeat(size);
          remaining -= size;
        } else {
          text = suffix;
          phase = 2;
        }
        const chunk = encoder.encode(text);
        bytes += chunk.length;
        controller.enqueue(chunk);
        if (phase === 2) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, bytes: () => bytes, cancelled: () => cancelled };
}
function pointer(version: string) {
  return Response.json({ channel: "staging", version });
}
function store(fetcher: typeof fetch) {
  return new S3SkillObjectStore({
    config: {
      endpoint: "https://objects.test",
      region: "test",
      bucket: "skills",
      accessKeyId: "fixture",
      secretAccessKey: "fixture",
      forcePathStyle: true,
    },
    fetch: fetcher,
  });
}

it.each(["x", "π"])("bounds a Channel body in bytes without Content-Length and recovers for %s", async (unit) => {
  const body = streamed('{"channel":"staging","version":"0.0.4","ignored":"', 512 * 1024, '"}', unit);
  const responses = [pointer("0.0.3"), new Response(body.stream), pointer("0.0.5")];
  const poller = createChannelTargetPoller({
    channel: "staging",
    downloadBaseUrl: "https://download.test",
    intervalMs: 60000,
    fetchImpl: (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected retry");
      return response;
    }) as typeof fetch,
  });
  await poller.refresh();
  expect(poller.get()?.version).toBe("0.0.3");
  await poller.refresh();
  expect(poller.get()?.version).toBe("0.0.3");
  expect(body.cancelled()).toBe(true);
  expect(body.bytes()).toBeLessThanOrEqual(256 * 1024 + 8192);
  await poller.refresh();
  expect(poller.get()?.version).toBe("0.0.5");
  poller.stop();
});

it("cancels a non-OK Channel body and retains the last good target", async () => {
  const body = streamed("", 1024 * 1024, "");
  const responses = [pointer("0.0.3"), new Response(body.stream, { status: 503 }), pointer("0.0.4")];
  const poller = createChannelTargetPoller({
    channel: "staging",
    downloadBaseUrl: "https://download.test",
    intervalMs: 60000,
    fetchImpl: (async () => responses.shift() as Response) as typeof fetch,
  });
  await poller.refresh();
  await poller.refresh();
  expect(poller.get()?.version).toBe("0.0.3");
  expect(body.cancelled()).toBe(true);
  expect(body.bytes()).toBe(0);
  await poller.refresh();
  expect(poller.get()?.version).toBe("0.0.4");
  poller.stop();
});

it.each(["x", "π"])("bounds S3 LIST in bytes before decode and recovers for %s", async (unit) => {
  const body = streamed("<ListBucketResult><Ignored>", 5 * 1024 * 1024, "</Ignored></ListBucketResult>", unit);
  const responses = [
    new Response(body.stream),
    new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"),
  ];
  const objects = store((async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected retry");
    return response;
  }) as typeof fetch);
  await expect(objects.list("skills/")).rejects.toMatchObject({ code: "invalid_response" });
  expect(body.cancelled()).toBe(true);
  expect(body.bytes()).toBeLessThanOrEqual(4 * 1024 * 1024 + 8192);
  expect(await objects.list("skills/")).toEqual({ objects: [] });
});

it("preserves split UTF-8 S3 keys within the body bound", async () => {
  const data = new TextEncoder().encode(
    "<ListBucketResult><Contents><Key>skills/π.tar.gz</Key><LastModified>2026-11-03T00:00:00Z</LastModified><Size>7</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>",
  );
  let offset = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === data.length) controller.close();
        else controller.enqueue(data.subarray(offset, ++offset));
      },
    }),
  );
  const result = await store((async () => response) as typeof fetch).list("skills/");
  expect(result.objects).toEqual([
    { key: "skills/π.tar.gz", bytes: 7, lastModified: new Date("2026-11-03T00:00:00Z") },
  ]);
});

it("preserves the existing empty LIST response behavior", async () => {
  expect(await store((async () => new Response(null)) as typeof fetch).list("skills/")).toEqual({ objects: [] });
});
