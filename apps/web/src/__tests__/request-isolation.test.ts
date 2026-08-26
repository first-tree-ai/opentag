import { describe, expect, it, vi } from "vitest";

/**
 * A loader that requests again after its first await keeps running once its component is gone, so
 * its late request can land in the next test and be attributed to it. This locks the shared setup
 * that settles those chains before the fetch spy is reset; without it a test asserting on the spy
 * fails only sometimes, depending on scheduling.
 */
async function loadInTwoStages() {
  const responses = await Promise.all([fetch("/stage-1a"), fetch("/stage-1b")]);
  await Promise.all(responses.map((response) => response.text()));
  await fetch("/stage-2");
}

describe("cross-test request isolation", () => {
  it("starts a two-stage load and ends before it settles", () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 204 }));
    void loadInTwoStages();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("never sees a request the previous test started", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
