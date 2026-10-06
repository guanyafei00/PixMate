import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

// 【全局兜底】未捕获的 JS 异常与 Promise 拒绝统一落盘（小白报障从此有现场）。
window.addEventListener("error", (e) => {
  const msg = `[${new Date().toISOString()}] window.onerror: ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n  stack:${e.error?.stack || "(none)"}\n`;
  import("./lib/api").then((m) => m.writeCrashLog(msg)).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason);
  const msg = `[${new Date().toISOString()}] unhandledrejection: ${reason}\n`;
  import("./lib/api").then((m) => m.writeCrashLog(msg)).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
