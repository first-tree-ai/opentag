import { type LinkComponentProps, LinkProvider, TooltipProvider } from "@cloudflare/kumo";
import { Link as RouterLink, RouterProvider } from "@tanstack/react-router";
import { forwardRef, useEffect, useState } from "react";
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
 */
export function App({ router }: { router?: AppRouter } = {}) {
  const [{ instance, owned }] = useState(() =>
    router ? { instance: router, owned: false } : { instance: createAppRouter(), owned: true },
  );
  useEffect(() => {
    if (!owned) return;
    return () => instance.history.destroy();
  }, [instance, owned]);
  return (
    <LinkProvider component={AppLink}>
      <TooltipProvider>
        <RouterProvider router={instance} />
      </TooltipProvider>
    </LinkProvider>
  );
}
