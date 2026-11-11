import React from "react";

/**
 * 引擎状态徽标（B1 交付项：首装引擎四态可视化）。
 *
 * 仅做**呈现**：把 App 层探活得到的引擎状态显示成顶栏徽标，点击直达去水印页签
 * （那里有完整的「未安装 → 安装中 → 已就绪 → 失败可重试」装机流程）。
 *
 * 为什么独立成组件、不把状态判断塞进 App 顶栏 JSX：
 *   · 四态的文案/配色映射是一处真源，避免散落在两处；
 *   · App 只负责「探活 + 存状态」，本组件只负责「怎么画」，职责干净；
 *   · 之后若要在 onboarding / 空状态里复用同一套四态视觉，直接 import 即可。
 */

export type EngineState =
  | { status: "unknown" }
  | { status: "installing"; message?: string }
  | { status: "ready" }
  | { status: "missing" }
  | { status: "error"; message?: string };

const MAP = {
  unknown: { cls: "eb-wait", icon: "…", label: "本地 AI 引擎检测中" },
  installing: { cls: "eb-wait", icon: "⏳", label: "本地 AI 引擎安装中" },
  ready: { cls: "eb-ok", icon: "✓", label: "本地 AI 引擎已就绪" },
  missing: { cls: "eb-warn", icon: "⚠", label: "本地 AI 引擎未安装" },
  error: { cls: "eb-warn", icon: "⚠", label: "本地 AI 引擎异常" },
} as const;

export default function EngineStatusBadge({
  state,
  onOpen,
}: {
  state: EngineState;
  /** 点击：打开本地工具 → 去水印页签（装机/重试的入口） */
  onOpen: () => void;
}) {
  const m = MAP[state.status];
  const tip =
    state.status === "missing"
      ? "点击打开「去水印」页签，一键安装本地 AI 引擎（免费、离线、图片不出本机）"
      : state.status === "ready"
        ? "本地 AI 去水印引擎已就绪，可直接框选去水印"
        : state.status === "installing"
          ? `安装中：${state.message ?? "请保持软件打开"}`
          : state.status === "error"
            ? `引擎异常：${state.message ?? "点击去排查"}`
            : "正在检测本地 AI 去水印引擎…";
  return (
    <button
      type="button"
      className={`engine-badge ${m.cls}`}
      onClick={onOpen}
      title={tip}
    >
      <span className="eb-icon" aria-hidden>
        {m.icon}
      </span>
      <span className="eb-text">{m.label}</span>
    </button>
  );
}
