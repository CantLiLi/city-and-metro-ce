"""启动前就要读到的偏好项。

网页里的设置存在 WebView2 的 localStorage 里，创建窗口之前读不到，
所以「GPU 加速」这类需要内核启动参数的决定由前端通过桥写到数据目录的 graphics.json，
外壳在创建窗口前读这个文件。
"""

import json
import logging
import os

from citymetro import storage

log = logging.getLogger('citymetro')

GRAPHICS_FILE = 'graphics.json'


def _path():
    return os.path.join(storage.data_dir(), GRAPHICS_FILE)


def gpu_enabled():
    """默认开启；文件缺失、损坏或没写这一项时也按开启处理。"""
    try:
        with open(_path(), 'r', encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return True
    return not (isinstance(data, dict) and data.get('gpu') is False)


def set_gpu(enabled):
    try:
        with open(_path(), 'w', encoding='utf-8', newline='\n') as fh:
            json.dump({'gpu': bool(enabled)}, fh)
    except OSError as exc:
        log.warning('写显卡偏好失败: %s', exc)
        return {'ok': False, 'error': str(exc)}
    return {'ok': True, 'gpu': bool(enabled)}
