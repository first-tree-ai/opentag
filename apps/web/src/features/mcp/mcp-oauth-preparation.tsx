import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import * as m from "../../paraglide/messages.js";
import { Loader, Text } from "../../ui/design-system.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { McpServiceIcon } from "./mcp-service-icon.js";

function McpOAuthPreparation({ title, iconUrl }: { title: string; iconUrl?: string }) {
  return (
    <main
      className="mcp-oauth-preparation flex w-full max-w-xs flex-col items-center text-center"
      aria-labelledby="mcp-oauth-title"
    >
      <McpServiceIcon src={iconUrl} size={32} />
      <Text
        as="h1"
        size="lg"
        variant="heading"
        id="mcp-oauth-title"
        DANGEROUS_className="mcp-oauth-title my-5 max-w-full wrap-anywhere"
      >
        {title}
      </Text>
      <div role="status" className="flex items-center justify-center gap-2">
        <span aria-hidden="true">
          <Loader size="sm" className="text-kumo-link" />
        </span>
        <Text as="p" size="sm" DANGEROUS_className="text-kumo-subtle">
          {m.mcp_oauth_opening()}
        </Text>
      </div>
    </main>
  );
}

/** Render the official non-interactive components once; no React root follows the provider navigation. */
export function renderMcpOAuthPreparation(popup: Window, identity?: McpOAuthIdentity): void {
  // Finish the initial blank document before loading styles, and use standards mode.
  popup.document.open();
  popup.document.write("<!doctype html><html><head></head><body></body></html>");
  popup.document.close();
  const title = identity ? m.mcp_oauth_connect_title({ server: identity.name }) : m.mcp_oauth_window_title();
  popup.document.title = `${title} · OpenTag`;
  for (const name of ["lang", "data-opentag-theme", "data-opentag-mode"]) {
    const value = document.documentElement.getAttribute(name);
    if (value) popup.document.documentElement.setAttribute(name, value);
  }
  copyPreparationStyles(popup.document);
  const style = getComputedStyle(document.querySelector(".ui-dialog") ?? document.body);
  Object.assign(popup.document.body.style, {
    margin: "0",
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: "32px",
    boxSizing: "border-box",
    fontFamily: style.fontFamily,
    fontSize: "14px",
    lineHeight: "1.5",
    color: style.color,
    backgroundColor: style.backgroundColor,
  });
  const host = popup.document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<McpOAuthPreparation title={title} iconUrl={identity?.iconUrl} />));
    const content = host.firstElementChild?.cloneNode(true);
    if (!content) throw new Error("Could not render the MCP authorization preparation view.");
    const image = (content as HTMLElement).querySelector("img");
    if (image) {
      // Snapshotting drops React's image error handler; retain the shared generic service icon.
      flushSync(() => root.render(<McpServiceIcon size={32} />));
      const fallback = host.firstElementChild?.cloneNode(true);
      if (fallback) image.addEventListener("error", () => image.parentElement?.replaceWith(fallback), { once: true });
    }
    popup.document.body.replaceChildren(content);
  } finally {
    root.unmount();
  }
}

function copyPreparationStyles(target: Document): void {
  // Include @font-face and the component tokens, including Vite's inline development styles.
  for (const element of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(
    'link[rel="stylesheet"], style',
  )) {
    let rules: string | undefined;
    try {
      if (element.sheet) rules = Array.from(element.sheet.cssRules, (rule) => rule.cssText).join("\n");
    } catch {
      // A cross-origin stylesheet cannot be read; let the child load its original URL.
    }
    const copy = target.createElement(rules !== undefined || element instanceof HTMLStyleElement ? "style" : "link");
    if (rules !== undefined) {
      copy.textContent = rules;
    } else if (element instanceof HTMLLinkElement) {
      const link = copy as HTMLLinkElement;
      link.rel = "stylesheet";
      link.href = element.href;
      link.media = element.media;
    } else {
      copy.textContent = element.textContent;
    }
    target.head.append(copy);
  }
}
