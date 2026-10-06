# PixMate（图伴）

一个 Windows 本地图片查看器，带 AI 去水印和一些常用的修图功能。用 Tauri 2 + React + TypeScript + Rust 写的。

看图和所有本地工具不联网。AI 功能只有你主动用时才把图片发给你自己填的 OpenAI 兼容服务商。

## 功能

### 看图
- 打开大图不卡（自定义协议流式加载，不走 base64 IPC）
- 缩放（滚轮以光标为锚）、平移、缩略图栏、批量管理
- 支持 PNG / JPEG / WebP / AVIF / GIF / BMP / ICO / SVG / TIFF

### 本地工具（图片不出本机）
- 去水印：IOPaint（LaMa 模型）和内置扩散填洞两个引擎可选
- 一键安装引擎：不用装 Python，点一个按钮自动下载配置好
- 加水印：文字水印，位置/颜色/透明度/字号可调
- 改尺寸：等比缩放 / 补白 / 裁切 / 拉伸，带常见平台预设
- 裁剪旋转：框选裁剪、90° 旋转、翻转、拉直
- 调色：亮度 / 对比度 / 饱和度

### 批量处理
批量加水印 / 改尺寸，整个文件夹一次跑完。

### AI 功能（进阶，需要自己配模型服务）
- 识别图片内容 / 提取文字（OCR 保留排版）
- 带图多轮对话
- 框选一块区域，按描述改图
- 文生图 / 图生图（参考图最大 8MB）

## 安装

到 [Releases](../../releases) 下载 `PixMate-x64-setup.exe` 双击安装。

如果 Windows 弹 SmartScreen 警告（未签名应用的正常提示），点「更多信息」→「仍要运行」。安装包由 GitHub Actions 从源码构建，构建过程公开可查。

第一次用去水印：在去水印页签点「一键安装本地 AI 引擎」，软件会自动下载
嵌入式 Python 和 IOPaint（CPU 版，约 600MB，只下这一次）。也可以手动装
[IOPaint](https://github.com/Sanster/IOPaint)，在设置里填启动命令。

## 配置 AI

「设置」里填任意 OpenAI 兼容服务商：

| 字段 | 说明 |
|---|---|
| Base URL | 例如 `http://localhost:8000/v1`（本地网关 / Ollama / LM Studio 都行） |
| API Key | 你的密钥 |
| 模型名 | 支持视觉输入的对话模型 |

本地模型（Ollama / LM Studio）和云端（OpenAI / 阿里百炼 / 火山方舟 / 月之暗面等）都预置在服务商列表里。

## 构建

前置：Node.js 20+、Rust (stable)、WebView2 Runtime。

```bash
npm install
npm run tauri build        # 产出 NSIS 安装包（注意在纯 ASCII 路径下构建）
```

无头自检：设置环境变量 `AIIV_SELFTEST_OUT` 指向输出 JSON 后启动 exe。

## 隐私与安全

- 看图 / 本地工具 / 去水印全程在本机完成，不经过第三方
- AI 功能只在你主动点击时把图片发给你自己配的服务商
- API Key 明文存在本机 `%APPDATA%/com.aiimageviewer.app/settings.json`（能读到这个文件的程序本来就能做任何事，所以没有再加密一层）
- 命令层 ACL：文件删除等敏感命令只允许操作用户授权过的目录
- 自动更新：启动时检查新版本（可在设置关闭），下载安装前会问你，带签名校验

## 维护说明

个人业余项目。issue 和 feature request 会看，但不保证响应速度，也不保证接受功能请求。欢迎 PR，大改动建议先开 issue 讨论。

去水印功能请遵守当地法律和他人著作权，只处理自己有权处理的图片。

## License

MIT
