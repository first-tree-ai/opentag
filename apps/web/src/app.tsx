import { type LinkComponentProps, LinkProvider, TooltipProvider } from "@cloudflare/kumo";
import { forwardRef } from "react";
import { BrowserRouter, Link as RouterLink } from "react-router-dom";
import { AppRouter } from "./router.js";

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink({ href, ...props }, ref) {
  if (href?.startsWith("http://") || href?.startsWith("https://")) {
    return <a {...props} href={href} ref={ref} />;
  }
  return <RouterLink {...props} ref={ref} to={href ?? "#"} />;
});

export function App() {
  return (
    <BrowserRouter>
      <LinkProvider component={AppLink}>
        <TooltipProvider>
          <AppRouter />
        </TooltipProvider>
      </LinkProvider>
    </BrowserRouter>
  );
}
