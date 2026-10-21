import type {
  GitHubDiscoveredInstallation,
  GitHubDiscoveredRepository,
  GitHubRepositoryDiscoveryPage,
} from "@opentag/shared/browser";

export const REPOSITORIES_PER_BATCH = 100;
const MAX_PAGES_PER_BATCH = 10;

export type RepositoryCatalog = {
  repositories: GitHubDiscoveredRepository[];
  visibleCount: number;
  installations: GitHubDiscoveredInstallation[];
  nextCursor: string | null;
  incomplete: boolean;
};

type ReadPage = (cursor: string | undefined, signal: AbortSignal) => Promise<GitHubRepositoryDiscoveryPage>;

function installationSignature(installations: GitHubDiscoveredInstallation[]) {
  return installations
    .map((entry) => `${entry.installationId}:${entry.suspended}`)
    .sort()
    .join(",");
}

function mergePage(previous: RepositoryCatalog | undefined, page: GitHubRepositoryDiscoveryPage, target: number) {
  const active = new Set(page.installations.filter((entry) => !entry.suspended).map((entry) => entry.installationId));
  const repositories = new Map(
    [...(previous?.repositories ?? []), ...page.repositories]
      .filter((entry) => active.has(entry.installationId) && (entry.permissions.pull || entry.permissions.push))
      .map((entry) => [entry.repositoryId, entry]),
  );
  const changed =
    previous !== undefined &&
    installationSignature(previous.installations) !== installationSignature(page.installations);
  return {
    repositories: [...repositories.values()],
    visibleCount: Math.min(target, repositories.size),
    installations: page.installations,
    nextCursor: page.nextCursor,
    incomplete: Boolean(
      previous?.incomplete ||
        changed ||
        page.installationsTruncated !== false ||
        page.truncatedInstallations === undefined ||
        page.truncatedInstallations.length > 0,
    ),
  };
}

/** Merge provider pages into 100-row batches, looking ahead before offering Load more. */
export async function readRepositoryBatch({
  previous,
  target,
  readPage,
  signal,
  onProgress,
}: {
  previous?: RepositoryCatalog;
  target: number;
  readPage: ReadPage;
  signal: AbortSignal;
  onProgress: (catalog: RepositoryCatalog) => void;
}): Promise<RepositoryCatalog> {
  let catalog = previous ? { ...previous, visibleCount: Math.min(target, previous.repositories.length) } : undefined;
  if (catalog) onProgress(catalog);
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES_PER_BATCH; page += 1) {
    signal.throwIfAborted();
    if (catalog && (catalog.repositories.length > target || catalog.nextCursor === null)) break;
    const cursor = catalog?.nextCursor ?? undefined;
    if (cursor !== undefined && seenCursors.has(cursor)) throw new Error("GitHub discovery repeated a cursor");
    if (cursor !== undefined) seenCursors.add(cursor);
    const result = await readPage(cursor, signal);
    signal.throwIfAborted();
    catalog = mergePage(catalog, result, target);
    onProgress(catalog);
  }
  if (!catalog) throw new Error("GitHub discovery returned no response");
  return catalog;
}

export function catalogHasMore(catalog: RepositoryCatalog) {
  return catalog.repositories.length > catalog.visibleCount || catalog.nextCursor !== null;
}

export function catalogIsPartial(catalog: RepositoryCatalog) {
  return catalog.incomplete || catalogHasMore(catalog);
}
