import type { GitHubDiscoveredRepository, GitHubRepositoryDiscoveryPage } from "@opentag/shared/browser";
import { describe, expect, it, vi } from "vitest";
import {
  catalogHasMore,
  catalogIsPartial,
  type RepositoryCatalog,
  readRepositoryBatch,
} from "./github-repository-discovery.js";

const installation = {
  installationId: "77",
  accountLogin: "acme",
  accountType: "Organization" as const,
  repositorySelection: "selected" as const,
  suspended: false,
};
function repository(id: number): GitHubDiscoveredRepository {
  return {
    installationId: "77",
    repositoryId: String(id),
    fullName: `acme/repo-${id}`,
    private: true,
    defaultBranch: "main",
    permissions: { pull: true, push: false },
  };
}
function page(
  repositories: GitHubDiscoveredRepository[],
  overrides: Partial<GitHubRepositoryDiscoveryPage> = {},
): GitHubRepositoryDiscoveryPage {
  return {
    installations: [installation],
    repositories,
    nextCursor: null,
    installationsTruncated: false,
    truncatedInstallations: [],
    ...overrides,
  };
}
function read(
  readPage: Parameters<typeof readRepositoryBatch>[0]["readPage"],
  previous?: RepositoryCatalog,
  target = 100,
) {
  return readRepositoryBatch({ previous, target, readPage, signal: new AbortController().signal, onProgress: vi.fn() });
}

describe("GitHub repository discovery batches", () => {
  it("merges small provider pages and buffers rows beyond a 100-repository batch", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([repository(1), repository(2)], { nextCursor: "second" }))
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => repository(i + 3)),
          { nextCursor: "third" },
        ),
      )
      .mockResolvedValueOnce(page([repository(103)]));
    const first = await read(readPage);
    expect(first.visibleCount).toBe(100);
    expect(first.repositories).toHaveLength(102);
    expect(catalogHasMore(first)).toBe(true);
    expect(readPage).toHaveBeenCalledTimes(2);
    const second = await read(readPage, first, 200);
    expect(second.visibleCount).toBe(103);
    expect(catalogHasMore(second)).toBe(false);
    expect(second.repositories.map((entry) => entry.repositoryId)).toEqual(
      Array.from({ length: 103 }, (_, i) => String(i + 1)),
    );
  });

  it("does not offer Load more for exactly 100 repositories followed by an empty installation", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => repository(i + 1)),
          { nextCursor: "empty-installation" },
        ),
      )
      .mockResolvedValueOnce(page([]));
    const result = await read(readPage);
    expect(result.visibleCount).toBe(100);
    expect(catalogHasMore(result)).toBe(false);
  });

  it("reveals buffered rows without another request when the stream is already complete", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => repository(i + 1)),
          { nextCursor: "last" },
        ),
      )
      .mockResolvedValueOnce(page([repository(101)]));
    const first = await read(readPage);
    expect(first.visibleCount).toBe(100);
    const second = await read(readPage, first, 200);
    expect(second.visibleCount).toBe(101);
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repositories and excludes suspended installations and missing user access", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValue(
        page(
          [
            repository(1),
            repository(1),
            { ...repository(2), installationId: "88" },
            { ...repository(3), permissions: { pull: false, push: false } },
          ],
          { installations: [installation, { ...installation, installationId: "88", suspended: true }] },
        ),
      );
    expect((await read(readPage)).repositories.map((entry) => entry.repositoryId)).toEqual(["1"]);
  });

  it("retains truncation across pages and treats older responses as incomplete", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([], { nextCursor: "next", truncatedInstallations: ["77"] }))
      .mockResolvedValueOnce(page([repository(1)]));
    expect(catalogIsPartial(await read(readPage))).toBe(true);
    expect(
      catalogIsPartial(await read(vi.fn().mockResolvedValue(page([], { installationsTruncated: undefined })))),
    ).toBe(true);
  });

  it("bounds sparse discovery without claiming the empty list is complete", async () => {
    let calls = 0;
    const readPage = vi.fn(async () => page([], { nextCursor: String(++calls) }));
    const result = await read(readPage);
    expect(readPage).toHaveBeenCalledTimes(10);
    expect(catalogIsPartial(result)).toBe(true);
  });

  it("preserves successful progress before a later upstream failure", async () => {
    const progress = vi.fn();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([repository(1)], { nextCursor: "next" }))
      .mockRejectedValueOnce(new Error("upstream"));
    await expect(
      readRepositoryBatch({ target: 100, readPage, signal: new AbortController().signal, onProgress: progress }),
    ).rejects.toThrow("upstream");
    expect(progress.mock.calls[0]?.[0].repositories).toHaveLength(1);
    expect(progress.mock.calls[0]?.[0].nextCursor).toBe("next");
  });

  it("stops after closure even when a provider ignores the aborted signal", async () => {
    const controller = new AbortController();
    const readPage = vi.fn(async () => {
      controller.abort();
      return page([], { nextCursor: "next" });
    });
    await expect(
      readRepositoryBatch({ target: 100, readPage, signal: controller.signal, onProgress: vi.fn() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("rejects looping cursors", async () => {
    await expect(read(vi.fn().mockResolvedValue(page([], { nextCursor: "same" })))).rejects.toThrow(
      "repeated a cursor",
    );
  });

  it("drops repositories whose installation vanished during pagination and marks the result partial", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([repository(1)], { nextCursor: "next" }))
      .mockResolvedValueOnce(page([], { installations: [] }));
    const result = await read(readPage);
    expect(result.repositories).toHaveLength(0);
    expect(catalogIsPartial(result)).toBe(true);
  });
});
