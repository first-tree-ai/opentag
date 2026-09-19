import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { useRemoveSkill, useUpdateSkill, useUploadSkill } from "./skills-queries.js";

/**
 * The write hooks take the Agent id as a call argument, not as a hook argument.
 *
 * That is the W1 fix: a mutation created while one Agent's page was open must not be reusable to
 * write another Agent's Skill after the page changed. Each hook therefore routes the id it is given
 * straight to the API call and invalidates exactly that Agent's list — asserted here on both the wire
 * call and the invalidation key.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const OTHER_AGENT_ID = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
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
  it("uploads against the Agent named in the call and invalidates that Agent's Skills", async () => {
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue({} as never);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUploadSkill(), { wrapper });

    await result.current.mutateAsync({
      agentId: AGENT_ID,
      file: new Blob(["bundle"]),
      sha256: "a".repeat(64),
      format: "zip",
      replace: false,
    });

    expect(browserApi.uploadAgentSkill).toHaveBeenCalledWith(AGENT_ID, {
      file: expect.anything(),
      sha256: "a".repeat(64),
      format: "zip",
      replace: false,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(AGENT_ID) });
  });

  it("enables or disables through the Agent named in the call, not the one the hook was made for", async () => {
    vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue({} as never);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUpdateSkill(), { wrapper });

    await result.current.mutateAsync({ agentId: OTHER_AGENT_ID, skillId: SKILL_ID, enabled: false });

    expect(browserApi.updateAgentSkill).toHaveBeenCalledWith(OTHER_AGENT_ID, SKILL_ID, { enabled: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(OTHER_AGENT_ID) });
  });

  it("deletes through the Agent named in the call", async () => {
    vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useRemoveSkill(), { wrapper });

    await result.current.mutateAsync({ agentId: OTHER_AGENT_ID, skillId: SKILL_ID });

    expect(browserApi.removeAgentSkill).toHaveBeenCalledWith(OTHER_AGENT_ID, SKILL_ID);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.skills.agentSkills(OTHER_AGENT_ID) });
  });
});
