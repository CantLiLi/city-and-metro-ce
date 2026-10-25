"""把前端资源同步进 Android 的 assets/，并准备构建。

用法（在仓库根目录或任意目录都可以）：

    python src/android/sync_assets.py            同步 src/ 到 app/src/main/assets/src
    python src/android/sync_assets.py --docs     顺便把许可与第三方声明放进 assets/docs

产物：
    src/android/app/src/main/assets/src/    index.html + css/ + js/ + resources/
    src/android/app/src/main/assets/docs/   LICENSE.txt, THIRD_PARTY_NOTICES.txt

assets/ 被 .gitignore 忽略：它是 src/ 的一份拷贝，提交进仓库只会让两份代码打架。
构建前必须重跑，否则改过的前端代码打不进包。
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent  # src/
ROOT = SRC.parent  # 仓库根
ASSETS = HERE / "app" / "src" / "main" / "assets"

DATA_DIRS = ("css", "js", "resources")
DOCS = ("LICENSE.txt", "THIRD_PARTY_NOTICES.txt")


def sync_src() -> Path:
    target = ASSETS / "src"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)

    index = SRC / "index.html"
    if not index.is_file():
        raise SystemExit(f"缺少 {index}")
    shutil.copy2(index, target / "index.html")

    for name in DATA_DIRS:
        source = SRC / name
        if not source.is_dir():
            print(f"      [提示] 没有 src/{name}")
            continue
        shutil.copytree(
            source, target / name,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.map"),
        )
    return target


def sync_docs() -> Path:
    target = ASSETS / "docs"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    missing = []
    for name in DOCS:
        source = ROOT / name
        if source.is_file():
            shutil.copy2(source, target / name)
        else:
            missing.append(name)
    lic = ROOT / "licenses" / "ODbL-1.0.txt"
    if lic.is_file():
        shutil.copy2(lic, target / "ODbL-1.0.txt")
    if missing:
        print(f"      [提示] 缺少 {', '.join(missing)}，该文档在应用内不可用")
    return target


def count(path: Path) -> str:
    files = [p for p in path.rglob("*") if p.is_file()]
    size = sum(p.stat().st_size for p in files)
    return f"{len(files)} 个文件, {size / 1024 / 1024:.1f} MB"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="同步前端资源到 Android assets/")
    parser.add_argument("--docs", action="store_true", help="同时同步许可与第三方声明")
    args = parser.parse_args(argv)

    src = sync_src()
    print(f"      src/ -> {src.relative_to(ROOT)}  ({count(src)})")
    if args.docs:
        docs = sync_docs()
        print(f"      docs/ -> {docs.relative_to(ROOT)}  ({count(docs)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
