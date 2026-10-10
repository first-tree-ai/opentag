import type {
  InstallSkillPresetResponse,
  ListAgentSkillsResponse,
  ListSkillPresetsResponse,
  RemoteSkillSelection,
  Skill,
  SkillArchiveFormat,
  SkillDetail,
} from "@opentag/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { liveResourceQueryOptions } from "../../query/live.js";
import { removeSkillFromList, updateSkillInList, upsertSkill } from "./skills-cache.js";

/**
 * Reads and writes for one Agent's Skills.
 *
 * A Skill is owned by exactly one Agent, so every query and every write is scoped to the Agent that
 * owns the record. The writes take that Agent id as a call argument rather than closing over it: a
 * mutation created while one Agent's page was open must never be reusable to write another Agent's
 * Skill, which is exactly what a leftover confirmation after browser Back did.
 *
 * A confirmed write is reconciled into the cache before the list is invalidated. The write is already
 * authoritative when `onSuccess` runs, and the invalidation's refetch can fail; without the write
 * first, that failure would leave the pre-mutation cache on screen and the UI would deny a write the
 * Server had accepted. The invalidation still runs — it is what picks up anything else that changed.
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

export function useSkillFile(skill: Skill | undefined, path: string, open: boolean) {
  return useQuery({
    queryKey: queryKeys.skills.file(skill?.agentId ?? "", skill?.id ?? "", skill?.archiveSha256 ?? "", path),
    queryFn: ({ signal }) => {
      if (!skill) throw new Error("A Skill is required to read a file");
      return browserApi.agentSkillFile(skill.agentId, skill.id, path, skill.archiveSha256, signal);
    },
    enabled: open && skill !== undefined,
    // A content-addressed file is immutable. Do not retain package text after the reader closes.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/**
 * A standalone list invalidator for a write that failed but still moved the row: a revision conflict
 * means somebody else changed the Skill, so the page refreshes the list even though its own mutation
 * rejected and there is nothing to reconcile from the response.
 */
export function useInvalidateAgentSkills() {
  const queryClient = useQueryClient();
  return async (agentId: string) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(agentId) });
  };
}

/**
 * One shared cache reconciler and invalidator, keyed by the Agent the write targeted.
 *
 * `reconcile` returns the new list derived from the confirmed write; when the list cache has never
 * loaded it is skipped entirely — fabricating one would claim a storage state the page never read.
 */
function useSkillCache() {
  const queryClient = useQueryClient();
  return {
    reconcileList(agentId: string, reconcile: (list: ListAgentSkillsResponse) => ListAgentSkillsResponse) {
      const key = queryKeys.skills.agentSkills(agentId);
      const list = queryClient.getQueryData<ListAgentSkillsResponse>(key);
      if (list === undefined) return;
      queryClient.setQueryData(key, reconcile(list));
    },
    setDetail(agentId: string, skillId: string, detail: SkillDetail) {
      queryClient.setQueryData(queryKeys.skills.skill(agentId, skillId), detail);
    },
    removeDetail(agentId: string, skillId: string) {
      queryClient.removeQueries({ queryKey: queryKeys.skills.skill(agentId, skillId) });
    },
    invalidate(agentId: string) {
      return queryClient.invalidateQueries({ queryKey: queryKeys.skills.agentSkills(agentId) });
    },
  };
}

export function useUploadSkill() {
  const cache = useSkillCache();
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
    onSuccess: async (detail, input) => {
      cache.reconcileList(input.agentId, (list) => upsertSkill(list, detail));
      cache.setDetail(input.agentId, detail.id, detail);
      await cache.invalidate(input.agentId);
    },
  });
}

export function useUpdateSkill() {
  const cache = useSkillCache();
  return useMutation({
    mutationFn: (input: { agentId: string; skillId: string; enabled: boolean }) =>
      browserApi.updateAgentSkill(input.agentId, input.skillId, { enabled: input.enabled }),
    onSuccess: async (detail, input) => {
      cache.reconcileList(input.agentId, (list) => updateSkillInList(list, detail));
      cache.setDetail(input.agentId, detail.id, detail);
      await cache.invalidate(input.agentId);
    },
  });
}

/**
 * Reading a source. The response is a preview: it lists what the source holds and writes nothing, so
 * there is no cache to reconcile and nothing to invalidate.
 */
export function useResolveRemoteSkills() {
  return useMutation({
    mutationFn: (input: { agentId: string; source: string }) =>
      browserApi.resolveRemoteSkills(input.agentId, input.source),
  });
}

/**
 * Installing a selection.
 *
 * The response is a per-item report rather than Skill records, so the list cannot be reconciled from
 * it the way an upload reconciles: the installed rows are refetched instead, which is also what
 * surfaces anything the Server decided (a name that turned out to exist, an item that failed).
 */
export function useInstallRemoteSkills() {
  const cache = useSkillCache();
  return useMutation({
    mutationFn: (input: { agentId: string; source: string; selections: RemoteSkillSelection[] }) =>
      browserApi.installRemoteSkills(input.agentId, { source: input.source, selections: input.selections }),
    onSuccess: async (_result, input) => {
      await cache.invalidate(input.agentId);
    },
  });
}

export function useRemoveSkill() {
  const cache = useSkillCache();
  return useMutation({
    mutationFn: (input: { agentId: string; skillId: string }) =>
      browserApi.removeAgentSkill(input.agentId, input.skillId),
    onSuccess: async (_result, input) => {
      cache.reconcileList(input.agentId, (list) => removeSkillFromList(list, input.skillId));
      cache.removeDetail(input.agentId, input.skillId);
      await cache.invalidate(input.agentId);
    },
  });
}

/**
 * The preset catalog for one Agent. Serving state per entry is the Server's job, so the page does not
 * join this against the Skills list; the Agent-scoped key means an install's invalidation refreshes
 * both this and the list.
 */
export function useSkillPresets(agentId: string) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.skills.presetCatalog(agentId),
    queryFn: (): Promise<ListSkillPresetsResponse> => browserApi.skillPresets(agentId),
  });
}

/**
 * Installing or updating one preset. The confirmed write carries the resulting Skill, so it is
 * reconciled into the list before the invalidation refetch, exactly like an upload.
 */
export function useInstallSkillPreset() {
  const cache = useSkillCache();
  return useMutation({
    mutationFn: (input: { agentId: string; presetName: string }): Promise<InstallSkillPresetResponse> =>
      browserApi.installSkillPreset(input.agentId, input.presetName),
    onSuccess: async (result, input) => {
      cache.reconcileList(input.agentId, (list) => upsertSkill(list, result.skill));
      await cache.invalidate(input.agentId);
    },
  });
}
