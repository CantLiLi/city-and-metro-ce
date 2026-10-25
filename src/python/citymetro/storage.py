"""桌面外壳的数据目录。"""

import hashlib
import os
import sys

APP_DIR_NAME = 'CityAndMetro'
# 与 build.py 的 BUNDLE_ID 一致；macOS 的 WKWebView 数据目录按它命名。
# 没走 .app 启动（直接跑 python main.py）时落在 python 的 bundle id 下，此时清不到，属预期。
WEBKIT_BUNDLE_ID = 'com.cityandmetro.ce'


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
    """页面数据的配置目录：设置与页面存储在这里，必须跨启动保留。

    Windows 上是 webview.start(storage_path=...) 用的 WebView2 用户目录；
    macOS 的 Cocoa 后端不认 storage_path（见 web_cache_dirs 的说明），WKWebView 用的是
    这个数据目录下的 WebKit 子目录。
    """
    path = os.path.join(data_dir(), 'profile')
    os.makedirs(path, exist_ok=True)
    return path


def _webkit_default_dir():
    """WKWebsiteDataStore.defaultDataStore() 在磁盘上的落点。

    pywebview 的 Cocoa 后端忽略 storage_path，一律用 defaultDataStore()，它按 bundle id
    落在 ~/Library/WebKit/<bundle id>/WebsiteData/Default。
    """
    return os.path.join(
        os.path.expanduser('~'), 'Library', 'WebKit', WEBKIT_BUNDLE_ID, 'WebsiteData', 'Default')


def web_cache_dirs():
    """可以随时丢弃的缓存目录：磁盘缓存与 JS 字节码缓存，按平台返回。

    File 协议的资源不走 HTTP 缓存头，也不按修改时间失效，改了 js 还会用旧的字节码，
    所以这几处整目录清掉最稳；IndexedDB / Local Storage 不在其中，清缓存不影响存档。
    """
    if sys.platform == 'darwin':
        # WKWebView 的 network cache / GPU 进程缓存 / code cache 都是独立目录，
        # WebKit 自己按修改时间管；同 Windows 一样整目录清。
        data = _webkit_default_dir()
        return [
            os.path.join(data, 'NetworkCache', 'WebKitCache'),
            os.path.join(data, 'WebKitCache'),
            os.path.join(data, 'CacheStorage'),
        ]
    base = os.path.join(profile_dir(), 'EBWebView', 'Default')
    return [
        os.path.join(base, 'Cache'),
        os.path.join(base, 'Code Cache'),
        os.path.join(base, 'GPUCache'),
        os.path.join(base, 'DawnCache'),
        os.path.join(base, 'DawnWebGPUCache'),
        os.path.join(base, 'Service Worker'),
    ]


def stamp_path():
    return os.path.join(cache_dir(), 'src.stamp')


def src_stamp(src_dir):
    """前端资源的指纹：文件名 + 大小 + 修改时间。变了说明代码更新过。"""
    h = hashlib.sha1()
    for root, _dirs, files in os.walk(src_dir):
        for name in sorted(files):
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            h.update(os.path.relpath(path, src_dir).replace('\\', '/').encode('utf-8'))
            h.update(b'|%d|%d\n' % (st.st_size, int(st.st_mtime)))
    return h.hexdigest()


def log_path():
    return os.path.join(data_dir(), 'shell.log')


def cache_dir():
    """渲染派生数据的缓存目录：可随时删除重建，与存档无关。"""
    path = os.path.join(data_dir(), 'cache')
    os.makedirs(path, exist_ok=True)
    return path
