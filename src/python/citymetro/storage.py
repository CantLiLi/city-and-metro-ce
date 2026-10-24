"""桌面外壳的数据目录。"""

import os
import sys

APP_DIR_NAME = 'CityAndMetro'


def _base_dir():
    if sys.platform == 'win32':
        return os.environ.get('APPDATA') or os.path.expanduser('~')
    if sys.platform == 'darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support')
    return os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')


def data_dir():
    path = os.path.join(_base_dir(), APP_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def profile_dir():
    """WebView2 的配置目录：localStorage 与 IndexedDB 存档都在这里，必须跨启动保留。"""
    path = os.path.join(data_dir(), 'profile')
    os.makedirs(path, exist_ok=True)
    return path


def log_path():
    return os.path.join(data_dir(), 'shell.log')
