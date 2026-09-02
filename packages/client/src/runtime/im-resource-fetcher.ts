import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DirectImMessageDeliveryRequest, RuntimeImSteerRequest } from "@opentag/shared";
import type { OpenTagApi } from "../api.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

export class ImResourceFetcher {
  readonly #api?: Pick<OpenTagApi, "openImResource">;
  readonly #instanceId: string;
  readonly #machineToken?: string;
  readonly #logger: ClientLogger;

  constructor(input: {
    instanceId: string;
    api?: Pick<OpenTagApi, "openImResource">;
    machineToken?: string;
    logger?: ClientLogger;
  }) {
    this.#api = input.api;
    this.#instanceId = input.instanceId;
    this.#machineToken = input.machineToken;
    this.#logger = input.logger ?? createLogger("runtime-im-resource-fetcher");
  }

  async fetchForTurn(
    request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest,
    workspace: string,
  ): Promise<string | undefined> {
    const resources = request.content.resources ?? [];
    if (resources.length === 0) return undefined;
    const lines: string[] = ["OpenTag IM resources (managed, user-supplied content):"];
    for (const resource of resources) {
      const resourceLabel = `${resource.imMessageId}:${resource.ordinal}`;
      if (resource.availability !== "available") {
        lines.push(`- ${resourceLabel}: unavailable (${resource.availability})`);
        continue;
      }
      if (!this.#api || !this.#machineToken) {
        lines.push(`- ${resourceLabel}: unavailable (runtime resource client is not configured)`);
        continue;
      }
      const filename = safeFilename(resource.filename ?? `${resource.ordinal}.${resource.kind}`);
      const directory = resolve(workspace, ".opentag", "im-resources", request.deliveryId);
      const target = join(directory, `${resource.imMessageId}-${resource.ordinal}-${filename}`);
      const temporary = join(directory, `.${resource.imMessageId}-${resource.ordinal}-${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          await access(target);
          lines.push(`- ${resourceLabel}: ${target}`);
          continue;
        } catch (error) {
          this.#logger.debug(
            { code: "resource_target_missing", error: String(error) },
            "IM resource target is not published",
          );
          // A complete target is published only after a private temporary download succeeds.
        }
        const response = await this.#api.openImResource(this.#machineToken, resource.imMessageId, resource.ordinal, {
          sessionId: request.sessionId,
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
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        await rename(temporary, target);
        lines.push(`- ${resourceLabel}: ${target}`);
      } catch (error) {
        this.#logger.debug({ code: "resource_download_failed", error: String(error) }, "IM resource download failed");
        await rm(temporary, { force: true }).catch((cleanupError: unknown) => {
          this.#logger.debug(
            {
              code: "resource_temp_cleanup_failed",
              error: String(cleanupError),
            },
            "IM resource temporary file cleanup failed",
          );
        });
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
