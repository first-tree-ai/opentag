import type { InternalNavigationVisibility } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { browserApi } from "../api.js";
import { queryKeys } from "../query/keys.js";

const HIDDEN_INTERNAL_NAVIGATION: InternalNavigationVisibility = { integrations: false, skills: false };

/** Reads the one staging-wide preview state; production's absent endpoint resolves to hidden. */
export function useInternalNavigationVisibility(): InternalNavigationVisibility {
  return (
    useQuery({
      queryKey: queryKeys.internalNavigationVisibility(),
      queryFn: () => browserApi.internalNavigationVisibility(),
      staleTime: 0,
    }).data ?? HIDDEN_INTERNAL_NAVIGATION
  );
}
