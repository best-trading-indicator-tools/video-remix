import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DiagnosticsCenter, { AppErrorBoundary } from "./DiagnosticsCenter";
import { installRuntimeDiagnostics } from "./diagnostics-store";
import "./styles.css";
import "./studio.css";
import "./manual.css";
import "./responsive.css";
import "./library.css";
import "./selects.css";

installRuntimeDiagnostics();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
    <DiagnosticsCenter />
  </React.StrictMode>,
);
