"""主入口：创建窗口、注入前端桌面外壳、保存后退出。"""

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import TYPE_CHECKING, Any

import webview

if __package__ in (None, ''):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from citymetro import paths, prefs, storage, window
from citymetro.about import APP_ID, APP_NAME, VERSION
from citymetro.bridge import ShellApi, bridge_script
from citymetro.single_instance import InstanceLock

if TYPE_CHECKING:
    from citymetro.window import AppWindow

WINDOW_TITLE = APP_NAME + ' v' + VERSION
ENGINE_TIMEOUT = 15
SAVE_TIMEOUT = 20
# 关窗前的存档等待上限：必须远小于 QUIT_FORCE_DELAY，否则时间全耗在等存档上，
# 窗口还没被销毁就被强制结束，用户看到的是「点了退出，卡几秒才没」
FLUSH_TIMEOUT = 4
QUIT_FORCE_DELAY = 12
APP_USER_MODEL_ID = 'CityAndMetro.' + APP_ID

# 与 index.html 的 theme-color 同色，避免载入瞬间闪白；深色值取自页面深色背景
BG_LIGHT = '#eaf1f7'
BG_DARK = '#14191f'

log = logging.getLogger('citymetro')

# 关窗要快，所以只等正在写的存档，不再催促自动保存：
# 月度结算（g.pending / g.jumping）期间 doAutosave 一律返回「正在结算」，催它只会白等满整个 SAVE_TIMEOUT。
# busy = 还有存档在写；clean = 不用等；dirty = 有未保存进度但这会儿存不了（结算中）。
WAIT_SAVED_JS = (
    ';(function(){try{'
    'var ui=window.CM&&window.CM.ui;if(!ui)return "clean";'
    'var g=ui.g();if(!g)return "clean";'
    'if(ui.saving||(ui._manualSaves&&ui._manualSaves.size))return "busy";'
    'if(window.CM.Save&&window.CM.Save.flushing&&window.CM.Save.flushing())return "busy";'
    'if(g.pending||g.jumping||(g.draft&&g.draft.liveSnap))return "dirty";'
    'return ui.isSaved()?"clean":"dirty";'
    '}catch(e){return "clean";}})();'
)

FLUSH_JS = (
    ';(function(){try{'
    'if(typeof window.__cmDesktopClose==="function"){window.__cmDesktopClose();return "flushed";}'
    'var ui=window.CM&&window.CM.ui;'
    'if(ui&&ui.g()&&!ui.isSaved()){ui.doAutosave(true);return "flushed";}'
    'return "clean";'
    '}catch(e){return "error";}})();'
)


def wait_for_engine(win):
    deadline = time.time() + ENGINE_TIMEOUT
    while time.time() < deadline:
        try:
            if win.evaluate_js('typeof window.CM === "object" && !!window.CM.ui') is True:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def flush_and_destroy(win):
    """先等正在写的存档落盘，再销毁窗口；销毁后窗口仍没退出就强制结束进程。"""
    # 存档等待与销毁共用这一个期限：evaluate_js 自己也可能卡住，不能只给等待存档计时。
    # 这个等待必须短于 force_exit_after 的兜底，否则时间全花在等存档上，窗口还没碰就被强杀。
    deadline = time.time() + min(SAVE_TIMEOUT, FLUSH_TIMEOUT)
    try:
        win.evaluate_js(FLUSH_JS)
    except Exception:
        log.debug('flush 脚本执行失败', exc_info=True)
    while time.time() < deadline:
        try:
            if win.evaluate_js(WAIT_SAVED_JS) != 'busy':
                break
        except Exception:
            log.debug('等待存档状态失败', exc_info=True)
            break
        time.sleep(0.1)
    else:
        log.warning('等待存档超时 %ss，仍然关闭', FLUSH_TIMEOUT)
    if win is None:
        os._exit(0)
    try:
        # 不能用 win.destroy()：它带 _shown_call，窗口没显示出来时会一直等 shown 事件；
        # destroy_now 直接调底层 destroy_window，关不掉时再按句柄兜底
        window.destroy_now(win)
    except Exception:
        log.debug('销毁窗口失败，交给强制退出', exc_info=True)
    # 关窗后 GUI 线程收尾还要一会儿；这里只是把兜底再往后推一点，别提前结束进程
    force_exit_after(QUIT_FORCE_DELAY)


