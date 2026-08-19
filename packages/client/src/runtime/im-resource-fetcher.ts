import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import type { OpenTagApi } from "../api.js";
import type { AccessTokenProvider } from "../auth/token-provider.js";

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

export class ImResourceFetcher {
  readonly #api?: Pick<OpenTagApi, "openImResource">;
  readonly #computerId: string;
  readonly #instanceId: string;
  readonly #tokens?: Pick<AccessTokenProvider, "getAccessTokenLease">;

  constructor(input: {
    computerId: string;
    instanceId: string;
    api?: Pick<OpenTagApi, "openImResource">;
    tokenProvider?: Pick<AccessTokenProvider, "getAccessTokenLease">;
  }) {
    this.#api = input.api;
    this.#computerId = input.computerId;
    this.#instanceId = input.instanceId;
    this.#tokens = input.tokenProvider;
  }

  async fetchForTurn(request: DirectImMessageDeliveryRequest, workspace: string): Promise<string | undefined> {
    const resources = request.content.resources ?? [];
    if (resources.length === 0) return undefined;
    const lines: string[] = ["OpenTag IM resources (managed, user-supplied content):"];
    for (const resource of resources) {
      const resourceLabel = `${resource.imMessageId}:${resource.ordinal}`;
      if (resource.availability !== "available") {
        lines.push(`- ${resourceLabel}: unavailable (${resource.availability})`);
        continue;
      }
      if (!this.#api || !this.#tokens) {
        lines.push(`- ${resourceLabel}: unavailable (runtime resource client is not configured)`);
        continue;
      }
      const filename = safeFilename(resource.filename ?? `${resource.ordinal}.${resource.kind}`);
      const directory = resolve(workspace, ".opentag", "im-resources");
      const target = join(directory, `${resource.imMessageId}-${resource.ordinal}-${filename}`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const lease = await this.#tokens.getAccessTokenLease();
        const response = await this.#api.openImResource(lease.accessToken, resource.imMessageId, resource.ordinal, {
          sessionId: request.sessionId,
          computerId: this.#computerId,
          instanceId: this.#instanceId,
          placementGeneration: request.placementGeneration,
        });
        if (!response.body) throw new Error("resource body unavailable");
        let observed = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            observed += chunk.byteLength;
            callback(observed <= MAX_RESOURCE_BYTES ? null : new Error("resource too large"), chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          limiter,
          createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
        lines.push(`- ${resourceLabel}: ${target}`);
      } catch {
        await rm(target, { force: true }).catch(() => undefined);
        lines.push(`- ${resourceLabel}: unavailable (download failed)`);
      }
    }
    return lines.join("\n");
  }
}

function safeFilename(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return sanitized || "resource.bin";
}
