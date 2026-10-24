"""城市与地铁社区版 一键打包：Windows 出 Inno Setup 的 setup.exe，macOS 出 dmg。

用法（任意目录都可以跑，路径都按脚本自己算）：
    python src/python/build/build.py            按当前平台打安装包
    python src/python/build/build.py --no-deps  依赖已装好，跳过 pip install
    python src/python/build/build.py --no-installer   只出 dist，不生成 setup.exe / dmg
    python src/python/build/build.py --keep     保留 .tmp/build/ 里的中间产物
    python src/python/build/build.py --version 2.0.1   覆盖 about.py 里的版本号

版本号只从 src/python/citymetro/about.py 读，不另立一套：
    VERSION = 2.0.0，界面、日志、安装包文件名都用它。
产物（都在工作区的 .tmp/build/output/，这个目录被 .gitignore 忽略）：
    Windows  .tmp/build/output/CityAndMetroCE_Setup_v2.0.0.exe
    macOS    .tmp/build/output/CityAndMetroCE_v2.0.0.dmg

两种安装包都只能在对应平台上打：PyInstaller 不做交叉编译，
Inno Setup 只有 Windows 版，dmg 只有 macOS 能生成。
"""

from __future__ import annotations

import argparse
import importlib.util
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
SRC = ROOT / "src"
PY_DIR = SRC / "python"
ENTRY = PY_DIR / "main.py"
ABOUT = PY_DIR / "citymetro" / "about.py"
REQUIREMENTS = PY_DIR / "requirements.txt"
VENV = ROOT / ".venv"
TEMPLATE = HERE / "template" / "CityAndMetro.iss"
ICON_ICO = SRC / "resources" / "favicon.ico"
ICON_PNG = SRC / "resources" / "icon.png"
DOCS = ("LICENSE.txt", "THIRD_PARTY_NOTICES.txt")
DATA_DIRS = ("css", "js", "resources")

WORK = ROOT / ".tmp" / "build"
DIST = WORK / "dist"
BUILD = WORK / "work"
STAGE = WORK / "stage"
OUTPUT = WORK / "output"

# 可执行文件用 ASCII 名，中文名走安装包显示名和 Info.plist 的 DisplayName：
# 进程名带中文在 Windows 的某些杀软和 macOS 的部分工具里会出乱码路径。
EXE_NAME = "CityAndMetroCE"
BUNDLE_ID = "com.cityandmetro.ce"
APP_GUID = "7C1B4F62-3E8A-4D95-9A17-6B2F0C8D5E41"
PUBLISHER = "城市与地铁社区版"
INSTALL_DIR = "CityAndMetroCE"

INNO_CANDIDATES = [
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
    r"C:\Program Files (x86)\Inno Setup 5\ISCC.exe",
]

SYSTEM = platform.system()
IS_WINDOWS = SYSTEM == "Windows"
IS_MAC = SYSTEM == "Darwin"


def _utf8_stdout():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


class Step:
    """第几步、共几步的计数器，别的地方不用算序号。"""

    total = 8
    now = 0

    def __call__(self, title):
        Step.now += 1
        print(f"\n[{Step.now}/{Step.total}] {title}", flush=True)


def run(cmd, check=True):
    print(f"      > {cmd}", flush=True)
    result = subprocess.run(cmd, shell=True, cwd=str(ROOT))
    if check and result.returncode != 0:
        print(f"      [错误] 退出码 {result.returncode}")
        sys.exit(result.returncode)
    return result


def python_exe():
    exe = VENV / "Scripts" / "python.exe" if IS_WINDOWS else VENV / "bin" / "python"
    return str(exe if exe.exists() else Path(sys.executable))


def sep():
    return ";" if IS_WINDOWS else ":"


# ---------------------------------------------------------------- 版本号

class Version:
    def __init__(self, name, number):
        self.name = name
        self.number = number

    @property
    def quad(self):
        """Windows 的文件版本只认四段数字，2.0.0 -> 2.0.0.0。"""
        parts = [int(p) for p in re.findall(r"\d+", self.number)[:4]]
        parts += [0] * (4 - len(parts))
        return tuple(parts[:4])

    @property
    def windows_file(self):
        return f"{EXE_NAME}_Setup_v{self.number}.exe"

    @property
    def mac_file(self):
        return f"{EXE_NAME}_v{self.number}.dmg"


