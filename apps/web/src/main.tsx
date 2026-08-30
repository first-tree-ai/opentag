import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./app.css";
import { rootErrorHandlers } from "./features/error-boundary.js";

const root = document.getElementById("root");
if (!root) throw new Error("OpenTag root element is missing");
createRoot(root, rootErrorHandlers).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
