import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app.css";
import { applyDocumentLocale } from "../i18n/document-locale.js";
import { configureLocaleRuntime } from "../i18n/locale.js";
import { TooltipProvider } from "../ui/design-system.js";
import { BotConnectionPlayground } from "./playground.js";

// This entry is never imported by the product. Block accidental API calls and external links.
window.fetch = async () => {
  throw new Error("Network requests are disabled in the bot preview");
};
window.open = () => null;
document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a[href]")) event.preventDefault();
  },
  true,
);
document.addEventListener(
  "auxclick",
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a[href]")) event.preventDefault();
  },
  true,
);

if (!localStorage.getItem("PARAGLIDE_LOCALE")) localStorage.setItem("PARAGLIDE_LOCALE", "zh");
configureLocaleRuntime();
applyDocumentLocale();
const root = document.getElementById("root");
if (!root) throw new Error("Bot preview root element is missing");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <BotConnectionPlayground
        initialControlsOpen={new URLSearchParams(window.location.search).get("controls") === "1"}
      />
    </TooltipProvider>
  </StrictMode>,
);
