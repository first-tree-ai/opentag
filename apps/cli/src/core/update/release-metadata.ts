import type { ChannelName, RuntimeChannelTarget } from "@opentag/shared";
import { parseSemVer } from "@opentag/shared";
import { DEFAULT_DOWNLOAD_BASE_URL } from "./portable-installer.js";

export class ReleaseMetadataError extends Error {
  override readonly name = "ReleaseMetadataError";
}

export interface PortableReleaseTargetOptions {
  channel: ChannelName;
  environment?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** Read and validate the immutable identity advertised by the configured portable channel. */
export async function resolvePortableReleaseTarget(
  options: PortableReleaseTargetOptions,
): Promise<RuntimeChannelTarget> {
  const environment = options.environment ?? process.env;
  const base = (environment.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL ?? DEFAULT_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/${options.channel}/latest.json`;
  const body = await fetchJson(options.fetchFn ?? fetch, url, "the channel release pointer");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ReleaseMetadataError("The channel release pointer is malformed");
  }
  const pointer = body as Record<string, unknown>;
  if (pointer.channel !== options.channel) {
    throw new ReleaseMetadataError("The channel release pointer belongs to another channel");
  }
  if (typeof pointer.version !== "string" || !parseSemVer(pointer.version)) {
    throw new ReleaseMetadataError("The exact channel target is missing or invalid in the channel release pointer");
  }
  return { channel: options.channel, version: pointer.version };
}

async function fetchJson(fetchFn: typeof fetch, url: string, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new ReleaseMetadataError(
      `Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new ReleaseMetadataError(`Could not read ${label} (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new ReleaseMetadataError(`The response from ${label} is not valid JSON`);
  }
}
