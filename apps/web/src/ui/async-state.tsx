import type { ReactNode } from "react";
import type { LoadState } from "../lib/resource.js";
import { Notice } from "./feedback.js";

export function AsyncState<T>({ state, children }: { state: LoadState<T>; children: (value: T) => ReactNode }) {
  if (state.kind === "loading")
    return (
      <p className="muted" role="status">
        Loading current server state…
      </p>
    );
  if (state.kind === "error") return <Notice tone="error">{state.error.message}</Notice>;
  return children(state.value);
}
