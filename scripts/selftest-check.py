# -*- coding: utf-8 -*-
"""
无头自检驱动：启动 exe（AIIV_SELFTEST_OUT）→ 等结果 JSON → 断言 → 清理。
用法：python selftest-check.py
"""
import subprocess, os, sys, time, json, tempfile

# 路径全部相对仓库根推导（可移植：任何机器 clone 后即可跑），也可用环境变量覆盖
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("AIIV_EXE") or os.path.join(
    ROOT, "src-tauri", "target", "release", "ai-image-viewer.exe")
IMG = os.environ.get("AIIV_IMG") or os.path.join(ROOT, "test-album", "photo_2.png")
OUT = os.path.join(tempfile.gettempdir(), "aiiv-selftest-result.json")

subprocess.run(["taskkill", "/IM", "ai-image-viewer.exe", "/F"], capture_output=True)
if os.path.exists(OUT):
    os.remove(OUT)
time.sleep(1)

env = dict(os.environ)
env["AIIV_SELFTEST_OUT"] = OUT
env["AIIV_SELFTEST_IMG"] = IMG
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    env.pop(k, None)

p = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=env,
                     creationflags=0x08000000)  # CREATE_NO_WINDOW
deadline = time.time() + 30
data = None
while time.time() < deadline:
    time.sleep(0.5)
    if os.path.exists(OUT):
        try:
            data = json.loads(open(OUT, encoding="utf-8").read())
            break
        except Exception:
            pass
    if p.poll() is not None and not os.path.exists(OUT):
        break

if p.poll() is None:
    p.kill()

if not data:
    print("SELFTEST_FAIL: 30 秒内没有结果文件")
    sys.exit(1)

checks = [
    ("file_info（EXIF 解析 + ACL）", data.get("file_info_ok") is True),
    ("list_images（ACL 放行）", data.get("list_images_ok") is True),
    ("write_processed（真实落盘）", data.get("write_processed_ok") is True),
    ("thumbnail（生成缩略图）", data.get("thumb_gen_ok") is True),
    ("thumbnail（缓存命中）", data.get("thumb_cache_hit") is True),
]
all_ok = True
for name, ok in checks:
    print(("PASS" if ok else "FAIL"), name)
    all_ok = all_ok and ok

# 缩略图性能基线：首次生成 vs 缓存命中（对标「第二次打开秒加载」的承诺）
tg, tc = data.get("thumb_gen_ms"), data.get("thumb_cache_ms")
if isinstance(tg, (int, float)) and isinstance(tc, (int, float)):
    print(f"缩略图基线: 首次生成 {tg}ms -> 缓存命中 {tc}ms（{tg/max(tc,1):.0f}x）")
# 识别链路端到端：不进 all_ok（网关可能间歇挂，不应阻塞交付），
# 但必须把真实报错打出来 —— 这是「面板报错记不清」时的替代证据源
print("识别链路:", "OK" if data.get("analyze_ok") is True else "FAIL: " + str(data.get("analyze_err"))[:180])
if data.get("analyze_ok"):
    print("识别回答:", str(data.get("analyze_reply"))[:80])

exif = data.get("file_info_exif")
if isinstance(exif, dict) and exif:
    print("EXIF 样例:", json.dumps(exif, ensure_ascii=False)[:150])
print("SELFTEST:", "ALL_PASS" if all_ok and data.get("ok") is True else "HAS_FAILURE")
sys.exit(0 if all_ok and data.get("ok") is True else 1)
