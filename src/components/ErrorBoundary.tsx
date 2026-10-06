import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * 全局错误边界：任一组件未捕获异常时兜底，避免整树卸载白屏。
 * 崩溃信息写入本地日志（Tauri 环境），界面提供「重新加载」出口。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const log =
      `[${new Date().toISOString()}] React render crash\n` +
      `${error.stack || error.message}\n` +
      `component stack:${info.componentStack || "(none)"}\n`;
    try {
      import("../lib/api")
        .then((m) => m.writeCrashLog(log))
        .catch(() => {});
    } catch {
      /* 兜底日志失败不应再抛错 */
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            fontFamily: "system-ui, sans-serif",
            maxWidth: 640,
            margin: "60px auto",
            color: "#333",
          }}
        >
          <h2 style={{ marginBottom: 8 }}>界面出了点问题</h2>
          <p style={{ color: "#666", lineHeight: 1.6 }}>
            错误已记录到本地日志。您可以尝试重新加载；如果反复出现，请把下面的错误信息
            带上到 <b>GitHub Issues</b> 反馈，我们会尽快处理。
          </p>
          <pre
            style={{
              background: "#f6f7f9",
              padding: 12,
              borderRadius: 8,
              whiteSpace: "pre-wrap",
              fontSize: 12,
              maxHeight: 200,
              overflow: "auto",
              color: "#c0392b",
            }}
          >
            {this.state.error.stack || this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: "#3b82f6",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
