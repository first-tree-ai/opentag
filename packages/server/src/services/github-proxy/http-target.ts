import { GitPublicationError } from "./git-packets.js";

const CREDENTIAL_PATH = /^\/(?:login|applications|app|app-manifests|installation|authorizations)(?:\/|$)/i;
const GIT_PATH = /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
export const GITHUB_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "results-receiver.actions.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
]);
// GitHub documents this Actions storage family; a single observed shard is not stable.
// https://github.blog/changelog/2023-01-31-github-actions-job-summary-updates/
// Only trusted upstream GET/HEAD redirects reach this check, without account credentials.
const ACTIONS_STORAGE_HOST = /^productionresultssa\d+\.blob\.core\.windows\.net$/;

/** Parse once; the checked URL is also the exact URL passed to the HTTP client. */
export function githubRequestTarget(origin: string | undefined, path: string, method: string): URL {
  if (
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\s#]/.test(path) ||
    (origin !== "api.github.com" && origin !== "github.com")
  )
    throw new GitPublicationError("invalid_request");
  const url = new URL(path, `https://${origin}`);
  if (url.origin !== `https://${origin}` || url.username || url.password)
    throw new GitPublicationError("invalid_request");
  const normalized = decodedPath(url, origin);
  if (origin === "github.com") validateGitPath(normalized, method);
  return url;
}

function validateGitPath(path: string, method: string): void {
  if (!GIT_PATH.test(path) || (path.endsWith("/info/refs") ? !["GET", "HEAD"].includes(method) : method !== "POST"))
    throw new GitPublicationError("invalid_request");
}
function decodedPath(url: URL, origin: string): string {
  let decoded = url.pathname;
  // Check encoded control-plane spellings without inspecting opaque business query values.
  for (let depth = 0; depth < 4; depth++) {
    if (/[\\\r\n]/.test(decoded)) throw new GitPublicationError("invalid_request");
    const checked = new URL(decoded, url.origin);
    if (checked.origin !== url.origin) throw new GitPublicationError("invalid_request");
    if (origin === "api.github.com" && CREDENTIAL_PATH.test(checked.pathname))
      throw new GitPublicationError("scope_denied");
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new GitPublicationError("invalid_request");
    }
    if (next === decoded) return checked.pathname;
    decoded = next;
  }
  throw new GitPublicationError("invalid_request");
}

export function allowedDownloadTarget(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    (GITHUB_DOWNLOAD_HOSTS.has(url.hostname) || ACTIONS_STORAGE_HOST.test(url.hostname))
  );
}
