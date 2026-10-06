# -*- coding: utf-8 -*-
"""
一键回归：typecheck → vite build → 无头自检 → 浏览器渲染检查 → 摘要解析器单测。
用法：python scripts/check-all.py   （npm run check-all）
任何一环失败立即退出，退出码非 0。
"""
import subprocess, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"D:\Programs\nodejs\node.exe"
PY = sys.executable

STEPS = [
    ("typecheck", [NODE, os.path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], ROOT),
    ("vite build", [NODE, os.path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"], ROOT),
    ("无头自检", [PY, os.path.join(ROOT, "scripts", "selftest-check.py")], ROOT),
    ("浏览器渲染检查", [NODE, os.path.join(ROOT, "scripts", "browser-render-check.mjs")], ROOT),
    ("摘要解析器单测", [NODE, os.path.join(ROOT, "scripts", "summary-check.mjs")], ROOT),
]

failures = 0
for name, cmd, cwd in STEPS:
    print("=" * 20, name, "=" * 20)
    try:
        p = subprocess.run(cmd, cwd=cwd, timeout=300)
        ok = p.returncode == 0
    except subprocess.TimeoutExpired:
        ok = False
        print("超时")
    if not ok:
        failures += 1
        print(f"❌ {name} 失败")
    else:
        print(f"✅ {name} 通过")

print("")
print("CHECK-ALL:", "ALL_PASS" if failures == 0 else f"{failures} 项失败")
sys.exit(0 if failures == 0 else 1)
