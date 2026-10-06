# AI Image Viewer

基于 **Tauri 2 + React + TypeScript + Rust** 的本地图片查看器与 AI 工具箱。

本地优先：看图与全部本地工具不联网；AI 功能仅在你主动使用时，
把图片发送到**你自己配置的** OpenAI 兼容服务商。

## 功能

### 看图
- 大图秒开（自定义协议流式加载，不走 base64 IPC）
- 缩放（滚轮以光标为锚）、平移、缩略图栏、多图批量管理
- 支持 PNG / JPEG / WebP / AVIF / GIF / BMP / ICO / SVG / TIFF

### 本地 AI 工具（图片不出本机）
- **AI 去水印**：双引擎 —— IOPaint (LaMa，真实纹理重建) 与内置扩散填洞（毫秒级）
- **加水印**：文字水印，位置/颜色/透明度/字号可调
- **改尺寸**：等比缩放 / 补白 / 裁切 / 拉伸，内置常见平台预设
- **裁剪旋转**：自由框选裁剪、90° 旋转、翻转、拉直
- **调色**：亮度 / 对比度 / 饱和度

### AI 功能（需配置 OpenAI 兼容服务商）
- **识别 / 理解图片 / 提取文字（保留排版 OCR）**
- **带图多轮对话**
- **AI 改图**：框选一块区域 → 按描述修改 / 抹除 / 变清晰
- **AI 生成**：文生图 / 图生图（参考图最高 8MB）

### 批量处理
批量加水印 / 改尺寸，一键应用到整个文件夹。

## 安装

到 [Releases](../../releases) 下载 `AI-Image-Viewer-x64-setup.exe` 双击安装。
首次使用本地 AI 去水印需要 [IOPaint](https://github.com/Sanster/IOPaint)：
`pip install iopaint` 后在设置里填入启动命令（或手动启动服务）。

## 配置 AI

「设置」里填任意 OpenAI 兼容服务商：

| 字段 | 说明 |
|---|---|
| Base URL | 例如 `http://localhost:8000/v1`（本地网关 / Ollama / LM Studio 均可） |
| API Key | 你的密钥 |
| 模型名 | 支持视觉输入的对话模型 |

本地模型（Ollama / LM Studio）与云端（OpenAI / 阿里百炼 / 火山方舟 / 月之暗面等）
均已在服务商列表预置。

## 构建

前置：Node.js 20+、Rust (stable)、WebView2 Runtime。

```bash
npm install
npm run tauri build        # 产出 NSIS 安装包（注意在纯 ASCII 路径下构建）
```

无头自检：设置环境变量 `AIIV_SELFTEST_OUT` 指向输出 JSON 后启动 exe。

## 隐私与安全

- 看图 / 本地工具 / 去水印**全程本机**，不经过任何第三方
- AI 功能仅在你主动点击时，把图片发送给你**自己配置的服务商**
- API Key 明文存储于本机 `%APPDATA%/com.aiimageviewer.app/settings.json`
  （能读到该文件的程序本已能做任何事，威胁模型内可接受）
- 命令层 ACL：文件删除等敏感命令只允许操作用户授过权的目录
- 无自动更新通道，更新需手动下载安装包

## License

MIT
