"""生成桌面外壳（pywebview）用的图标：resources/icon.png（macOS / Linux）与 resources/favicon.ico（Windows）。

macOS 的图标不能直接拿网页 logo 的 PNG：Dock 会把整张方图当图标画出来，
深色 Logo 在深色壁纸上几乎看不见，也没有系统要求的留白与圆角。
这里按 Apple 的 macOS 图标网格重画：底上一块浅色圆角底板、居中放大后的 Logo，
四周留出系统视觉重心的边距。

用法（改了 Logo 才需要跑一次，产物进版本库）：
    python src/scripts/make-icons.py
"""

import math
import os

from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'resources')
LOGO = os.path.join(SRC, 'logo-navy.png')
PNG_OUT = os.path.join(SRC, 'icon.png')
ICO_OUT = os.path.join(SRC, 'favicon.ico')

# macOS 图标网格：底板直径占画布 84%，四周留 8% 空白
PLATE_INSET = 0.08
LOGO_SCALE = 0.82
PLATE_TOP = (255, 255, 255, 255)
PLATE_BOTTOM = (228, 237, 245, 255)


def superellipse_mask(size):
    """iOS/macOS 那种「方中带圆」的轮廓，比正圆角方块的转角更饱满。"""
    mask = Image.new('L', (size, size), 0)
    half = size / 2
    plate = half * (1 - 2 * PLATE_INSET)
    n = 5.0
    points = []
    for i in range(1024):
        t = i / 1024 * 2 * math.pi
        c, s = math.cos(t), math.sin(t)
        x = math.copysign(abs(c) ** (2 / n), c) * plate
        y = math.copysign(abs(s) ** (2 / n), s) * plate
        points.append((half + x, half + y))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def render(size):
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    gradient = Image.new('RGBA', (size, size))
    for y in range(size):
        t = y / max(1, size - 1)
        gradient.paste(
            tuple(round(PLATE_TOP[i] + (PLATE_BOTTOM[i] - PLATE_TOP[i]) * t) for i in range(4)),
            (0, y, size, y + 1),
        )
    canvas.paste(gradient, (0, 0), superellipse_mask(size))

    logo_side = round(size * LOGO_SCALE)
    logo = Image.open(LOGO).convert('RGBA').resize((logo_side, logo_side), Image.LANCZOS)
    offset = (size - logo_side) // 2
    canvas.alpha_composite(logo, (offset, offset))
    return canvas


def fit(path, size):
    """缩到刚好装进 size×size 的方框，四周留一点透明边，避免图标顶满系统贴边裁切。"""
    img = Image.open(path).convert('RGBA')
    box = img.getbbox()
    if box:
        img = img.crop(box)
    inner = round(size * 0.9)
    img.thumbnail((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.alpha_composite(img, ((size - img.width) // 2, (size - img.height) // 2))
    return out


def main():
    render(1024).save(PNG_OUT, 'PNG')
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [fit(PNG_OUT, s) for s in sizes]
    frames[-1].save(ICO_OUT, 'ICO', sizes=[(s, s) for s in sizes])
    print('已生成', os.path.relpath(PNG_OUT), os.path.relpath(ICO_OUT))


if __name__ == '__main__':
    main()
