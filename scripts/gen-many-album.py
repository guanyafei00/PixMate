"""
生成「几百张小图」的相册 —— 专门用来验证缩略图栏的虚拟滚动。

为什么需要：缩略图栏的价值主张是「几千张图的文件夹也能用」，
但**光看代码证明不了** —— 必须有一个真实的大文件夹，然后量：
  DOM 里到底渲染了多少个 thumb-item 节点？

如果虚拟滚动没生效，800 张就会渲染 800 个 <img>（每个都解码成位图），
这正是 ImageGlass #2160「10MB 图吃掉 6.4GB 内存」的复现路径。

尺寸刻意做得很小（120×90 PNG，约 1KB），因为这里要验的是**节点数量**，
不是解码性能 —— 用大图会让验证跑得很慢，还会被图片缓存干扰。
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "many-album")
OUT = os.path.normpath(OUT)

COUNT = 800
W, H = 120, 90


def png_bytes(rgb):
    """极简 PNG 编码：纯色图，避免依赖 Pillow。"""
    raw = b"".join(b"\x00" + bytes(rgb) * W for _ in range(H))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    os.makedirs(OUT, exist_ok=True)

    # 清掉旧文件，避免上一轮的残留混进来影响计数
    for f in os.listdir(OUT):
        if f.endswith(".png"):
            os.remove(os.path.join(OUT, f))

    for i in range(1, COUNT + 1):
        # 每张一个明显不同的颜色，肉眼能看出缩略图栏确实在换图
        rgb = ((i * 37) % 256, (i * 91) % 256, (i * 149) % 256)
        with open(os.path.join(OUT, f"pic_{i:04d}.png"), "wb") as f:
            f.write(png_bytes(rgb))

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"生成 {COUNT} 张 → {OUT}")
    print(f"合计 {round(total / 1024)} KB")


if __name__ == "__main__":
    main()
