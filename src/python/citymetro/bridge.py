"""网页与 Python 之间的桥。

Python 调 JS 用 window.evaluate_js；JS 调 Python 用 window.pywebview.api.*。
pywebview 的 JS 调用在 (Thread-N _call) 里执行，涉及窗口的操作要切回主线程。
"""

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import webbrowser

import webview

from citymetro import paths, perf, prefs, saves, storage
from citymetro.about import APP_NAME, UPDATE_INFO, VERSION

log = logging.getLogger('citymetro')

OPEN_FILTERS = ('游戏存档 (*.cmsave.json)', 'JSON 文件 (*.json)', '所有文件 (*.*)')
SAVE_FILTERS = ('游戏存档 (*.cmsave.json)', 'JSON 文件 (*.json)')

CACHE_KEEP = 4000          # 缓存文件数量上限，超了按修改时间淘汰最旧的
CACHE_TEXT_MAX = 300000    # 单条缓存文本上限


def _cache_path(key):
    # 文件名用摘要：键里含有 Windows 不允许出现在文件名里的字符
    return os.path.join(storage.cache_dir(), hashlib.sha1(key.encode('utf-8')).hexdigest())


def _prune_cache(base):
    try:
        files = [e for e in os.scandir(base) if e.is_file()]
    except OSError:
        return
    extra = len(files) - CACHE_KEEP
    if extra <= 0:
        return
    files.sort(key=lambda e: e.stat().st_mtime)
    for entry in files[:extra]:
        try:
            os.remove(entry.path)
        except OSError:
            pass


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
        self._store = saves.SaveStore()

    def bind(self, window):
        self.window = window
        self.window._serializable = False

    def app_info(self):
        return {'name': APP_NAME, 'version': VERSION, 'platform': 'pywebview'}

    def log_client(self, msg):
        # 临时诊断：把前端的判断结果记进 shell.log
        log.info('CLIENT %s', msg)
        return {'ok': True}

    def choose_save_file(self, mode='open'):
        okay, payload = self._choose_file(mode)
        return payload if okay else None

    def _choose_file(self, mode):
        # 对话框失败与用户取消要分开：前端只把 false 当取消，失败要能看到原因
        window = self.window
        if window is None:
            return False, '窗口未就绪'
        if mode == 'save':
            dialog, filters, filename = webview.FileDialog.SAVE, SAVE_FILTERS, '城市与地铁社区版-进度.cmsave.json'
        else:
            dialog, filters, filename = webview.FileDialog.OPEN, OPEN_FILTERS, ''
        if sys.platform == 'darwin':
            log.info('走 macOS 原生面板 mode=%s filters=%s', mode, filters)
            return self._choose_file_macos(mode, filters, filename)
        # pywebview 的对话框会阻塞调用线程（主线程），必须与窗口生命周期错开
        try:
            with self._lock:
                result = window.create_file_dialog(
                    dialog, directory='', save_filename=filename, file_types=filters
                )
        except Exception as exc:
            log.warning('打开文件对话框失败 %s: %s', mode, exc, exc_info=True)
            return False, '无法打开文件选择窗口：' + str(exc)
        if not result:
            return False, None
        path = result[0] if isinstance(result, (list, tuple)) else str(result)
        if not path:
            return False, None
        return True, path

    def _choose_file_macos(self, mode, filters, filename):
        # macOS 走 window.macos_file_panel：pywebview 的 Cocoa 实现会把面板排进主线程，
        # 却让调用线程等一个取消时永远不会释放的信号量，看起来就是点了没反应
        from citymetro import window as shell_window

        extensions = []
        for f in filters:
            part = f.split('(', 1)[1].rstrip(')') if '(' in f else ''
            for ext in part.split(';'):
                ext = ext.strip().lstrip('*').lstrip('.')
                if ext and ext not in extensions:
                    extensions.append(ext)
        # 「所有文件 (*.*)」在 macOS 上是空列表（不限制类型），写成 * 会让面板什么都选不了
        extensions = [e for e in extensions if e != '*']
        try:
            path = shell_window.macos_file_panel(
                'save' if mode == 'save' else 'open',
                filename or '选择存档文件',
                extensions,
            )
            log.info('macOS 面板返回 path=%r', path)
        except Exception as exc:
            log.warning('打开文件对话框失败 %s: %s', mode, exc, exc_info=True)
            return False, '无法打开文件选择窗口：' + str(exc)
        if not path:
            return False, None
        return True, path

    def write_export_file(self, path, text):
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(text)
        except (OSError, TypeError) as exc:
            log.warning('写存档失败 %s: %s', path, exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'path': path}

    def open_import_file(self):
        # 一次调用取回路径与文本：取消返回 ok=False 且没有 error，失败带 error
        log.info('open_import_file 被调用 platform=%s', sys.platform)
        okay, payload = self._choose_file('open')
        log.info('open_import_file 选择结果 ok=%s payload=%r', okay, payload)
        if not okay:
            return {'ok': False, 'error': payload} if payload else {'ok': False}
        result = self.read_import_file(payload)
        if result.get('ok'):
            result['name'] = os.path.basename(payload)
        return result

    def export_to_file(self, text):
        okay, payload = self._choose_file('save')
        if not okay:
            return {'ok': False, 'error': payload} if payload else {'ok': False}
        return self.write_export_file(payload, text)

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

    def set_window_mode(self, mode):
        # 显示设置里的窗口方式：普通窗口 / 窗口化全屏
        from citymetro import window as shell_window

        return shell_window.set_window_mode(self.window, mode)

    def set_gpu(self, enabled):
        # GPU 加速由内核启动参数决定，网页只能把它记下来，下次启动才生效
        return prefs.set_gpu(enabled)

    def perf_stats(self, want_gpu=True):
        # 右下角监控面板每秒问一次：本软件各进程的处理器、内存与显卡占用
        return perf.snapshot(bool(want_gpu))

    def cache_read(self, keys):
        # 渲染派生数据的磁盘缓存读：缺失的键直接不返回
        try:
            base = storage.cache_dir()
            items = {}
            for key in keys or []:
                if not isinstance(key, str) or not key or len(key) > 200:
                    continue
                try:
                    with open(os.path.join(base, hashlib.sha1(key.encode('utf-8')).hexdigest()),
                              'r', encoding='utf-8') as fh:
                        items[key] = fh.read()
                except OSError:
                    continue
            return {'ok': True, 'items': items}
        except Exception as exc:
            log.debug('读缓存失败: %s', exc)
            return {'ok': False, 'error': str(exc)}

    def cache_write(self, items):
        # 批量写回：先写临时文件再改名，避免写一半的内容被下次启动读到
        if not isinstance(items, dict):
            return {'ok': False, 'error': '数据格式不对'}
        try:
            base = storage.cache_dir()
            written = 0
            for key, text in items.items():
                if not isinstance(key, str) or not key or len(key) > 200:
                    continue
                if not isinstance(text, str) or len(text) > CACHE_TEXT_MAX:
                    continue
                path = _cache_path(key)
                try:
                    with open(path + '.tmp', 'w', encoding='utf-8') as fh:
                        fh.write(text)
                    os.replace(path + '.tmp', path)
                    written += 1
                except OSError:
                    continue
            if written:
                _prune_cache(base)
            return {'ok': True, 'n': written}
        except Exception as exc:
            log.debug('写缓存失败: %s', exc)
            return {'ok': False, 'error': str(exc)}

    def save_index_get(self):
        # 存档索引（进度与存档的清单）：不存在时 index=None，前端按空索引处理
        return self._store.get_index()

    def save_index_set(self, index):
        return self._store.set_index(index)

    def save_index_rebuild(self):
        # 清单丢了或和 slots 里的文件对不上时，按文件重建一份（进度名称会退化成进度 id）
        return self._store.rebuild_index()

    def save_slot_write(self, key, text):
        return self._store.write_slot(key, text)

    def save_slot_read(self, key):
        return self._store.read_slot(key)

    def save_slot_verify(self, key, text):
        return self._store.verify_slot(key, text)

    def save_slot_delete(self, key):
        return self._store.delete_slot(key)

    def save_dir(self):
        return self._store.info()

    def quit_app(self):
        # 只登记意图：关窗与存档等待都在 main.py 的退出线程里做，避免在 JS 调用线程里销毁窗口
        if self.window is None:
            return {'ok': False, 'error': '窗口未就绪'}
        self.close_requested.set()
        return {'ok': True}


def bridge_script():
    payload = json.dumps(
        {'name': APP_NAME, 'version': VERSION, 'updateInfo': list(UPDATE_INFO)},
        ensure_ascii=False,
    )
    return (
        ';(function () {'
        '  var info = ' + payload + ';'
        '  window.__CM_DESKTOP__ = true;'
        '  window.CM = window.CM || {};'
        '  if (window.CM.desktop) {'
        '    window.CM.desktop.name = info.name;'
        '    window.CM.desktop.version = info.version;'
        '  }'
        '  window.__CM_UPDATE_INFO__ = info.updateInfo || [];'
        '  window.dispatchEvent(new CustomEvent("__cmDesktopReady", { detail: info }));'
        '})();'
    )
