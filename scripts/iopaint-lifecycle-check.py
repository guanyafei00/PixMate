# -*- coding: utf-8 -*-
"""
IOPaint 生命周期集成测试：拉起 -> 探活 8080 -> 杀进程树 -> 断言端口释放。
这是全项目真实事故最密集的链路（IPC 卡死、端口残留、僵尸进程均有实测记录）。
用法：python scripts/iopaint-lifecycle-check.py [--exe <iopaint.exe 路径>]
不传 --exe 时按优先级自动探测：IOPAINT_EXE 环境变量 -> 嵌入式运行时 -> D:\ai\iopaint。
"""
import subprocess
import os
import sys
import time
import socket
import argparse

PORT = 8080


def port_open():
    s = socket.socket()
    s.settimeout(1.5)
    try:
        return s.connect_ex(("127.0.0.1", PORT)) == 0
    finally:
        s.close()


def find_iopaint():
    if os.environ.get("IOPAINT_EXE"):
        return os.environ["IOPAINT_EXE"]
    la = os.path.expandvars(r"%LOCALAPPDATA%\com.aiimageviewer.app\iopaint-runtime\python\Scripts\iopaint.exe")
    if os.path.exists(la):
        return la
    legacy = r"D:\ai\iopaint\venv\Scripts\iopaint.exe"
    if os.path.exists(legacy):
        return legacy
    import shutil
    w = shutil.which("iopaint.exe")
    return w or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default="")
    args = ap.parse_args()
    exe = args.exe or find_iopaint()
    if not exe or not os.path.exists(exe):
        print("IOPAINT_LIFECYCLE: SKIP（未找到 iopaint.exe，设置 IOPAINT_EXE 后重试）")
        return 0
    if port_open():
        print("IOPAINT_LIFECYCLE: SKIP（8080 已被占用，可能服务已在跑）")
        return 0

    print("拉起:", exe, flush=True)
    proc = subprocess.Popen(
        [exe, "start", "--model=lama", "--device=cpu", "--port=%d" % PORT, "--host=127.0.0.1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=0x08000000)  # CREATE_NO_WINDOW

    # 探活：最多 120 秒（首次启动可能下载模型，这里只测已装好引擎的生命周期）
    alive = False
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(2)
        if port_open():
            alive = True
            break
        if proc.poll() is not None:
            break
    if not alive:
        print("IOPAINT_LIFECYCLE: FAIL（120 秒内 8080 未就绪，进程退出码 %s）" % proc.poll())
        return 1
    print("探活 ✓ 服务在 8080 就绪（耗时 %ds）" % (time.time() - (deadline - 120)), flush=True)

    # 杀进程树（与壳层 kill_iopaint_tree 相同方式）
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    time.sleep(3)
    if port_open():
        print("IOPAINT_LIFECYCLE: FAIL（进程树已杀但 8080 仍被占用——端口残留！）")
        return 1
    print("端口已释放 ✓", flush=True)
    print("IOPAINT_LIFECYCLE: ALL_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
