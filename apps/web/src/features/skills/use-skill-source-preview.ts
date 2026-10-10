import type { RemoteSkillCandidate } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.js";
import { skillErrorMessage } from "./skills-page-model.js";
import { useResolveRemoteSkills } from "./skills-queries.js";

/** Bind each preview to the exact source, rejecting late responses after an edit or unmount. */
export function useSkillSourcePreview(agentId: string) {
  const resolve = useResolveRemoteSkills();
  const generation = useRef(0);
  const attempted = useRef<string | undefined>(undefined);
  const currentSource = useRef("");
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<{ source: string; skills: RemoteSkillCandidate[] }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const change = (value: string) => {
    setSource(value);
    if (value.trim() === currentSource.current.trim()) return;
    currentSource.current = value;
    generation.current += 1;
    attempted.current = undefined;
    setPreview(undefined);
    setError(undefined);
    setLoading(false);
  };

  const load = async (value = currentSource.current, retry = false) => {
    const requested = value.trim();
    if (!requested || (!retry && attempted.current === requested)) return;
    const request = ++generation.current;
    attempted.current = requested;
    setPreview(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const response = await resolve.mutateAsync({ agentId, source: requested });
      if (request !== generation.current) return;
      setPreview({ source: requested, skills: response.skills });
    } catch (cause) {
      if (request !== generation.current) return;
      setError(previewError(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };

  return { source, preview, loading, error, change, load };
}

function previewError(cause: unknown) {
  return skillErrorMessage(cause instanceof ApiError ? cause.code : undefined);
}
