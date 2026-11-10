/**
 * 纯浏览器渲染测试：vite preview 起 dist → Playwright 加载 → 等待 .actions。
 * 能渲染 = 前端没问题（问题在 Tauri 壳/资源协议）；黑屏 = 前端本身崩了。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[k];
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", "4173", "--strictPort"], {
  cwd: ROOT,
  stdio: "pipe",
});
let previewLog = "";
vite.stdout.on("data", (d) => (previewLog += d));
vite.stderr.on("data", (d) => (previewLog += d));

// 等端口就绪（vite preview 默认绑 localhost，用 localhost 探测，127.0.0.1 会拒连）
const { chromium } = require("playwright");
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch("http://localhost:4173/", { signal: AbortSignal.timeout(1000) });
    up = r.ok;
  } catch {}
}
if (!up) {
  console.error("preview 起不来：", previewLog.slice(0, 300));
  vite.kill();
  process.exit(1);
}
console.log("preview 就绪");

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200));
});
try {
  await page.goto("http://localhost:4173/", { timeout: 15000, waitUntil: "domcontentloaded" });
  await page.waitForSelector(".actions", { timeout: 12000 });
  const tabs = await page.$$eval(".mode-tab", (els) => els.map((e) => e.textContent.trim()));
  console.log("✅ 浏览器里渲染成功，模式标签:", tabs.join("/"));
} catch (e) {
  console.log("❌ 浏览器里也没渲染出来:", String(e).slice(0, 120));
}
console.log("页面错误:", errors.length ? errors.slice(0, 8).join("\n") : "(无)");
await browser.close();
vite.kill();