# 关窗只有一条路径：主线程只做登记，存档等待与销毁都放在后台线程，
# 前端「退出」调用 quit_app 与点窗口关闭按钮都走这里，保证不会出现两次关闭或丢掉存档。
def request_quit(win, state):
    """登记退出并交给后台线程写盘关窗；主线程不直接碰窗口生命周期。"""
    if state['closing']:
        return
    state['closing'] = True
    # 兜底必须先设：写盘那一步会调 evaluate_js，它同步等 GUI 线程回调，
    # 窗口卡住时这次调用可能永远不返回，等它后面的 force_exit 就永远等不到
    force_exit_after(QUIT_FORCE_DELAY)
    # 关窗也不能等存档：evaluate_js 一旦挂起，负责关窗的线程就再也走不到 destroy。
    # 给它一个独立期限，到点不管存档写没写完都直接销毁窗口。
    guard = threading.Timer(min(SAVE_TIMEOUT, FLUSH_TIMEOUT) + 1,
                            lambda: window.destroy_now(win))
    guard.daemon = True
    guard.start()
    threading.Thread(target=lambda: flush_and_destroy(win), daemon=True).start()


def make_on_closing(win, state):
    def on_closing():
        request_quit(win, state)
        return False

    return on_closing


def watch_quit_request(win, api, state):
    """前端点「退出」时 api.quit_app 只登记请求，存档等待统一在这里做。"""
    while not api.close_requested.wait(0.2):
        pass
    request_quit(win, state)


# 兜底退出：pywebview 的 cocoa 后端先建窗口、再注入 window.pywebview.api 与 ready 事件，
# 启动早期（加载页、开始界面）点「退出」时 quit_app 常常还没暴露给网页，或 evaluate_js 直接失败。
# 写盘与销毁仍走上面那一条路径，那条路径走不通时不再依赖界面，直接结束进程。
def force_exit_after(seconds=QUIT_FORCE_DELAY):
    def run():
        log.warning('%ss 内窗口没有关掉，强制结束进程', seconds)
        os._exit(0)

    timer = threading.Timer(seconds, run)
    timer.daemon = True
    timer.start()
    return timer

def destroy_and_quit(win):
    """窗口没关掉（或窗口对象本身就不在了）时的兜底：能销毁就销毁，销毁完仍没退出就结束进程。"""
    if win is not None:
        window.destroy_now(win)
    force_exit_after(3)


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

        shell32 = ctypes.WinDLL('shell32', use_last_error=True)
        shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except (ImportError, AttributeError, OSError):
        log.debug('设置 AppUserModelID 失败', exc_info=True)


def clear_web_cache():
    """丢掉内核的磁盘缓存与 JS 字节码缓存：本地 file:// 资源不走 HTTP 缓存头，
    也不按文件时间失效，缓存里留着旧 js 的字节码，表现为改了前端却不生效。

    可清范围内一个目录都没找到也算失败：说明内核的数据目录不在预判位置（例如 macOS 上
    没走 .app 而是直接 python main.py，bundle id 是 Python 的），此时清不掉任何东西，
    不能让指纹写进去把它当成「已经清过」。下一次启动会按新位置再试。
    删不掉时说明还有内核进程占着这些文件，同样下次再试。"""
    found = 0
    ok = True
    for path in storage.web_cache_dirs():
        if not os.path.isdir(path):
            continue
        found += 1
        try:
            shutil.rmtree(path)
            log.info('已清理缓存 %s', path)
        except OSError:
            ok = False
            log.warning('清理缓存失败 %s（可能仍有内核进程占用）', path, exc_info=True)
    if not found:
        log.warning('未找到任何内核缓存目录，跳过；下次启动会重试')
        return False
    return ok


