import type { ListAgentSkillsResponse, SkillArchiveFormat, SkillDetail } from "@opentag/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { liveResourceQueryOptions } from "../../query/live.js";

/**
 * Reads and writes for one Agent's Skills.
 *
 * A Skill is owned by exactly one Agent, so every query and every mutation is scoped to the Agent
 * the page is showing. The list response also carries the deployment's storage status, which is why
 * the page reads storage from `useAgentSkills` rather than from a second request: a deployment
 * without object storage still lists, and only uploads and downloads are unavailable.
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
 * One shared invalidator. Every write changes both the Agent's list and the affected Skill's detail,
 * and the detail key is a child of the list key, so invalidating the list retires both.
 */
function useSkillInvalidation(agentId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(agentId) });
  };
}

export function useUploadSkill(agentId: string) {
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { file: Blob; sha256: string; format: SkillArchiveFormat; replace: boolean }) =>
      browserApi.uploadAgentSkill(agentId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateSkill(agentId: string) {
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { skillId: string; enabled: boolean }) =>
      browserApi.updateAgentSkill(agentId, input.skillId, { enabled: input.enabled }),
    onSuccess: invalidate,
  });
}

export function useRemoveSkill(agentId: string) {
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: (skillId: string) => browserApi.removeAgentSkill(agentId, skillId),
    onSuccess: invalidate,
  });
}
