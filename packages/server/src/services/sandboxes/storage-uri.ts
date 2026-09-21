const SANDBOX_STORAGE_URI_MAX_LENGTH = 2048;

export function sandboxStorageUri(storageBase: string, sandboxId: string): string {
  const uri = `${storageBase}/${sandboxId}`;
  if (uri.length < 1 || uri.length > SANDBOX_STORAGE_URI_MAX_LENGTH) {
    throw new Error("Sandbox storage URI exceeds the durable address bound");
  }
  return uri;
}
