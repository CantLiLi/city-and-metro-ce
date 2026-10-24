"""定位前端资源目录（含 index.html 的 src/）。"""

import os
import sys

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ROOT_DIR = os.path.dirname(os.path.dirname(_APP_DIR))


def _frozen_dir():
    # PyInstaller 单文件/单目录把资源解包到 _MEIPASS
    return getattr(sys, '_MEIPASS', None)


def find_src_dir():
    candidates = []
    frozen = _frozen_dir()
    if frozen:
        candidates += [os.path.join(frozen, 'src'), frozen]
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), 'src'))
    candidates += [os.path.join(_ROOT_DIR, 'src'), _APP_DIR]
    for path in candidates:
        if os.path.isfile(os.path.join(path, 'index.html')):
            return path
    raise RuntimeError('未找到前端资源目录 src/index.html，请确认随应用一起分发。')


def find_doc(name):
    for base in (_ROOT_DIR, _frozen_dir() or _ROOT_DIR):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            return path
    return None


def image_dir():
    return os.path.join(find_src_dir(), 'resources')
