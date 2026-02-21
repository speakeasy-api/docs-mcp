import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Playground from "./Playground.js";
import "@gram-ai/elements/elements.css";
import "./playground.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
