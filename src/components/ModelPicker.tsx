import { useMemo, useState } from "react";
import {
  isLikelyVision,
  isNonChat,
  filterModels,
  countVision,
} from "../lib/modelCatalog";

/**
 * 模型选择器（拉取到模型清单后展开）。
 *
 * 【为什么不是简单来个下拉】
 * 云端 /v1/models 拉下来动辄一两百个，平铺一长条等于没提供帮助。所以：
 *   · 按**厂商**分组（服务商自己排的序会保留，组顺序按首次出现）
 *   · 标出**看起来能看图**的 —— 这个软件只能看图，纯文本模型混在里面就是噪音
 *   · 「只看可看图」默认**开启**（几十上百个里通常只剩十来个能用）
 *   · 带搜索框，且同时匹配模型名与厂商名
 *
 * 【关于准确性的措辞】能力是**按名字推断**的，`/v1/models` 根本不返回能力字段。
 * 所以界面上明说"按名字推断"，并且**不隐藏、不禁用**任何模型 ——
 * 认错了顶多是没标上，不会把用户的路堵死。
 */
export default function ModelPicker({
  models,
  current,
  onPick,
  onClose,
  note,
}: {
  models: string[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /** 拉取过程中的说明（如"服务在跑，但没有任何模型"） */
  note?: string;
}) {
  const [query, setQuery] = useState("");
  const visionCount = useMemo(() => countVision(models), [models]);
  // 默认开：这个软件只能看图；但如果一个可看图的都没识别出来，就别开了（否则列表是空的）
  const [visionOnly, setVisionOnly] = useState(visionCount > 0);

  const groups = useMemo(
    () => filterModels(models, { query, visionOnly }),
    [models, query, visionOnly]
  );
  const shown = groups.reduce((n, g) => n + g.models.length, 0);

  return (
    <div className="model-picker">
      <div className="mp-head">
        <input
          className="mp-search"
          value={query}
          placeholder="搜索模型名或厂商…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {visionCount > 0 && (
          <label className="mp-toggle" title="只留下看名字像「能看图」的模型">
            <input
              type="checkbox"
              checked={visionOnly}
              onChange={(e) => setVisionOnly(e.target.checked)}
            />
            只看可看图（{visionCount}）
          </label>
        )}
        <button className="mp-close" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      {note && <div className="mp-note">{note}</div>}

      <div className="mp-list">
        {shown === 0 && (
          <div className="mp-empty">
            {models.length === 0
              ? "这个地址没有返回任何模型。"
              : "没有匹配的模型，试试关掉「只看可看图」或换个关键词。"}
          </div>
        )}
        {groups.map((g) => (
          <div className="mp-group" key={g.group}>
            <div className="mp-group-name">
              {g.group}
              <span className="mp-group-count">{g.models.length}</span>
            </div>
            {g.models.map((id) => {
              const vision = isLikelyVision(id);
              const nonChat = isNonChat(id);
              return (
                <button
                  key={id}
                  className={"mp-item" + (id === current ? " active" : "")}
                  onClick={() => onPick(id)}
                  title={
                    nonChat
                      ? "看名字不像对话模型（嵌入/语音/绘图类），填进来多半用不了"
                      : vision
                        ? "看名字像是支持看图"
                        : "看名字推断不出是否支持看图，不确定的话可以试一下"
                  }
                >
                  <span className="mp-id">{id}</span>
                  {vision && !nonChat && <span className="mp-badge vision">可看图</span>}
                  {nonChat && <span className="mp-badge nonchat">非对话</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mp-foot">
        共 {models.length} 个模型
        {visionCount > 0 && `，其中 ${visionCount} 个看名字像是能看图的`}
        。「可看图」是按模型名推断的，不一定准 —— 没标的也可以试。
      </div>
    </div>
  );
}
