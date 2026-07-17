import React from "react";
import ReactDOM from "react-dom/client";
// Marken-Schriften: Inter (Fließtext) + JetBrains Mono (Daten/Labels/Logo).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
