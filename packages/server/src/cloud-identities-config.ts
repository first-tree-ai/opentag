import { SemVerStringSchema } from "@opentag/shared";

const GCS_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const GCS_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const CLOUD_STORAGE_BASE_MAX_LENGTH = 1024;
const CLOUD_RUNNER_VERSION_MAX_LENGTH = 64;

function isSafeGcsPathSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && GCS_PATH_SEGMENT_PATTERN.test(segment);
}

/**
 * Durable Cloud storage prefix: `gs://bucket` or `gs://bucket/prefix`.
 * Rejects credentials, query, fragment, and `.` / `..` path traversal. Does not accept a trailing slash.
 */
export function parseCloudStorageBase(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed !== value && value.length > 0) return undefined;
  if (!trimmed.startsWith("gs://") || /[?#\\]/.test(trimmed) || trimmed.length > CLOUD_STORAGE_BASE_MAX_LENGTH) {
    return undefined;
  }
  const rest = trimmed.slice("gs://".length);
  if (!rest || rest.includes("@")) return undefined;
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash + 1);
  if (!GCS_BUCKET_PATTERN.test(bucket)) return undefined;
  if (rest.endsWith("/")) return undefined;
  const segments = path.length === 0 ? [] : path.split("/");
  if (segments.some((segment) => segment.length === 0 || !isSafeGcsPathSegment(segment))) return undefined;
  return segments.length === 0 ? `gs://${bucket}` : `gs://${bucket}/${segments.join("/")}`;
}

export const CloudRunnerVersionSchema = SemVerStringSchema.max(CLOUD_RUNNER_VERSION_MAX_LENGTH);