def refresh_cache_if_changed(src_dir):
    """按前端资源指纹决定要不要清缓存：只在代码确实变过时清，平时启动不受影响。
    清理没成功就不写指纹，下次启动会重试，不会把「没清成」当成「已经清过」。
    代价是清理始终失败时（缓存目录一直找不到）每次启动都会多走一遍指纹计算。"""
    try:
        stamp = storage.src_stamp(src_dir)
        path = storage.stamp_path()
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                old = fh.read().strip()
        except OSError:
            old = ''
        if old == stamp:
            return
        # 清缓存会重建 service worker、网络缓存与前端代码的 V8 字节码，启动会慢几秒：
        # 只在真的重建时记一条，日志里才看得出「这次是不是清过缓存」，便于把「存档读不到」和「刚清过缓存」对上时间
        log.info('前端代码已变化，重建内核缓存（存档在 saves 目录，不受影响）')
        if not clear_web_cache():
            return
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(stamp)
    except OSError:
        log.debug('检查前端更新失败', exc_info=True)


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
    if sys.platform == 'win32':
        set_app_user_model_id()
    else:
        window.set_macos_app_name(APP_NAME)
    lock = InstanceLock(os.path.join(storage.data_dir(), 'instance.lock'))
    if not lock.acquire():
        # 已有窗口在跑：激活它再静默退出，不再弹提示窗
        log.info('已有实例在运行，激活已有窗口')
        activate_existing()
        return 0

    # 必须在建窗口之前清：build_window() 一调用 create_window，WebView2 就已经开始读
    # index.html 与那几个 js 了，之后再删缓存目录只会和它抢文件；而且此时旧字节码可能已经编译完，
    # 清掉也不起作用。打包版同样要清，资源解包目录换了新内容时旧字节码一样会让改动不生效。
    refresh_cache_if_changed(paths.find_src_dir())

    try:
        app_window, state = build_window()
    except RuntimeError as exc:
        log.error('启动失败: %s', exc)
        lock.release()
        show_error(str(exc))
        return 2

    webview.start(
        private_mode=False,
        storage_path=storage.profile_dir(),
        debug=False,
        localization={'global.quitConfirmation': '确定要退出城市与地铁社区版吗？'},
        icon=window.window_icon(),
    )
    lock.release()
    log.info('正常退出')
    return 0


def build_window() -> 'tuple[AppWindow, dict[str, Any]]':
    src_dir = paths.find_src_dir()
    size, min_size = window.window_size()
    dark = window.dark_mode()
    window.apply_graphics_mode(prefs.gpu_enabled())
    log.info('启动 %s %s, src=%s, window=%dx%d, dark=%s',
             APP_ID, VERSION, src_dir, size[0], size[1], dark)

    api = ShellApi()
    api.on_quit = lambda: request_quit(app_window, state)
    app_window: AppWindow = webview.create_window(
        WINDOW_TITLE,
        url=os.path.join(src_dir, 'index.html'),
        js_api=api,
        width=size[0],
        height=size[1],
        min_size=min_size,
        text_select=True,
        confirm_close=False,
        background_color=BG_DARK if dark else BG_LIGHT,
    )
    api.bind(app_window)
    state: dict[str, Any] = {'closing': False, 'dark': dark, 'on_top': False}

    def on_loaded():
        apply_window_chrome(state)
        # __CM_DESKTOP__ 只能由这里注入：它是前端认「这是桌面版」的唯一依据，
        # 注入失败就别认，否则网页会走桌面分支却调不到任何一个桌面接口
        if not wait_for_engine(app_window):
            log.error('前端未在 %ss 内就绪', ENGINE_TIMEOUT)
            return
        try:
            app_window.evaluate_js(bridge_script())
        except Exception:
            log.error('注入桌面外壳信息失败', exc_info=True)
            return
        log.info('前端就绪, renderer=%s', webview.renderer)

    app_window.events.loaded += on_loaded
    app_window.events.closing += make_on_closing(app_window, state)
    threading.Thread(target=watch_quit_request, args=(app_window, api, state), daemon=True).start()
    return app_window, state


def apply_window_chrome(state):
    """窗口显示后再动原生窗口：标题栏主题要句柄，macOS 的 level 要等消息循环转起来。"""
    if sys.platform == 'darwin':
        window.set_macos_on_top(bool(state.get('on_top', False)))
        return
    hwnd = window.window_handle()
    if hwnd:
        window.apply_titlebar_theme(hwnd, bool(state.get('dark')))


def show_error(message):
    width = min(620, round(window.window_size()[0][0] * 0.5))
    webview.create_window(
        APP_NAME,
        html='<body style="font:16px/1.7 system-ui;padding:2.5rem;color:#243">'
        '<b>无法启动城市与地铁社区版</b><br>' + message + '</body>',
        width=width,
        height=240,
    )
    webview.start()


if __name__ == '__main__':
    sys.exit(main())
