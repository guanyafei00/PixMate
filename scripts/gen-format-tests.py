"""
生成「浏览器真能解码」的格式测试图 —— `npm run format-check` 的配套夹具。

原则：**只加真能渲染的格式**。
六份调研报告都在吐槽「HEIC / TIFF 打不开」，但 Chromium（Electron / WebView2 的内核）
根本不带这两种解码器 —— 把它们加进支持列表，只会得到一个「点了必然失败」的入口，
比不支持更糟。所以先用真实文件实测，再决定加哪些：

    npm run format-probe     # 用 Chromium 逐个试，看谁能解码
    npm run format-check     # 真打开逐张翻页，读 naturalWidth 判定是否破图

实测结论（2026-09-20）：
  AVIF ✅  Chromium 原生支持，体积比 WebP 更小
  ICO  ✅  Chromium 支持
  SVG  ✅  Chromium 支持（以 <img> 加载，脚本不执行）
  TIFF ❌  Chromium 不支持 → 不加（目录里留一个作反证）
  HEIC ❌  Chromium 不支持 → 不加（要支持得另引 libheif）

依赖：Pillow（AVIF/ICO）。生成尺寸与 format-check.mjs 里的期望值必须一致。
"""
import os

from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-formats")
OUT = os.path.normpath(OUT)
os.makedirs(OUT, exist_ok=True)

W, H = 200, 120


def paint():
    img = Image.new("RGB", (W, H), (24, 28, 34))
    for x in range(W):
        for y in range(H):
            v = (x + y) % 60
            if 20 < v < 40:
                img.putpixel((x, y), (87, 193, 255))
    return img


base = paint()

p = os.path.join(OUT, "a.avif")
base.save(p, "AVIF", quality=80)
print("生成", p, os.path.getsize(p), "字节")

# ICO 需要正方形
ico = Image.new("RGBA", (128, 128), (24, 28, 34, 255))
for x in range(128):
    for y in range(128):
        if (x // 16 + y // 16) % 2 == 0:
            ico.putpixel((x, y), (87, 193, 255, 255))
p = os.path.join(OUT, "b.ico")
ico.save(p, "ICO", sizes=[(128, 128)])
print("生成", p, os.path.getsize(p), "字节")

# SVG 是文本格式，手写即可，不需要编码器
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" fill="#181c22"/>
  <circle cx="60" cy="60" r="38" fill="#57c1ff"/>
  <rect x="110" y="34" width="70" height="52" rx="8" fill="#6ee7a8"/>
  <text x="100" y="108" font-family="sans-serif" font-size="14" fill="#e8eef5" text-anchor="middle">SVG OK</text>
</svg>
'''
p = os.path.join(OUT, "c.svg")
with open(p, "w", encoding="utf-8") as f:
    f.write(svg)
print("生成", p, os.path.getsize(p), "字节")

# 反证用：Chromium 解不了 TIFF，所以它不该出现在支持列表里，
# format-check 会断言「文件夹计数 = 3」来守住这一点。
p = os.path.join(OUT, "z_unsupported.tif")
base.save(p, "TIFF")
print("生成", p, os.path.getsize(p), "字节（反证：不该被列进支持列表）")

print("\n目录:", OUT)
print("文件:", sorted(os.listdir(OUT)))
