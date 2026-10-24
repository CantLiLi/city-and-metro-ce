"""主入口：创建窗口、注入前端桌面外壳、保存后退出。"""

import logging
import os
import subprocess
import sys
import threading
import time

import webview

if __package__ in (None, ''):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from citymetro import paths, storage
from citymetro.about import APP_ID, APP_NAME, VERSION
from citymetro.bridge import ShellApi, bridge_script
from citymetro.single_instance import InstanceLock

WINDOW_TITLE = APP_NAME + ' v' + VERSION
WINDOW_SIZE = (1440, 900)
MIN_SIZE = (960, 640)
ENGINE_TIMEOUT = 15
SAVE_TIMEOUT = 20
APP_USER_MODEL_ID = 'CityAndMetro.' + APP_ID

log = logging.getLogger('citymetro')

# 窗口关闭：先让前端把未保存的进度落盘（__cmDesktopClose 返回 Promise），再销毁窗口
WAIT_SAVED_JS = (
    ';(function(){try{'
    'var ui=window.CM&&window.CM.ui;if(!ui)return "idle";'
    'if(!ui.g())return "idle";'
    'if(ui.saving||(ui._manualSaves&&ui._manualSaves.size))return "busy";'
    'return ui.isSaved()?"idle":"dirty";'
    '}catch(e){return "idle";}})();'
)

FLUSH_JS = (
    ';(function(){try{'
    'if(typeof window.__cmDesktopClose==="function"){window.__cmDesktopClose();return "flushed";}'
    'var ui=window.CM&&window.CM.ui;'
    'if(ui&&ui.g()&&!ui.isSaved()){ui.doAutosave(true);return "flushed";}'
    'return "clean";'
    '}catch(e){return "error";}})();'
)


def wait_for_engine(window):
    deadline = time.time() + ENGINE_TIMEOUT
    while time.time() < deadline:
        try:
            if window.evaluate_js('typeof window.CM === "object" && !!window.CM.ui') is True:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def flush_and_destroy(window):
    """先让前端把进度落盘，再销毁窗口。"""
    try:
        window.evaluate_js(FLUSH_JS)
    except Exception:
        log.debug('flush 脚本执行失败', exc_info=True)
    deadline = time.time() + SAVE_TIMEOUT
    while time.time() < deadline:
        try:
            if window.evaluate_js(WAIT_SAVED_JS) == 'idle':
                break
        except Exception:
            break
        time.sleep(0.2)
    else:
        log.warning('等待存档超时 %ss，仍然关闭', SAVE_TIMEOUT)
    try:
        window.destroy()
    except Exception:
        log.debug('destroy 失败', exc_info=True)


def make_on_closing(window, state):
    def on_closing():
        if state['closing']:
            return True
        state['closing'] = True
        threading.Thread(target=lambda: flush_and_destroy(window), daemon=True).start()
        return False

    return on_closing


def setup_logging():
    # pywebview 通过根日志器输出；它反射 WinForms 控件时的 COM 告警会刷屏且没有意义，只留我们自己模块的记录
    handler = logging.FileHandler(storage.log_path(), encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def set_app_user_model_id():
    """让任务栏/Alt+Tab 按本应用分组，而不是挂在 python.exe 上显示 Python 图标。"""
    if sys.platform != 'win32':
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except (ImportError, AttributeError, OSError):
        log.debug('设置 AppUserModelID 失败', exc_info=True)


def activate_existing():
    """把已经在跑的窗口提到前台；找不到进程就什么都不做。"""
    if sys.platform != 'win32':
        return False
    script = (
        '$w = Get-Process -ErrorAction SilentlyContinue | '
        'Where-Object { $_.MainWindowTitle -eq $args[0] } | Select-Object -First 1; '
        'if ($w) { '
        'Add-Type -AssemblyName Microsoft.VisualBasic; '
        '[Microsoft.VisualBasic.Interaction]::AppActivate($w.Id) | Out-Null }'
    )
    try:
        subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
             '-Command', script, WINDOW_TITLE],
            capture_output=True,
            timeout=5,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except (OSError, subprocess.SubprocessError):
        log.debug('激活已有窗口失败', exc_info=True)
        return False
    return True


def main():
    setup_logging()
    set_app_user_model_id()
    lock = InstanceLock(os.path.join(storage.data_dir(), 'instance.lock'))
    if not lock.acquire():
        # 已有窗口在跑：激活它再静默退出，不再弹提示窗
        log.info('已有实例在运行，激活已有窗口')
        activate_existing()
        return 0

    try:
        window, state = build_window()
    except RuntimeError as exc:
        log.exception('启动失败: %s', exc)
        lock.release()
        show_error(str(exc))
        return 2

    webview.start(
        private_mode=False,
        storage_path=storage.profile_dir(),
        debug=bool(os.environ.get('CM_DEBUG')),
        localization={'global.quitConfirmation': '确定要退出城市与地铁吗？'},
        icon=window_icon(),
    )
    lock.release()
    log.info('正常退出')
    return 0


def window_icon():
    """Windows 的 WinForms Icon 只认 .ico；macOS 用 NSImage 直接解码 PNG 更稳，且 384px 够 Retina。"""
    name = 'favicon.ico' if sys.platform == 'win32' else 'logo-navy.png'
    path = os.path.join(paths.image_dir(), name)
    return path if os.path.isfile(path) else None


def build_window():
    src_dir = paths.find_src_dir()
    log.info('启动 %s %s, src=%s', APP_ID, VERSION, src_dir)
    api = ShellApi()
    window = webview.create_window(
        WINDOW_TITLE,
        url=os.path.join(src_dir, 'index.html'),
        js_api=api,
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=MIN_SIZE,
        text_select=True,
        confirm_close=False,
        background_color='#eaf1f7',
    )
    api.bind(window)
    state = {'closing': False}

    def on_loaded():
        if not wait_for_engine(window):
            log.error('前端未在 %ss 内就绪', ENGINE_TIMEOUT)
            return
        try:
            window.evaluate_js(bridge_script())
        except Exception:
            log.exception('注入桌面外壳信息失败')
        log.info('前端就绪, renderer=%s', webview.renderer)

    window.events.loaded += on_loaded
    window.events.closing += make_on_closing(window, state)
    return window, state


def show_error(message):
    webview.create_window(
        APP_NAME,
        html='<body style="font:16px/1.7 system-ui;padding:2.5rem;color:#243">'
        '<b>无法启动城市与地铁</b><br>' + message + '</body>',
        width=620,
        height=240,
    )
    webview.start()


if __name__ == '__main__':
    sys.exit(main())
