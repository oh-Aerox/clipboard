#!/usr/bin/env python3
"""生成应用图标（assets/icon.png、assets/tray.png、assets/icon.ico）。

只用标准库：自己写 PNG / ICO 封装，避免为了几张图标引入 Pillow 依赖。
图形按 4 倍超采样再降采样，得到抗锯齿边缘。

用法：python tools/make_icons.py
"""

from __future__ import annotations

import os
import struct
import zlib

SS = 4  # 超采样倍数

# 配色与界面保持一致
TOP = (0x6F, 0xAA, 0xFF)
BOTTOM = (0x2A, 0x6F, 0xE0)
SHEET = (0xFF, 0xFF, 0xFF)
CLIP = (0xD6, 0xE2, 0xF7)
LINE = (0x5B, 0x9D, 0xFF)


def rounded_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """点 (x, y) 是否落在圆角矩形内（坐标均为 0~1 的相对值）。"""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def sample(u: float, v: float) -> tuple[int, int, int, int]:
    """按相对坐标取一个像素的颜色，返回 RGBA。"""
    if not rounded_rect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22):
        return (0, 0, 0, 0)

    # 背板：竖向渐变
    t = (v - 0.02) / 0.96
    base = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))

    # 纸张
    if rounded_rect(u, v, 0.24, 0.22, 0.76, 0.84, 0.06):
        # 纸张上的三条内容线
        for i, top in enumerate((0.36, 0.50, 0.64)):
            right = 0.66 if i != 2 else 0.56
            if rounded_rect(u, v, 0.32, top, right, top + 0.055, 0.027):
                return (*LINE, 255)
        return (*SHEET, 255)

    # 顶部夹子
    if rounded_rect(u, v, 0.40, 0.13, 0.60, 0.27, 0.055):
        return (*CLIP, 255)

    return (*base, 255)


def render(size: int) -> bytes:
    """渲染 size×size 的 RGBA 像素数据。"""
    big = size * SS
    rows = []
    for by in range(big):
        v = (by + 0.5) / big
        rows.append([sample((bx + 0.5) / big, v) for bx in range(big)])

    out = bytearray()
    area = SS * SS
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                row = rows[y * SS + dy]
                for dx in range(SS):
                    pr, pg, pb, pa = row[x * SS + dx]
                    # 预乘 alpha 后再平均，边缘才不会出现黑边
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a == 0:
                out += b"\x00\x00\x00\x00"
            else:
                out += bytes((round(r / a), round(g / a), round(b / a), round(a / area)))
    return bytes(out)


def png_bytes(size: int, pixels: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + pixels[y * size * 4 : (y + 1) * size * 4] for y in range(size)
    )
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(pngs: dict[int, bytes]) -> bytes:
    """把多张 PNG 打包成 ICO（Vista 以后的 ICO 允许直接内嵌 PNG）。"""
    sizes = sorted(pngs)
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for size in sizes:
        data = pngs[size]
        entries += struct.pack(
            "<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset
        )
        offset += len(data)
    return header + entries + b"".join(pngs[s] for s in sizes)


def main() -> None:
    assets = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(assets, exist_ok=True)

    pngs = {size: png_bytes(size, render(size)) for size in (16, 24, 32, 48, 64, 128, 256)}

    with open(os.path.join(assets, "icon.png"), "wb") as fh:
        fh.write(pngs[256])
    with open(os.path.join(assets, "tray.png"), "wb") as fh:
        fh.write(pngs[32])
    with open(os.path.join(assets, "icon.ico"), "wb") as fh:
        fh.write(ico_bytes({s: pngs[s] for s in (16, 24, 32, 48, 64, 128, 256)}))

    print("icons written to", assets)


if __name__ == "__main__":
    main()
