import { type ReactNode, useRef } from "react";
import { useShellTransition } from "./shell-transition.js";

export function ShellMain({
  children,
  pathname,
  scope,
}: {
  children: ReactNode;
  pathname: string;
  scope: "agent" | "workspace";
}) {
  const main = useRef<HTMLElement>(null);
  const outgoing = useRef<HTMLDivElement>(null);
  useShellTransition({ main, outgoing, pathname, scope });
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <main
        ref={main}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 md:px-8 md:py-8 [scrollbar-gutter:stable]"
        data-ui="content"
      >
        <div className="@container/content mx-auto w-full min-w-0 max-w-5xl" data-ui="content-page-frame">
          {children}
        </div>
      </main>
      <div ref={outgoing} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" inert />
    </div>
  );
}
