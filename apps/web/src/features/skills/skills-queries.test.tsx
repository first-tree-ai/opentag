import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { useRemoveSkill, useUpdateSkill, useUploadSkill } from "./skills-queries.js";

/**
 * Every write retires the Agent's list, and the detail key is a child of it, so one invalidation is
 * enough. Asserted on the key rather than on a refetch count, because the key is the contract shared
 * with `queryKeys` and the page's own reads.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const SKILL_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("skill mutation invalidation", () => {
  it("invalidates the Agent's Skills after an upload", async () => {
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue({} as never);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUploadSkill(AGENT_ID), { wrapper });

    await result.current.mutateAsync({
      file: new Blob(["bundle"]),
      sha256: "a".repeat(64),
      format: "zip",
      replace: false,
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(AGENT_ID) });
  });

  it("invalidates the Agent's Skills after enabling or disabling one", async () => {
    vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue({} as never);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUpdateSkill(AGENT_ID), { wrapper });

    await result.current.mutateAsync({ skillId: SKILL_ID, enabled: false });

    expect(browserApi.updateAgentSkill).toHaveBeenCalledWith(AGENT_ID, SKILL_ID, { enabled: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(AGENT_ID) });
  });

  it("invalidates the Agent's Skills after a delete", async () => {
    vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useRemoveSkill(AGENT_ID), { wrapper });

    await result.current.mutateAsync(SKILL_ID);

    expect(browserApi.removeAgentSkill).toHaveBeenCalledWith(AGENT_ID, SKILL_ID);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(AGENT_ID) });
  });
});
