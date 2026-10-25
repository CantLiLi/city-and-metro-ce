"""城市与地铁社区版 Android 一键打包。

用法（任意目录都可以跑，路径都按脚本自己算）：

    python src/android/build_apk.py                 打 debug 包（自签，可直接安装）
    python src/android/build_apk.py --release       打 release 包（未配签名时仍用 debug 签名）
    python src/android/build_apk.py --no-deps       依赖已装好，跳过 SDK 检查提示
    python src/android/build_apk.py --version 2.1.1 覆盖 about.py 里的版本号

前置条件（脚本会检查并给出提示）：
    - JDK 17 或更高（JAVA_HOME 或 PATH 里的 java）
    - Android SDK（ANDROID_HOME / ANDROID_SDK_ROOT / local.properties 的 sdk.dir），需含
      platforms;android-34 与 build-tools;34.0.0
    - Gradle：优先用工程里的 gradlew，没有就走系统 gradle

产物（工作区的 .tmp/build/android/，这个目录被 .gitignore 忽略）：
    .tmp/build/android/CityAndMetroCE_v2.1.0-debug.apk
    .tmp/build/android/CityAndMetroCE_v2.1.0-release.apk

版本号只从 src/python/citymetro/about.py 读，与桌面版同一套。
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = ROOT / "src"
ABOUT = SRC / "python" / "citymetro" / "about.py"
SYNC = HERE / "sync_assets.py"

WORK = ROOT / ".tmp" / "build" / "android"
OUTPUT = WORK / "output"

APP_NAME_DEFAULT = "城市与地铁社区版"
IS_WINDOWS = platform.system() == "Windows"


def _utf8_stdout():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def step(now: int, total: int, title: str):
    print(f"\n[{now}/{total}] {title}", flush=True)


def run(cmd, cwd=None, check=True, env=None):
    print(f"      > {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, cwd=str(cwd or ROOT), env=env)
    if check and result.returncode != 0:
        print(f"      [错误] 退出码 {result.returncode}")
        raise SystemExit(result.returncode)
    return result


def read_version(override: str = "") -> tuple[str, str]:
    """从 about.py 读应用名与版本号；about.py 只有常量，没有副作用。"""
    if not ABOUT.is_file():
        raise SystemExit(f"缺少 {ABOUT}")
    spec = importlib.util.spec_from_file_location("_cm_about", ABOUT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    number = str(override or getattr(module, "VERSION", "")).strip().lstrip("v")
    if not re.fullmatch(r"\d+(\.\d+){1,3}", number):
        raise SystemExit(f"版本号应为 2.0.0 这种格式，当前是 {number!r}")
    name = getattr(module, "APP_NAME", APP_NAME_DEFAULT)
    return name, number


def version_code(number: str) -> int:
    """2.1.0 -> 20100，Android 的 versionCode 只能是整数且必须单调递增。"""
    parts = [int(p) for p in re.findall(r"\d+", number)[:3]]
    parts += [0] * (3 - len(parts))
    major, minor, patch = parts[:3]
    return major * 10000 + minor * 100 + patch


# AGP 8.4 的 JdkImageTransform 会调 jlink 处理 core-for-system-modules.jar，
# GraalVM 的 jlink 干不了这活（报 module-path 错），所以优先挑普通 JDK 17+。
_JAVA_HOMES = (
    r"C:\Program Files\Java\jdk-17",
    r"C:\Program Files\Java\jdk-21",
    r"C:\Program Files\Android\Android Studio\jbr",
    r"C:\Program Files\Eclipse Adoptium",
)


def find_java() -> str:
    """返回可用的 JAVA_HOME（不是 java.exe），找不到返回空串。"""
    candidates = []
    env = os.environ.get("JAVA_HOME", "")
    if env:
        candidates.append(env)
    candidates.extend(_JAVA_HOMES)

    for home in candidates:
        exe = Path(home) / "bin" / ("java.exe" if IS_WINDOWS else "java")
        if not exe.is_file():
            continue
        # GraalVM 的 jlink 跟 AGP 不兼容，跳过
        release = Path(home) / "release"
        if release.is_file() and "graalvm" in release.read_text(errors="ignore").lower():
            continue
        return home
    return ""


def find_sdk() -> str:
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(key, "")
        if value and Path(value).is_dir():
            return value
    local = HERE / "local.properties"
    if local.is_file():
        for line in local.read_text(encoding="utf-8").splitlines():
            if line.startswith("sdk.dir="):
                value = line.split("=", 1)[1].strip().replace("\\\\", "\\")
                if Path(value).is_dir():
                    return value
    # 和 find_gradle 一样，工作区 .tmp 里解压的 SDK 也算数
    for guess in (
        ROOT / ".tmp" / "android-sdk" / "sdk-root",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk",
        Path.home() / "Android" / "Sdk",
        Path.home() / "Library" / "Android" / "sdk",
    ):
        if guess.is_dir():
            return str(guess)
    return ""


def find_gradle() -> list[str]:
    gradlew = HERE / ("gradlew.bat" if IS_WINDOWS else "gradlew")
    if gradlew.is_file():
        return [str(gradlew)]
    found = shutil.which("gradle")
    if found:
        return [found]
    # 随手解压到工作区里的 gradle 也算数（.tmp 被忽略，不进版本控制）
    for home in sorted((ROOT / ".tmp" / "tools").glob("gradle-*")):
        exe = home / "bin" / ("gradle.bat" if IS_WINDOWS else "gradle")
        if exe.is_file():
            return [str(exe)]
    return []


def check_env(name: str, number: str, skip_deps: bool) -> tuple[list[str], str]:
    print(f"      平台:   {platform.system()} {platform.machine()}")
    print(f"      版本:   {number}")
    print(f"      版本码: {version_code(number)}")

    for path in (SYNC, HERE / "settings.gradle.kts", HERE / "app" / "build.gradle.kts"):
        if not path.exists():
            raise SystemExit(f"缺少 {path.relative_to(ROOT)}")

    java = find_java()
    print(f"      JDK:    {java or '未找到'}")

    sdk = find_sdk()
    print(f"      Android SDK: {sdk or '未找到'}")

    gradle = find_gradle()
    print(f"      Gradle: {' '.join(gradle) if gradle else '未找到'}")

    problems = []
    if not java:
        problems.append("没有可用的 JDK 17+：装 JDK 17 并设置 JAVA_HOME（GraalVM 的 jlink 不可用）")
    if not sdk:
        problems.append("没有 Android SDK：设置 ANDROID_HOME，或复制 local.properties.example 为 local.properties")
    if not gradle:
        problems.append("没有 Gradle：用 Android Studio 打开本目录生成 gradlew，或安装 gradle")
    if problems:
        for p in problems:
            print(f"      [错误] {p}")
        if skip_deps:
            raise SystemExit(1)
        print("\n      装好上面这些后再运行本脚本。首次构建会下载 Gradle 与 Android 依赖。")
        raise SystemExit(1)

    return gradle, sdk


def write_local_properties(sdk: str):
    """让 Gradle 找到 SDK；已有正确配置就保留。

    local.properties 走 Java properties 解析：路径里的反斜杠必须写成两个，否则 Gradle
    把 \\C 当转义序列吃掉，报「文件名或目录名语法不正确」。手写的文件常犯这个错。
    所以不能只看 sdk.dir 指向的目录存不存在（单反斜杠的 Windows 路径照样能 stat 通），
    必须按 properties 的转义规则还原后再判断。
    """
    local = HERE / "local.properties"
    if local.is_file() and _sdk_dir_ok(local):
        return
    local.write_text("sdk.dir=" + sdk.replace("\\", "\\\\") + "\n", encoding="utf-8")
    print(f"      已写 {local.relative_to(ROOT)}")


def _sdk_dir_ok(local: Path) -> bool:
    """按 Java properties 规则解析 sdk.dir，判断 Gradle 眼里这个路径真能用。

    properties 里合法转义只有 \\\\ 和 \\: 等少数几种。Windows 路径写成单个反斜杠时，
    Gradle 会把 \\C 当成无效转义悄悄吃掉，路径就废了——所以单反斜杠直接判不合格，
    不能交给 Path.is_dir() 去猜（它按 Windows 习惯理解，反而会误判成有效）。
    """
    raw = ""
    for line in local.read_text(encoding="utf-8").splitlines():
        if line.startswith("sdk.dir="):
            raw = line.split("=", 1)[1].strip()
            break
    if not raw:
        return False
    # 剔除合法的 \\\\ 与 \\: 之后，还不该剩下任何反斜杠
    rest = raw.replace("\\\\\\\\", "").replace("\\\\:", "")
    if "\\" in rest:
        return False
    resolved = raw.replace("\\\\\\\\", "\\").replace("\\\\:", ":")
    return Path(resolved).is_dir()


def sync_assets():
    run([sys.executable, str(SYNC), "--docs"], cwd=ROOT)


def build(gradle_cmd: list[str], variant: str, sdk: str, java_home: str):
    task = f":app:assemble{'Debug' if variant == 'debug' else 'Release'}"
    env = dict(os.environ)
    env["ANDROID_HOME"] = sdk
    env["ANDROID_SDK_ROOT"] = sdk
    env["JAVA_HOME"] = java_home
    env["PATH"] = str(Path(java_home) / "bin") + os.pathsep + env.get("PATH", "")
    run([*gradle_cmd, task, "--no-daemon", "--console=plain"], cwd=HERE, env=env)


def collect(name: str, number: str, variant: str) -> Path:
    suffix = "debug" if variant == "debug" else "release"
    produced = HERE / "app" / "build" / "outputs" / "apk" / suffix
    apks = sorted(produced.glob("*.apk")) if produced.is_dir() else []
    if not apks:
        raise SystemExit(f"Gradle 没有产出 APK：检查 {produced}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / f"CityAndMetroCE_v{number}-{suffix}.apk"
    shutil.copy2(apks[0], target)
    return target


def finish(name: str, number: str, artifact: Path):
    size = artifact.stat().st_size / 1024 / 1024
    print("\n" + "=" * 56)
    print(f"  构建完成  {name} v{number}")
    print("=" * 56)
    print(f"  APK:      {artifact.relative_to(ROOT)}  ({size:.1f} MB)")
    print("  安装:     adb install -r " + str(artifact.relative_to(ROOT)))
    print(f"  输出目录: {OUTPUT.relative_to(ROOT)}")


def main(argv=None) -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(
        description="城市与地铁社区版 Android 打包",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--version", default="", help="覆盖 about.py 里的版本号，如 2.1.1")
    parser.add_argument("--release", action="store_true", help="打 release 包")
    parser.add_argument("--no-deps", action="store_true", help="环境不全时直接失败，不打印安装指引")
    args = parser.parse_args(argv)

    name, number = read_version(args.version)
    variant = "release" if args.release else "debug"

    print("=" * 56)
    print(f"  打包 {name} v{number}（{variant}）")
    print("=" * 56)

    step(1, 5, "检查环境")
    gradle_cmd, sdk = check_env(name, number, args.no_deps)
    java_home = find_java()
    write_local_properties(sdk)

    step(2, 5, "同步前端资源")
    sync_assets()

    step(3, 5, "Gradle 构建")
    build(gradle_cmd, variant, sdk, java_home)

    step(4, 5, "收集产物")
    artifact = collect(name, number, variant)

    step(5, 5, "完成")
    finish(name, number, artifact)
    return 0


if __name__ == "__main__":
    sys.exit(main())
