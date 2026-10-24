"""网页与 Python 之间的桥。

Python 调 JS 用 window.evaluate_js；JS 调 Python 用 window.pywebview.api.*。
pywebview 的 JS 调用在 (Thread-N _call) 里执行，涉及窗口的操作要切回主线程。
"""

import json
import logging
import os
import subprocess
import sys
import threading
import webbrowser

import webview

from citymetro import paths, storage
from citymetro.about import APP_NAME, VERSION

log = logging.getLogger('citymetro')

OPEN_FILTERS = ('游戏存档 (*.cmsave.json)', 'JSON 文件 (*.json)', '所有文件 (*.*)')
SAVE_FILTERS = ('游戏存档 (*.cmsave.json)', 'JSON 文件 (*.json)')


class ShellApi:
    # pywebview 会把 js_api 对象的公开属性递归反射成 window.pywebview.api，
    # 遇到 Window / COM 这类非方法对象会一路展开到 maximum recursion depth，并刷满 COM 告警。
    # 标注为不可序列化即可让反射跳过。
    window = None
    close_requested = None

    def __init__(self, window=None):
        self.window = window
        self._lock = threading.Lock()
        self.close_requested = threading.Event()
        self.close_requested._serializable = False

    def bind(self, window):
        self.window = window
        self.window._serializable = False

    def app_info(self):
        return {'name': APP_NAME, 'version': VERSION, 'platform': 'pywebview'}

    def choose_save_file(self, mode='open'):
        window = self.window
        if window is None:
            return None
        if mode == 'save':
            dialog, filters, filename = webview.FileDialog.SAVE, SAVE_FILTERS, '城市与地铁-进度.cmsave.json'
        else:
            dialog, filters, filename = webview.FileDialog.OPEN, OPEN_FILTERS, ''
        # pywebview 的对话框会阻塞调用线程（主线程），必须与窗口生命周期错开
        with self._lock:
            result = window.create_file_dialog(
                dialog, directory='', save_filename=filename, file_types=filters
            )
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return str(result)

    def write_export_file(self, path, text):
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(text)
        except (OSError, TypeError) as exc:
            log.warning('写存档失败 %s: %s', path, exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'path': path}

    def read_import_file(self, path):
        try:
            with open(path, 'r', encoding='utf-8-sig') as fh:
                text = fh.read()
        except (OSError, TypeError) as exc:
            log.warning('读存档失败 %s: %s', path, exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'text': text}

    def open_data_dir(self):
        path = storage.data_dir()
        try:
            if sys.platform == 'win32':
                os.startfile(path)
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', path])
            else:
                subprocess.Popen(['xdg-open', path])
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'path': path}

    def open_doc(self, name):
        allowed = {'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt'}
        if name not in allowed:
            return {'ok': False, 'error': '不支持的文件'}
        path = paths.find_doc(name)
        if not path:
            return {'ok': False, 'error': '未找到 ' + name}
        try:
            if sys.platform == 'win32':
                os.startfile(path)
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', path])
            else:
                subprocess.Popen(['xdg-open', path])
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'path': path}

    def open_external(self, url):
        if not str(url).lower().startswith(('http://', 'https://')):
            return {'ok': False, 'error': '仅支持 http/https 链接'}
        try:
            webbrowser.open(url)
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}
        return {'ok': True}


def bridge_script():
    payload = json.dumps({'name': APP_NAME, 'version': VERSION}, ensure_ascii=False)
    return (
        ';(function () {'
        '  var info = ' + payload + ';'
        '  window.__CM_DESKTOP__ = true;'
        '  window.CM = window.CM || {};'
        '  if (window.CM.desktop) {'
        '    window.CM.desktop.name = info.name;'
        '    window.CM.desktop.version = info.version;'
        '  }'
        '})();'
    )
