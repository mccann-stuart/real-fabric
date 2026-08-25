import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root)
  throw new Error("Real Fabric could not start because '#root' is missing from index.html.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
