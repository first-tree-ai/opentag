import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installAnalytics } from "./analytics/analytics.js";
import { App } from "./app.js";
import "./app.css";
import { rootErrorHandlers } from "./features/error-boundary.js";
import { publishMcpOAuthWindowReturn, readMcpOAuthWindowReturn } from "./features/mcp/mcp-oauth-window.js";
import { applyDocumentLocale } from "./i18n/document-locale.js";
import { configureLocaleRuntime } from "./i18n/locale.js";
import { installWindowDiagnosticHandlers } from "./observability/diagnostics.js";
import { createErrorReportSink, setErrorReportSink } from "./observability/error-reporting.js";
import * as m from "./paraglide/messages.js";

configureLocaleRuntime();
applyDocumentLocale();
const root = document.getElementById("root");
if (!root) throw new Error("OpenTag root element is missing");
// Finish a popup before mounting account navigation or reporting intentionally aborted lazy loads.
const callbackAgent = /^\/agents\/([^/]+)\/mcp\/?$/.exec(window.location.pathname)?.[1];
const popupReturn = callbackAgent ? readMcpOAuthWindowReturn(callbackAgent) : undefined;
if (popupReturn) {
  createRoot(root).render(
    <p role="status">
      {popupReturn.result.outcome.kind === "success" ? m.mcp_oauth_completed() : m.mcp_oauth_return_failed()}
    </p>,
  );
  publishMcpOAuthWindowReturn(popupReturn);
} else {
  // Installed before the diagnostic handlers so the first failure they observe is also relayed.
  setErrorReportSink(createErrorReportSink({ version: __OPENTAG_WEB_VERSION__, environment: import.meta.env.MODE }));
  installWindowDiagnosticHandlers();
  // Before the first render, so a milestone reached during it is queued rather than dropped. On a
  // document that is not measured this does nothing at all, including fetching the tag.
  installAnalytics();

  createRoot(root, rootErrorHandlers).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
