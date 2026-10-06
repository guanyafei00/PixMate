#!/usr/bin/env python3
"""
生成大图性能测试相册（perf-album/）。

用途：给 `npm run perf-check` 提供真实体量的大图，用来实测「秒开 / 翻页零延迟」
这条产品红线的数字。纯色或纯渐变的测试图压缩率极高、解码也快得离谱，
测出来的数字没有参考价值 —— 所以这里刻意做成**逐像素噪声**，接近不可压缩。

为什么用 Python 而不是 Node：
  项目其余脚本都是零依赖的 `.mjs`，但**写 JPEG 需要一个编码器**。
  纯 JS 手写 JPEG 编码器不值得，而 PNG 又没有代表性（真实照片都是 JPEG）。
  所以这一个脚本用 Pillow —— 只在你需要重新生成测试图时才用得到，
  而且生成的图不入库（.gitignore 已排除 perf-album/）。
  没有 Pillow 时：`pip install Pillow`。

用法：
  python scripts/gen-perf-album.py
"""
import os
import sys
import time

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:
    sys.exit("需要 Pillow：pip install Pillow")

# 输出到工程根目录下的 perf-album/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "perf-album")
os.makedirs(OUT, exist_ok=True)

# 三档规格，覆盖真实会遇到的大图
SPECS = [
    ("perf_1_24mp.jpg", 6000, 4000, (30, 90, 180)),   # 主流手机 / 入门单反
    ("perf_2_12mp.jpg", 4000, 3000, (180, 60, 60)),   # 常规相机
    ("perf_3_48mp.jpg", 8000, 6000, (60, 160, 90)),   # 高像素手机 / 全画幅
]


def build(w, h, base):
    r0, g0, b0 = base
    # 对角渐变底（全用 Pillow 的 C 级运算，避免 Python 逐像素循环）
    gx = Image.linear_gradient("L").resize((w, h))
    gy = Image.linear_gradient("L").rotate(90, expand=True).resize((w, h))
    r = gx.point(lambda v: int(r0 * (0.30 + v / 255 * 0.7)))
    g = gy.point(lambda v: int(g0 * (0.30 + v / 255 * 0.7)))
    b = ImageChops.add(gx, gy).point(
        lambda v: min(255, int(b0 * (0.30 + v / 510 * 0.7)))
    )
    img = Image.merge("RGB", (r, g, b))

    # 逐像素彩色噪声（os.urandom 直接当像素数据，不可压缩）
    noise = Image.frombytes("RGB", (w, h), os.urandom(w * h * 3))
    img = Image.blend(img, noise, 0.42)

    # 叠一点画面结构，避免全是纯噪声
    d = ImageDraw.Draw(img)
    d.rectangle(
        [w * 0.25, h * 0.30, w * 0.75, h * 0.70],
        fill=(245, 245, 245),
        outline=(20, 24, 30),
        width=max(4, w // 800),
    )
    for i in range(12):
        y = h * 0.35 + i * (h * 0.30 / 12)
        d.line([w * 0.28, y, w * 0.72, y], fill=(25, 30, 38), width=max(3, w // 1200))
    d.rectangle([0, h * 0.93, w, h], fill=(87, 193, 255))
    return img


total = 0
for name, w, h, base in SPECS:
    p = os.path.join(OUT, name)
    t0 = time.time()
    build(w, h, base).save(p, "JPEG", quality=88, subsampling=0)
    size = os.path.getsize(p)
    total += size
    print(
        f"  {name}  {w}×{h} ({w * h / 1e6:.1f}MP)  "
        f"{size / 1048576:.1f} MB  {time.time() - t0:.1f}s"
    )

print(f"\n共 {len(SPECS)} 张，合计 {total / 1048576:.1f} MB → {OUT}")
