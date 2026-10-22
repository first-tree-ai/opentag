import { createContext, useContext } from "react";

export const AppShellContext = createContext(false);

/** Embedded pages leave global navigation and the main landmark to the application shell. */
export function useInAppShell(): boolean {
  return useContext(AppShellContext);
}
