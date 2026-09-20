import type { ListAgentSkillsResponse, Skill, SkillDetail } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
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

function setup(list?: ListAgentSkillsResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  // The hooks invalidate, which refetches; the reconcile assertion is on the cache before/after that,
  // so the list key is seeded and the network call is stubbed to disappear.
  vi.spyOn(browserApi, "agentSkills").mockResolvedValue(list ?? { skills: [], storage: "available" });
  if (list) client.setQueryData(queryKeys.skills.agentSkills(AGENT_ID), list);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}

function listSkill(name: string, id: string, enabled = true): Skill {
  return {
    id,
    agentId: AGENT_ID,
    name,
    description: `${name} description`,
    enabled,
    source: "web_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 2048,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function detailOf(item: Skill, enabled = item.enabled): SkillDetail {
  return { ...item, enabled, files: [{ path: "SKILL.md", bytes: 10 }], filesTruncated: false };
}

function cachedList(client: QueryClient): ListAgentSkillsResponse | undefined {
  return client.getQueryData<ListAgentSkillsResponse>(queryKeys.skills.agentSkills(AGENT_ID));
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

  it("reconciles an uploaded Skill into the list cache, in server name order, without detail fields", async () => {
    const existing = listSkill("zulu", SKILL_ID);
    const created = listSkill("alpha", OTHER_AGENT_ID);
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue(detailOf(created));
    const { client, wrapper } = setup({ skills: [existing], storage: "available" });
    const { result } = renderHook(() => useUploadSkill(), { wrapper });

    await result.current.mutateAsync({
      agentId: AGENT_ID,
      file: new Blob(["bundle"]),
      sha256: "a".repeat(64),
      format: "tar.gz",
      replace: false,
    });

    const cached = cachedList(client);
    expect(cached?.skills.map((entry) => entry.name)).toEqual(["alpha", "zulu"]);
    expect(cached?.skills[0]).not.toHaveProperty("files");
    expect(client.getQueryData(queryKeys.skills.skill(AGENT_ID, OTHER_AGENT_ID))).toEqual(detailOf(created));
  });

  it("replaces a same-id Skill in place, so a replace never duplicates a row", async () => {
    const item = listSkill("alpha", SKILL_ID);
    const replaced = detailOf(item, false);
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue(replaced);
    const { client, wrapper } = setup({ skills: [item], storage: "available" });
    const { result } = renderHook(() => useUploadSkill(), { wrapper });

    await result.current.mutateAsync({
      agentId: AGENT_ID,
      file: new Blob(["bundle"]),
      sha256: "a".repeat(64),
      format: "tar.gz",
      replace: true,
    });

    const cached = cachedList(client);
    expect(cached?.skills).toHaveLength(1);
    expect(cached?.skills[0]?.enabled).toBe(false);
  });

  it("reconciles the flipped toggle and the delete into the list cache", async () => {
    const item = listSkill("alpha", SKILL_ID);
    vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue(detailOf(item, false));
    vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
    const { client, wrapper } = setup({ skills: [item], storage: "available" });
    const update = renderHook(() => useUpdateSkill(), { wrapper });
    const remove = renderHook(() => useRemoveSkill(), { wrapper });

    await update.result.current.mutateAsync({ agentId: AGENT_ID, skillId: SKILL_ID, enabled: false });
    expect(cachedList(client)?.skills[0]?.enabled).toBe(false);

    await remove.result.current.mutateAsync({ agentId: AGENT_ID, skillId: SKILL_ID });
    expect(cachedList(client)?.skills).toEqual([]);
    expect(client.getQueryData(queryKeys.skills.skill(AGENT_ID, SKILL_ID))).toBeUndefined();
  });

  it("does not fabricate a list cache when none was loaded", async () => {
    vi.spyOn(browserApi, "uploadAgentSkill").mockResolvedValue(detailOf(listSkill("alpha", SKILL_ID)));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUploadSkill(), { wrapper });

    await result.current.mutateAsync({
      agentId: AGENT_ID,
      file: new Blob(["bundle"]),
      sha256: "a".repeat(64),
      format: "tar.gz",
      replace: false,
    });

    // The write still lands in the detail cache, but an unloaded list stays unloaded: its storage
    // state is unknown and inventing one would claim something the page never read.
    expect(client.getQueryData(queryKeys.skills.skill(AGENT_ID, SKILL_ID))).toBeDefined();
    await waitFor(() => expect(cachedList(client)).toBeUndefined());
  });
});
