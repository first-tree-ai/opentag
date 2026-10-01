import { OpenTagApiError } from "../api.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { abortError, RuntimeConnectionError, RuntimeSendError } from "./runtime-connection-errors.js";

export function listenerFailureCategory(error: unknown): string {
  if (error instanceof RuntimeStorageError) return `runtime_storage_${error.code}`;
  if (error instanceof RuntimeSendError) return `runtime_send_${error.code}`;
  if (error instanceof RuntimeConnectionError) return "runtime_connection";
  return error instanceof Error ? "error" : "non_error";
}

export function connectionErrorCategory(error: unknown): string {
  if (error instanceof OpenTagApiError) return error.category;
  if (error instanceof RuntimeConnectionError) return error.category;
  if (error instanceof RuntimeSendError) return error.code;
  return "unexpected";
}

export function withoutConnectionId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const frame = { ...(value as Record<string, unknown>) };
  delete frame.connectionId;
  return frame;
}

export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