def read_version(override=""):
    """把 about.py 当模块跑一遍拿版本号；about.py 只有常量，没有副作用。"""
    if not ABOUT.is_file():
        raise SystemExit(f"缺少 {ABOUT}")
    spec = importlib.util.spec_from_file_location("_cm_about", ABOUT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    number = str(override or getattr(module, "VERSION", "")).strip().lstrip("v")
    if not re.fullmatch(r"\d+(\.\d+){1,3}", number):
        raise SystemExit(f"版本号应为 2.0.0 这种格式，当前是 {number!r}")
    return Version(getattr(module, "APP_NAME", EXE_NAME), number)


# ---------------------------------------------------------------- 打包前

def has_pyinstaller():
    result = subprocess.run(f'"{python_exe()}" -c "import PyInstaller"', shell=True,
                            capture_output=True)
    return result.returncode == 0


def check_env(version, skip_deps):
    print(f"      平台:   {SYSTEM} {platform.machine()}")
    print(f"      版本:   {version.number}")
    print(f"      Python: {python_exe()}")

    must = [ENTRY, REQUIREMENTS, SRC / "index.html", TEMPLATE]
    missing = [p for p in must if not p.exists()]
    if missing:
        for path in missing:
            print(f"      [错误] 缺少 {path.relative_to(ROOT)}")
        sys.exit(1)

    if IS_WINDOWS:
        print(f"      Inno Setup: {find_inno() or '未找到'}")
    elif IS_MAC:
        print(f"      create-dmg: {shutil.which('create-dmg') or '未安装，改用 hdiutil'}")
    else:
        print("      [错误] 只支持在 Windows / macOS 上打包")
        sys.exit(1)

    if not has_pyinstaller():
        if skip_deps:
            print("      [错误] 没装 PyInstaller，去掉 --no-deps 让它自动装")
            sys.exit(1)
        print("      PyInstaller 未安装，下一步装")

    for icon in (ICON_ICO, ICON_PNG):
        if not icon.exists():
            print(f"      [提示] 没有 {icon.relative_to(ROOT)}，用默认图标")


def install_deps():
    run(f'"{python_exe()}" -m pip install -q -r "{REQUIREMENTS}"')
    run(f'"{python_exe()}" -m pip install -q "pyinstaller>=6.10"')


def clean():
    for path in (DIST, BUILD, STAGE, OUTPUT):
        shutil.rmtree(path, ignore_errors=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- 打包

def stage_src():
    """把 index.html / css / js / resources 摊成一份干净的 src/，随包分发。

    不直接 add-data 整个 src/，否则 python 源码和 __pycache__ 也一起进包。
    """
    target = STAGE / "src"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    shutil.copy2(SRC / "index.html", target / "index.html")
    for name in DATA_DIRS:
        source = SRC / name
        if source.exists():
            shutil.copytree(source, target / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    print(f"      src/ -> {target.relative_to(ROOT)}")
    return target


def write_win_version(version):
    """给 exe 写属性：文件版本、产品名，属性面板和 UAC 提示都靠它。"""
    quad = ", ".join(str(n) for n in version.quad)
    path = STAGE / "version_info.txt"
    path.write_text(
        "VSVersionInfo(\n"
        f"  ffi=FixedFileInfo(filevers=({quad}), prodvers=({quad}), mask=0x3f, flags=0x0,\n"
        "                  OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),\n"
        "  kids=[\n"
        "    StringFileInfo([StringTable('040904B0', [\n"
        f"      StringStruct('CompanyName', '{PUBLISHER}'),\n"
        f"      StringStruct('FileDescription', '{version.name}'),\n"
        f"      StringStruct('FileVersion', '{version.number}'),\n"
        f"      StringStruct('InternalName', '{EXE_NAME}'),\n"
        f"      StringStruct('LegalCopyright', 'Copyright (c) {PUBLISHER}'),\n"
        f"      StringStruct('OriginalFilename', '{EXE_NAME}.exe'),\n"
        f"      StringStruct('ProductName', '{version.name}'),\n"
        f"      StringStruct('ProductVersion', '{version.number}')])]),\n"
        "    VarFileInfo([VarStruct('Translation', [1033, 1200])])\n"
        "  ]\n"
        ")\n",
        encoding="utf-8",
    )
    return path


def make_icns():
    """macOS 只认 .icns：从 png 生成整套 iconset 再打包。"""
    if not ICON_PNG.exists():
        return None
    iconset = STAGE / "AppIcon.iconset"
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir(parents=True)
    for base in (16, 32, 128, 256, 512):
        run(f'sips -z {base} {base} "{ICON_PNG}" --out "{iconset}/icon_{base}x{base}.png"')
        run(f'sips -z {base * 2} {base * 2} "{ICON_PNG}" '
            f'--out "{iconset}/icon_{base}x{base}@2x.png"')
    icns = STAGE / "AppIcon.icns"
    icns.unlink(missing_ok=True)
    run(f'iconutil -c icns "{iconset}" -o "{icns}"')
    return icns if icns.exists() else None


def pyinstaller(version):
    staged = stage_src()

    args = [f'"{python_exe()}" -m PyInstaller',
            "--noconfirm", "--clean", "--windowed", "--onedir",
            f'--name "{EXE_NAME}"',
            f'--distpath "{DIST}"', f'--workpath "{BUILD}"',
            f'--specpath "{STAGE}"',
            f'--paths "{PY_DIR}"',
            f'"--add-data" "{staged}{sep()}src"']
    for name in DOCS:
        if (ROOT / name).exists():
            args.append(f'"--add-data" "{ROOT / name}{sep()}."')

    # pywebview 的后端是运行时按平台反射选的，静态分析看不到，必须显式收
    for name in ("webview", "clr_loader", "pythonnet"):
        args.append(f"--collect-all {name}")

    if IS_WINDOWS:
        if ICON_ICO.exists():
            args.append(f'--icon "{ICON_ICO}"')
        args.append(f'--version-file "{write_win_version(version)}"')
        for name in ("webview.platforms.winforms", "webview.platforms.edgechromium", "clr"):
            args.append(f"--hidden-import {name}")
        args.append("--collect-all pywin32")
    else:
        icns = make_icns()
        if icns:
            args.append(f'--icon "{icns}"')
        args.append(f'--osx-bundle-identifier {BUNDLE_ID}')
        for name in ("webview.platforms.cocoa", "objc", "Foundation", "AppKit", "WebKit",
                     "Quartz", "Cocoa"):
            args.append(f"--collect-all {name}")

    args.append(f'"{ENTRY}"')
    run(" ".join(args))


def app_dir():
    return DIST / EXE_NAME if IS_WINDOWS else DIST / f"{EXE_NAME}.app"


def _bundle_contents():
    return app_dir() / "Contents"


def patch_plist(version):
    """Finder / 程序坞里显示中文名，CFBundleName 保持 ASCII 免得路径出问题。"""
    plist = _bundle_contents() / "Info.plist"
    if not plist.exists() or not shutil.which("plutil"):
        return
    run(f'plutil -replace CFBundleDisplayName -string "{version.name}" "{plist}"', check=False)
    run(f'plutil -replace CFBundleShortVersionString -string "{version.number}" "{plist}"',
        check=False)
    run(f'plutil -replace CFBundleVersion -string "{version.number}" "{plist}"', check=False)


def verify_dist():
    if IS_WINDOWS:
        base = app_dir()
        must = [base / f"{EXE_NAME}.exe"]
        # PyInstaller 6 把数据分析到 _internal，也就是运行时的 sys._MEIPASS
        roots = [base / "_internal", base]
    else:
        base = app_dir()
        must = [_bundle_contents() / "MacOS" / EXE_NAME]
        roots = [_bundle_contents() / "Frameworks", base]

    found = None
    for root in roots:
        if (root / "src" / "index.html").is_file():
            found = root
            break
    if found is None:
        print("      [错误] 包里没有 src/index.html，前端资源没打进去")
        for root in roots:
            print(f"             检查过 {root.relative_to(ROOT)}")
        sys.exit(1)

    missing = [p for p in must if not p.exists()]
    if missing:
        for path in missing:
            print(f"      [错误] 缺少 {path.relative_to(ROOT)}")
        sys.exit(1)
    for name in ("css", "js", "resources"):
        if not (found / "src" / name).is_dir():
            print(f"      [提示] 包里缺 src/{name}")
    print(f"      产物完整: {base.relative_to(ROOT)}")


# ---------------------------------------------------------------- 安装包

def find_inno():
    if not IS_WINDOWS:
        return ""
    for path in INNO_CANDIDATES:
        if Path(path).exists():
            return path
    return shutil.which("iscc") or ""


def make_windows_installer(version):
    inno = find_inno()
    if not inno:
        print("      [错误] 没找到 Inno Setup 6（https://jrsoftware.org/isdl.php）")
        sys.exit(1)

    replacements = {
        "APP_NAME": version.name,
        "APP_ID": APP_GUID,
        "APP_EXE": f"{EXE_NAME}.exe",
        "APP_VERSION": version.number,
        "APP_PUBLISHER": PUBLISHER,
        "INSTALL_DIR": INSTALL_DIR,
        "DIST_DIR": app_dir().as_posix(),
        "OUTPUT_DIR": OUTPUT.as_posix(),
        "OUTPUT_BASE": f"{EXE_NAME}_Setup_v{version.number}",
        "ICON_FILE": ICON_ICO.as_posix(),
    }
    text = TEMPLATE.read_text(encoding="utf-8")
    for key, value in replacements.items():
        text = text.replace(f"@@{key}@@", value)

    # Inno 6 只认带 BOM 的 UTF-8，否则模板里的中文会变成乱码
    iss = STAGE / f"{EXE_NAME}.iss"
    STAGE.mkdir(parents=True, exist_ok=True)
    iss.write_text(text, encoding="utf-8-sig")
    print(f"      已生成 {iss.relative_to(ROOT)}")

    run(f'"{inno}" /Q "{iss}"')

    out = OUTPUT / version.windows_file
    if not out.exists():
        print(f"      [错误] Inno 没产出 {out}")
        sys.exit(1)
    return out


def make_macos_dmg(version):
    app = app_dir()
    dmg = OUTPUT / version.mac_file
    dmg.unlink(missing_ok=True)

    if shutil.which("create-dmg"):
        run(f'create-dmg --volname "{version.name}" --window-pos 200 120 '
            f'--window-size 600 400 --icon-size 100 '
            f'--icon "{EXE_NAME}.app" 150 190 --app-drop-link 450 190 '
            f'--no-internet-enable "{dmg}" "{app}"', check=False)
    if not dmg.exists():
        print("      [提示] 用 hdiutil")
        run(f'hdiutil create -srcfolder "{app}" -volname "{version.name}" '
            f'-format UDZO -ov "{dmg}"')

    if not dmg.exists():
        print(f"      [错误] 没产出 {dmg}")
        sys.exit(1)
    return dmg


def make_installer(version):
    return make_windows_installer(version) if IS_WINDOWS else make_macos_dmg(version)


def finish(version, artifact):
    print("\n" + "=" * 56)
    print(f"  构建完成  {version.name} v{version.number}")
    print("=" * 56)
    print(f"  应用目录: {app_dir().relative_to(ROOT)}")
    if artifact:
        size = artifact.stat().st_size / 1024 / 1024
        print(f"  安装包:   {artifact.relative_to(ROOT)}  ({size:.1f} MB)")
    print(f"  输出目录: {OUTPUT.relative_to(ROOT)}")


def main(argv=None):
    _utf8_stdout()
    parser = argparse.ArgumentParser(
        description="城市与地铁社区版 一键打包（Inno Setup / dmg）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--version", default="", help="覆盖 about.py 里的版本号，如 2.0.1")
    parser.add_argument("--no-deps", action="store_true", help="跳过 pip install")
    parser.add_argument("--no-installer", action="store_true", help="只出 dist")
    parser.add_argument("--keep", action="store_true", help="保留 .tmp/build/ 中间产物")
    args = parser.parse_args(argv)

    version = read_version(args.version)

    print("=" * 56)
    print(f"  打包 {version.name} v{version.number}")
    print("=" * 56)

    step = Step()
    step("检查环境")
    check_env(version, args.no_deps)

    step("清理旧产物")
    clean()

    step("安装依赖")
    if args.no_deps:
        print("      跳过")
    else:
        install_deps()
        if not has_pyinstaller():
            print("      [错误] PyInstaller 装完还是 import 不了")
            sys.exit(1)

    step("PyInstaller 打包")
    pyinstaller(version)

    step("修 macOS 包信息" if IS_MAC else "校验产物")
    if IS_MAC:
        patch_plist(version)
    verify_dist()

    step("生成安装包")
    artifact = None if args.no_installer else make_installer(version)

    step("清理中间产物")
    if args.keep:
        print("      保留 .tmp/build/{work,stage,dist}")
    else:
        for path in (BUILD, STAGE):
            shutil.rmtree(path, ignore_errors=True)

    step("完成")
    finish(version, artifact)
    return 0


if __name__ == "__main__":
    sys.exit(main())
