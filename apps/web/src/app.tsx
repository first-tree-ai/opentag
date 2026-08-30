import { type LinkComponentProps, LinkProvider, TooltipProvider } from "@cloudflare/kumo";
import { QueryClientProvider } from "@tanstack/react-query";
import { Link as RouterLink, RouterProvider } from "@tanstack/react-router";
import { forwardRef, useEffect, useState } from "react";
import { AppErrorBoundary } from "./features/error-boundary.js";
import { createQueryClient } from "./query/client.js";
import { type AppRouter, createAppRouter } from "./router.js";

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink({ href, ...props }, ref) {
  if (href?.startsWith("http://") || href?.startsWith("https://")) {
    return <a {...props} href={href} ref={ref} />;
  }
  // Kumo's contract is a runtime href string, while `to` is a union of the generated route paths.
  // This adapter is the one place the two meet, so the widening stays contained here.
  return <RouterLink {...props} ref={ref} to={(href ?? "#") as never} />;
});

/**
 * The router is created per mount rather than once per module so that each test renders against a
 * fresh history subscription instead of inheriting the previous test's location. A router the
 * component created owns its history, so it releases the window listeners when it unmounts; a
 * router passed in belongs to the caller and is left alone.
 *
 * The query cache is created per mount for the same reason: a module-level client would carry one
 * test's responses into the next.
 */
export function App({ router }: { router?: AppRouter } = {}) {
  const [{ instance, owned }] = useState(() =>
    router ? { instance: router, owned: false } : { instance: createAppRouter(), owned: true },
  );
  const [queryClient] = useState(createQueryClient);
  useEffect(() => {
    if (!owned) return;
    return () => instance.history.destroy();
  }, [instance, owned]);
  return (
    // The boundary sits outside the providers because a provider that fails to render is exactly the
    // failure a route-level boundary cannot catch.
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <LinkProvider component={AppLink}>
          <TooltipProvider>
            <RouterProvider router={instance} />
          </TooltipProvider>
        </LinkProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
