/**
 * 命令面板（UI 方案 v0.3 / M3，Ctrl+K 呼出）。
 *
 * 【定位】功能再多界面也不膨胀的万能出口 —— 打字「去水印」回车执行。
 * 【纪律】纯增益：不占任何常驻界面空间；Esc 关闭；↑↓ 选择；Enter 执行。
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  icon: string;
  label: string;
  hint?: string;
  run: () => void;
  /** 仅在有图片时可用 */
  needsImage?: boolean;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
  hasImage,
}: {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
  hasImage: boolean;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return commands
      .filter((c) => !(c.needsImage && !hasImage))
      .filter((c) => !kw || c.label.toLowerCase().includes(kw) || c.id.includes(kw));
  }, [q, commands, hasImage]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      // 等一帧让 DOM 挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const exec = (c?: CommandItem) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="输入命令或功能名…（Esc 关闭）"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              exec(filtered[sel]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          autoFocus
        />
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-item muted">没有匹配的命令</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={"cmdk-item" + (i === sel ? " on" : "")}
              onClick={() => exec(c)}
              onMouseEnter={() => setSel(i)}
            >
              <span className="cmdk-ic">{c.icon}</span>
              {c.label}
              {c.hint && <span className="k">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
