import type { ListAgentSkillsResponse, SkillArchiveFormat, SkillDetail } from "@opentag/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { liveResourceQueryOptions } from "../../query/live.js";

/**
 * Reads and writes for one Agent's Skills.
 *
 * A Skill is owned by exactly one Agent, so every query and every write is scoped to the Agent that
 * owns the record. The writes take that Agent id as a call argument rather than closing over it: a
 * mutation created while one Agent's page was open must never be reusable to write another Agent's
 * Skill, which is exactly what a leftover confirmation after browser Back did.
 */

export function useAgentSkills(agentId: string) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.skills.agentSkills(agentId),
    queryFn: (): Promise<ListAgentSkillsResponse> => browserApi.agentSkills(agentId),
  });
}

export function useAgentSkill(agentId: string, skillId: string | undefined) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.skills.skill(agentId, skillId ?? ""),
    queryFn: (): Promise<SkillDetail> => browserApi.agentSkill(agentId, skillId as string),
    enabled: skillId !== undefined,
  });
}

/**
 * One shared invalidator, keyed by the Agent the write targeted. Every write changes both that
 * Agent's list and the affected Skill's detail, and the detail key is a child of the list key, so
 * invalidating the list retires both.
 *
 * Exported because a failed write can still move the row: a revision conflict means somebody else
 * changed the Skill, so the page refreshes the list even though the mutation rejected.
 */
export function useInvalidateAgentSkills() {
  const queryClient = useQueryClient();
  return async (agentId: string) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(agentId) });
  };
}

export function useUploadSkill() {
  const invalidate = useInvalidateAgentSkills();
  return useMutation({
    mutationFn: (input: {
      agentId: string;
      file: Blob;
      sha256: string;
      format: SkillArchiveFormat;
      replace: boolean;
    }) => {
      const { agentId, ...archive } = input;
      return browserApi.uploadAgentSkill(agentId, archive);
    },
    onSuccess: (_skill, input) => invalidate(input.agentId),
  });
}

export function useUpdateSkill() {
  const invalidate = useInvalidateAgentSkills();
  return useMutation({
    mutationFn: (input: { agentId: string; skillId: string; enabled: boolean }) =>
      browserApi.updateAgentSkill(input.agentId, input.skillId, { enabled: input.enabled }),
    onSuccess: (_skill, input) => invalidate(input.agentId),
  });
}

export function useRemoveSkill() {
  const invalidate = useInvalidateAgentSkills();
  return useMutation({
    mutationFn: (input: { agentId: string; skillId: string }) =>
      browserApi.removeAgentSkill(input.agentId, input.skillId),
    onSuccess: (_result, input) => invalidate(input.agentId),
  });
}
