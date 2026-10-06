/**
 * 场景快捷坞（UI 方案 v0.3 / M1）：底部常驻的高频操作条。
 *
 * 【定位】把每天摸的高频本地工具（去水印/加水印/改尺寸/批量）从工具面板的
 * 二级页签提升为一次点击；「多平台出图」为 v0.3 预留位（M5 物料页签落地前
 * 先路由到改尺寸页签）。
 *
 * 【纪律】
 * - 没打开图片时不渲染；Z 纯看图模式不渲染（画布为王）
 * - 可收起（记忆到 localStorage），收起后只剩一个小恢复钮
 * - 未框选就点「去水印」不报错 —— 面板内有引导，这里只负责把人带到
 */

import { LocalToolId } from "../lib/workflows";

export interface DockItem {
  id: string;
  tab: LocalToolId;
  icon: string;
  label: string;
  hot?: boolean;
}

export const DOCK_ITEMS: DockItem[] = [
  { id: "inpaint", tab: "inpaint", icon: "🪄", label: "去水印", hot: true },
  { id: "watermark", tab: "watermark", icon: "🛡️", label: "加水印" },
  { id: "resize", tab: "resize", icon: "📐", label: "改尺寸" },
  { id: "batch", tab: "batch", icon: "📦", label: "批量处理" },
  { id: "platform", tab: "platform", icon: "🌐", label: "多平台出图" },
];

export default function QuickDock({
  collapsed,
  activeTab,
  onOpenTab,
  onToggleCollapse,
}: {
  collapsed: boolean;
  /** 工具面板里当前激活的页签（用于高亮坞内对应项） */
  activeTab: LocalToolId | undefined;
  onOpenTab: (tab: LocalToolId) => void;
  onToggleCollapse: () => void;
}) {
  if (collapsed) {
    return (
      <div className="dock dock-collapsed">
        <button className="dock-restore" onClick={onToggleCollapse} title="展开快捷操作坞">
          ⌃ 快捷操作
        </button>
      </div>
    );
  }
  return (
    <div className="dock">
      <span className="dock-label">快捷操作</span>
      {DOCK_ITEMS.map((it) => (
        <button
          key={it.id}
          className={"dock-item" + (it.hot ? " hot" : "") + (activeTab === it.tab ? " on" : "")}
          onClick={() => onOpenTab(it.tab)}
          title={it.id === "platform" ? "多平台尺寸套件：小红书/公众号/抖音/X 一键产出" : it.label}
        >
          <span className="ic">{it.icon}</span>
          {it.label}
        </button>
      ))}
      <span className="dock-sp" />
      <button className="dock-more" onClick={onToggleCollapse} title="收起快捷坞">
        收起 ⌄
      </button>
    </div>
  );
}
