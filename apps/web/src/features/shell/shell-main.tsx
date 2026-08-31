import type { ReactNode } from "react";

export function ShellMain({ children }: { children: ReactNode }) {
  return (
    <main
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 md:px-8 md:py-8"
      data-ui="content"
    >
      <div className="@container/workspace mx-auto w-full min-w-0 max-w-5xl" data-ui="workspace-page-frame">
        {children}
      </div>
    </main>
  );
}
