import { type LinkComponentProps, LinkProvider, TooltipProvider } from "@cloudflare/kumo";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Link as RouterLink,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type RenderResult, render } from "@testing-library/react";
import { createContext, forwardRef, type ReactNode, useContext } from "react";

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink({ href, ...props }, ref) {
  if (href?.startsWith("http://") || href?.startsWith("https://")) {
    return <a {...props} href={href} ref={ref} />;
  }
  return <RouterLink {...props} ref={ref} to={(href ?? "#") as never} />;
});

// The subject is published through context rather than captured by the root route, so a rerender
// swaps the component without discarding the router the first render created.
const subjectContext = createContext<ReactNode>(null);
const SubjectContext = subjectContext.Provider;

function Subject() {
  return <>{useContext(subjectContext)}</>;
}

/**
 * Mounts a component under a memory router and the Kumo providers, so anything it renders resolves
 * links exactly as the application does. Pages take their route params as props, so a test supplies
 * those directly instead of restating the application's route tree.
 */
export async function renderInRouter(
  ui: ReactNode,
  { path = "/" }: { path?: string } = {},
): Promise<Omit<RenderResult, "rerender"> & { rerender: (node: ReactNode) => void }> {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: createRootRoute({ component: Subject }),
  });
  const wrap = (node: ReactNode) => (
    <SubjectContext value={node}>
      <LinkProvider component={AppLink}>
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </LinkProvider>
    </SubjectContext>
  );
  // The router resolves its first match asynchronously, so the initial paint is flushed here and
  // callers can assert synchronously afterwards.
  let result!: RenderResult;
  await act(async () => {
    result = render(wrap(ui));
  });
  return { ...result, rerender: (node: ReactNode) => result.rerender(wrap(node)) };
}
