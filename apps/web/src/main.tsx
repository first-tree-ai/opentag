import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { App } from "./app.js";
import "./styles.css";
import "./ui/design-system.css";

const root = document.getElementById("root");
if (!root) throw new Error("OpenTag root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
