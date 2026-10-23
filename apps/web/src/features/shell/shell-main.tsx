import { type ReactNode, useRef } from "react";
import { useShellTransition } from "./shell-transition.js";

export function ShellMain({ children, pathname }: { children: ReactNode; pathname: string }) {
  const main = useRef<HTMLElement>(null);
  useShellTransition({ main, pathname });
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <main
        ref={main}
        className="app-content min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
        data-ui="content"
      >
        <div className="app-content-frame @container/content mx-auto w-full min-w-0" data-ui="content-page-frame">
          {children}
        </div>
      </main>
    </div>
  );
}
