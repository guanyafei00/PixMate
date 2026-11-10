/**
 * 「一眼摘要」解析器的单测。
 *
 * 【为什么用 esbuild 现场转译】
 * 解析逻辑只有一份，就在 src/lib/summary.ts。如果在测试里抄一份，
 * 两份代码迟早会漂移 —— 那时测试反而会给出「通过」的假安全感。
 * 所以这里用 esbuild（vite 自带）把源码转成 ESM 直接 import，测的就是**线上那份代码**。
 *
 * 解析器的输入是模型自由生成的文本，所以用例重点在「不听话的模型」：
 * 忘写标记、写成 JSON、写成 Markdown 标题、只回一句话、空回复 —— 都不能崩、不能丢内容。
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

// 把 TS 现场转成 ESM 再 import —— 测的是源码本身
const outfile = path.join(os.tmpdir(), `aiiv-summary-${Date.now()}.mjs`);
await build({
  entryPoints: [path.join(ROOT, "src", "lib", "summary.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
});
const { splitSummary } = await import(pathToFileURL(outfile).href);
fs.rmSync(outfile, { force: true });

console.log("▸ 一眼摘要解析器单测\n");

// ── ① 标准情形：模型听话，第一行带标记
{
  const r = splitSummary(
    "一句话摘要：一只橘猫趴在窗台上晒太阳\n\n画面主体是一只橘色的猫，趴在木质窗台上。\n光线从左上方来，"
  );
  check("标准：抽出摘要", r.summary === "一只橘猫趴在窗台上晒太阳", `得到「${r.summary}」`);
  check("标准：来源标记为 marker", r.from === "marker");
  check("标准：正文去掉摘要行", !r.body.includes("一句话摘要"), r.body.slice(0, 30));
  check("标准：正文保留其余内容", r.body.includes("木质窗台"));
}

// ── ② 兼容写法：半角冒号 / 「摘要：」不带「一句话」
{
  const a = splitSummary("摘要: 一张发票\n\n金额 128 元");
  check("兼容：半角冒号", a.summary === "一张发票", `得到「${a.summary}」`);
  const b = splitSummary("摘要：一张发票\n\n金额 128 元");
  check("兼容：只写「摘要」", b.summary === "一张发票", `得到「${b.summary}」`);
}

// ── ③ 模型不听话：没有标记 → 从首句推断
//    注意用例要贴近真实：真实描述通常 200+ 字，
//    太短的文本会被「本身就是摘要」的阈值挡住（那是另一条用例）
{
  const src =
    "一只橘猫趴在木质窗台上晒太阳。背景是模糊的室内，左侧有一盆绿植，" +
    "右侧是半开的百叶窗，阳光在地板上投出条状阴影。整体色调偏暖，" +
    "像是下午三四点的自然光。画面右下角有一个白色水杯，杯身上印着卡通图案。";
  const r = splitSummary(src);
  check("兜底：从首句推断出摘要", r.summary === "一只橘猫趴在木质窗台上晒太阳。", `得到「${r.summary}」`);
  check("兜底：来源标记为 first-sentence", r.from === "first-sentence");
  check(
    "兜底：正文不再重复首句（无损去重，不是删内容）",
    !r.body.startsWith("一只橘猫"),
    `正文开头：${r.body.slice(0, 20)}`
  );
  check(
    "兜底：除首句外内容一字不少",
    r.body.includes("百叶窗") && r.body.includes("卡通图案")
  );
  check(
    "兜底：摘要+正文信息量不丢（首句仍展示在摘要区）",
    r.summary.length + r.body.length > src.replace(/\s/g, "").length * 0.9,
    `摘要 ${r.summary.length} + 正文 ${r.body.length} vs 原文 ${src.replace(/\s/g, "").length}`
  );
}

// ── ④ 短文本：本身就是摘要，不该再拆
{
  const r = splitSummary("一张蓝色调的产品图。");
  check("短文本：不拆出摘要", r.summary === null && r.from === "none", `from=${r.from}`);
}

// ── ⑤ 标记埋在正文中间（像小标题）→ 不算摘要
{
  const body = "先看整体。这张图是一张表格。\n".repeat(6) + "摘要：其实这是个标题\n更多内容";
  const r = splitSummary(body);
  check("标记埋太深：不当作摘要", r.from !== "marker", `from=${r.from}`);
}

// ── ⑥ 异常输入不能崩
{
  const cases = [
    ["空字符串", ""],
    ["纯空白", "   \n\n  "],
    ["null", null],
    ["undefined", undefined],
    ["只有标记没有内容", "一句话摘要：\n\n正文在这里"],
    ["JSON 输出（模型自作主张）", '{"summary":"发票","amount":128}'],
    ["Markdown 标题开头", "# 图片分析\n\n这是一张发票。"],
  ];
  for (const [name, input] of cases) {
    let r = null;
    let err = null;
    try {
      r = splitSummary(input);
    } catch (e) {
      err = e;
    }
    check(`健壮性：${name} 不抛异常`, err === null, err ? String(err.message) : "");
    if (r) {
      check(
        `健壮性：${name} 返回结构完整`,
        typeof r === "object" && "summary" in r && typeof r.body === "string"
      );
      // 绝不能凭空丢内容：正文长度不该为 0（除非输入本身就是空）
      const srcLen = String(input ?? "").trim().length;
      check(
        `健壮性：${name} 没丢内容`,
        srcLen === 0 || r.body.length > 0,
        `输入 ${srcLen} 字 → 正文 ${r.body.length} 字`
      );
    }
  }
}

// ── ⑦ 回归：正文里的换行结构要保留（OCR 之外的描述文本也常带列表）
{
  const src = "一句话摘要：会议白板照片\n\n- 项目 A：延期\n- 项目 B：正常\n\n表头：| 项目 | 状态 |";
  const r = splitSummary(src);
  check("结构：多行正文的换行被保留", r.body.split("\n").length >= 4, `${r.body.split("\n").length} 行`);
}


// ── 注：原第 ⑧ 节「端到端：卡片真的渲染出来了吗」已随 Electron 壳一并移除。
//    它 spawn require("electron") 启动应用走 mock 识别 → 状态更新 → 拆分 → 卡片+正文，
//    依赖已卸载的 electron 运行时。渲染那环的覆盖请用 npm run browser-render-check，
//    解析正确性由上方 ①~⑦ 单测负责（测的是线上那份 src/lib/summary.ts）。

console.log("");
console.log(fail === 0 ? `✅ 一眼摘要验证通过：${pass}/${pass + fail}` : `❌ 有 ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
