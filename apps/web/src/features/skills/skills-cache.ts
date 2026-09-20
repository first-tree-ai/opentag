import type { ListAgentSkillsResponse, Skill, SkillDetail } from "@opentag/shared/browser";

/**
 * Reconciling a confirmed Skill write into the list cache.
 *
 * Every write is answered authoritatively — POST and PATCH return the `SkillDetail`, DELETE the fact
 * that it happened — but the follow-up list refetch can fail. When it does, React Query keeps the
 * pre-mutation cache, so a Skill the Server stored is missing, a toggle the Server flipped is still
 * checked, and a Skill the Server deleted is still listed. The page would be lying about a write that
 * succeeded, so the confirmed result is written into the cache first and the invalidation is only the
 * reconciliation with whatever else the Server may have changed.
 *
 * The list endpoint orders by name ascending, so an upsert keeps that order rather than appending.
 */

/**
 * A list item is a `Skill`, never a `SkillDetail`: `files`/`filesTruncated` belong to the detail and
 * the list schema is strict, so the extra keys are dropped rather than passed through. The fields
 * are named rather than spread-and-deleted so a new `SkillDetail` field is a typecheck error here
 * instead of silently leaking into the list cache.
 */
function listItemOf(detail: SkillDetail): Skill {
  return {
    id: detail.id,
    agentId: detail.agentId,
    name: detail.name,
    description: detail.description,
    enabled: detail.enabled,
    source: detail.source,
    archiveSha256: detail.archiveSha256,
    archiveBytes: detail.archiveBytes,
    fileCount: detail.fileCount,
    revision: detail.revision,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

function sortByName(skills: readonly Skill[]): Skill[] {
  // Codepoint comparison, not locale collation: this mirrors the Server's `order by name`.
  return [...skills].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Insert or replace one Skill by id, keeping the Server's name order. */
export function upsertSkill(list: ListAgentSkillsResponse, detail: SkillDetail): ListAgentSkillsResponse {
  const item = listItemOf(detail);
  const without = list.skills.filter((skill) => skill.id !== item.id);
  return { ...list, skills: sortByName([...without, item]) };
}

/** Replace the item with the same id in place, preserving its list position. */
export function updateSkillInList(list: ListAgentSkillsResponse, detail: SkillDetail): ListAgentSkillsResponse {
  const item = listItemOf(detail);
  return { ...list, skills: list.skills.map((skill) => (skill.id === item.id ? item : skill)) };
}

/** Drop the removed Skill from the list. */
export function removeSkillFromList(list: ListAgentSkillsResponse, skillId: string): ListAgentSkillsResponse {
  return { ...list, skills: list.skills.filter((skill) => skill.id !== skillId) };
}
