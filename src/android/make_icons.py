"""从 src/resources/icon.png 生成 Android 各密度的启动图标。

用法：python src/android/make_icons.py

产物（都在 app/src/main/res/ 下，会随仓库提交的理由：图标不是每个版本都变，
放进来省得每次构建都要跑一遍依赖 Pillow 的脚本）：
    mipmap-mdpi/ic_launcher.png      48x48
    mipmap-hdpi/ic_launcher.png      72x72
    mipmap-xhdpi/ic_launcher.png     96x96
    mipmap-xxhdpi/ic_launcher.png    144x144
    mipmap-xxxhdpi/ic_launcher.png   192x192
    mipmap-*/ic_launcher_foreground.png   自适应图标前景，留出安全边距
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = ROOT / "src" / "resources" / "icon.png"
RES = HERE / "app" / "src" / "main" / "res"

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}
BASE = 48          # mdpi 下启动图标的边长
FOREGROUND_BASE = 108  # 自适应图标画布 108dp，实际图形只占中间 72dp


def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("[错误] 需要 Pillow：python -m pip install pillow")
        return 1

    if not SOURCE.is_file():
        print(f"[错误] 缺少 {SOURCE}")
        return 1

    src = Image.open(SOURCE).convert("RGBA")
    # 先转成正方形，避免非等比缩放把图形压扁
    side = max(src.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(src, ((side - src.width) // 2, (side - src.height) // 2))

    for density, scale in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)

        size = int(BASE * scale)
        square.resize((size, size), Image.LANCZOS).save(folder / "ic_launcher.png")

        round_size = int(BASE * scale)
        square.resize((round_size, round_size), Image.LANCZOS).save(folder / "ic_launcher_round.png")

        # 自适应图标前景：图形缩到画布中央 2/3，四周留透明，圆形遮罩下才不会被裁到
        canvas = int(FOREGROUND_BASE * scale)
        inner = int(canvas * 2 / 3)
        fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        fg.paste(square.resize((inner, inner), Image.LANCZOS), ((canvas - inner) // 2,) * 2)
        fg.save(folder / "ic_launcher_foreground.png")

        print(f"      mipmap-{density}: {size}px")

    return 0


if __name__ == "__main__":
    sys.exit(main())
