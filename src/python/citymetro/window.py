"""桌面窗口的尺寸与平台特效。

窗口大小按实际屏幕来：先取屏幕的可用区域（扣掉菜单栏和 Dock / 任务栏），
再把设计分辨率按屏幕的实际长宽比等比缩放进去，不留黑边也不写死 1440×900。
"""

import ctypes
import logging
import os
import sys

log = logging.getLogger('citymetro')

# 窗口占屏幕可用区域的比例：左右各留 (1-75%)/2，上下多留是因为 Dock 和标题栏都在高度上
SIDE_FILL = 0.75
VERTICAL_FILL = 0.85
# 最小尺寸最多占到可用区域的比例，macOS 的菜单栏 / Dock 再厚也不会顶出去
SCREEN_FILL = 0.92
DESIGN_SIZE = (1440, 900)
MIN_WINDOW_SIZE = (960, 640)

DARK_BG = 0x0020201C
LIGHT_BG = 0x00F7F1EA


def _main_screen():
    """主显示器：带菜单栏 / 任务栏的那块，取不到就用第一块。"""
    import webview

    screens = webview.screens()
    if not screens:
        return None
    for screen in screens:
        origin = getattr(screen, 'frame', None)
        if origin is not None and getattr(origin, 'origin', None) is not None:
            if origin.origin.x == 0 and origin.origin.y == 0:
                return screen
    return screens[0]


def _work_area(frame):
    """屏幕比可用区域多吃掉的 (宽, 高)：macOS 是菜单栏和 Dock，Windows 是任务栏，取不到按 0 算。"""
    total_w = int(getattr(frame, 'width', 0) or 0)
    total_h = int(getattr(frame, 'height', 0) or 0)
    work = getattr(frame, 'work_area', None)
    if work is None:
        return 0, 0
    taken_w = total_w - int(getattr(work, 'width', 0) or 0)
    taken_h = total_h - int(getattr(work, 'height', 0) or 0)
    return max(0, taken_w), max(0, taken_h)


def _windows_frame():
    """标题栏加边框占掉多少逻辑像素 (宽, 高)，SPI 拿到的已经是逻辑像素，不用自己乘缩放比。"""
    import ctypes.wintypes

    user32 = ctypes.windll.user32
    user32.AdjustWindowRectEx.argtypes = [
        ctypes.POINTER(ctypes.wintypes.RECT),
        ctypes.wintypes.DWORD,
        ctypes.wintypes.BOOL,
        ctypes.wintypes.DWORD,
    ]
    # WS_OVERLAPPEDWINDOW 带 WS_MAXIMIZEBOX，不带的话标题栏会被多算一次
    frame = ctypes.wintypes.RECT(0, 0, 100, 100)
    user32.AdjustWindowRectEx(ctypes.byref(frame), 0x00CF0000, False, 0x00040000)
    return max(0, frame.right - frame.left - 100), max(0, frame.bottom - frame.top - 100)


def destroy_now(window):
    """销毁窗口。

    Window.destroy 带 _shown_call 装饰，它会把 destroyed 事件提前置为已触发，所以再去等窗口关闭就等不到了；
    退出线程要等的是窗口真的关掉，这里直接调底层 destroy_window。
    """
    if window is None:
        return
    try:
        import webview.guilib as guilib

        guilib.initialize(guilib.forced_gui_)
        guilib.guilib.destroy_window(window.uid)
    except Exception:
        log.debug('底层销毁窗口失败，退回 window.destroy', exc_info=True)
        try:
            window.destroy()
        except Exception:
            log.debug('销毁窗口失败', exc_info=True)


def window_size():
    """按当前屏幕可用区域算出窗口大小与最小尺寸（pywebview 的逻辑像素，WinForms 自己按 DPI 换算）。"""
    try:
        frame = getattr(_main_screen(), 'frame', None)
    except Exception:
        log.debug('读取屏幕信息失败，使用设计尺寸', exc_info=True)
        frame = None
    width = int(getattr(frame, 'width', 0) or 0)
    height = int(getattr(frame, 'height', 0) or 0)
    if width <= 0 or height <= 0:
        return DESIGN_SIZE, MIN_WINDOW_SIZE

    # 先用系统给的可用区域，取不到就退回整屏再扣掉标题栏
    taken_w, taken_h = _work_area(frame)
    if taken_w == 0 and taken_h == 0 and sys.platform == 'win32':
        try:
            taken_w, taken_h = _windows_frame()
        except Exception:
            log.debug('读取窗口边框尺寸失败', exc_info=True)
    # 窗口占可用区域 75% × 85%，上下多留的原因是 macOS 的 Dock 和标题栏都在高度上
    usable_w = width * SIDE_FILL - taken_w
    usable_h = height * VERTICAL_FILL - taken_h
    # 可用区域小得连设计尺寸的四成都放不下，老老实实按设计尺寸来
    if usable_w < DESIGN_SIZE[0] * 0.4 or usable_h < DESIGN_SIZE[1] * 0.3:
        return DESIGN_SIZE, MIN_WINDOW_SIZE

    # 保持设计比例落进可用区域：屏幕比 16:10 宽就按宽度对齐，比它窄就按高度对齐
    scale = max(0.5, min(usable_w / DESIGN_SIZE[0], usable_h / DESIGN_SIZE[1]))
    size = (round(DESIGN_SIZE[0] * scale), round(DESIGN_SIZE[1] * scale))
    # 最小尺寸不能超过屏幕可拖动区域，否则窗口一旦缩小就再也拉不回来
    min_size = (
        min(MIN_WINDOW_SIZE[0], round(width * SCREEN_FILL) - taken_w),
        min(MIN_WINDOW_SIZE[1], round(height * SCREEN_FILL) - taken_h),
    )
    return size, min_size


def window_icon():
    """Windows 的 WinForms Icon 只认 .ico；macOS 用 PNG（NSImage 直接解码，1024px 够 Retina）。"""
    from citymetro import paths

    name = 'favicon.ico' if sys.platform == 'win32' else 'icon.png'
    path = os.path.join(paths.image_dir(), name)
    return path if os.path.isfile(path) else None


def dark_mode():
    """系统当前是不是深色外观；判断不出来就当浅色。"""
    try:
        if sys.platform == 'win32':
            return _windows_dark_mode()
        if sys.platform == 'darwin':
            return _macos_dark_mode()
    except Exception:
        log.debug('读取系统外观失败', exc_info=True)
    return False


def _windows_dark_mode():
    import winreg

    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize',
    ) as key:
        value, _ = winreg.QueryValueEx(key, 'AppsUseLightTheme')
    return value == 0


def _macos_dark_mode():
    from Foundation import NSUserDefaults

    value = NSUserDefaults.standardUserDefaults().stringForKey_('AppleInterfaceStyle')
    return str(value or '').lower() == 'dark'


def window_handle():
    """本进程面积最大的可见顶层窗口；非 Windows 或取不到时返回 0。"""
    if sys.platform != 'win32':
        return 0
    import ctypes.wintypes

    user32 = ctypes.windll.user32
    pid = os.getpid()
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def collect(hwnd, _):
        owner = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            rect = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            area = (rect.right - rect.left) * (rect.bottom - rect.top)
            if area > 400 * 400:
                found.append((area, hwnd))
        return True

    try:
        user32.EnumWindows(collect, None)
    except Exception:
        log.debug('枚举窗口失败', exc_info=True)
        return 0
    return max(found)[1] if found else 0


def _set_attribute(hwnd, attribute, value):
    data = value if isinstance(value, ctypes.Structure) else ctypes.c_int(value)
    ctypes.windll.dwmapi.DwmSetWindowAttribute(
        hwnd, attribute, ctypes.byref(data), ctypes.sizeof(data)
    )


def _colorref(argb):
    class COLORREF(ctypes.Structure):
        _fields_ = [('value', ctypes.c_uint)]

    return COLORREF(argb)


def apply_titlebar_theme(hwnd, dark):
    """让标题栏跟着游戏主题，而不是跟着系统外观走。"""
    if sys.platform != 'win32' or not hwnd:
        return
    color = DARK_BG if dark else LIGHT_BG
    try:
        _set_attribute(hwnd, 20, 1 if dark else 0)
        if sys.getwindowsversion().build >= 22000:
            _set_attribute(hwnd, 34, _colorref(color))
        else:
            _set_attribute(hwnd, 35, _colorref(color))
    except Exception:
        log.debug('设置标题栏主题失败', exc_info=True)


def apply_graphics_mode(gpu):
    """把「GPU 加速」翻译成 WebView2 内核参数。

    WebView2 的浏览器参数只能在创建环境之前给，所以这项改动下次启动才生效。
    pywebview 自己会传 ElasticOverscroll 和文件访问两项，这里一并带上：环境变量与
    代码里的 AdditionalBrowserArguments 谁生效都不会丢功能。
    """
    if sys.platform != 'win32':
        return
    args = ['--disable-features=ElasticOverscroll', '--allow-file-access-from-files']
    if gpu:
        # 混合显卡机器上让内核优先要独立显卡；不支持的版本会直接忽略这个开关
        args.append('--force_high_performance_gpu')
    else:
        args.append('--disable-gpu')
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = ' '.join(args)
    log.info('显卡模式: %s', 'GPU' if gpu else 'CPU')


def set_macos_on_top(on):
    """macOS 上改窗口置顶：pywebview 的 Cocoa 后端没有 on_top，只能直接改 NSWindow 的 level。

    用类上的未绑定方法调用：PyObjC 把实例的 setLevel_ 缓存成 objc_selector，那个不可调用。
    """
    try:
        from AppKit import NSApp, NSFloatingWindowLevel, NSNormalWindowLevel
        from PyObjCTools import AppHelper
    except Exception:
        log.debug('导入 AppKit 失败', exc_info=True)
        return

    window = NSApp.mainWindow() or next(iter(list(NSApp.windows() or [])), None)
    if window is None:
        return
    set_level = type(window).setLevel_
    if not callable(set_level):
        set_level = getattr(set_level, '__func__', None)
    if not callable(set_level):
        return
    level = NSFloatingWindowLevel if on else NSNormalWindowLevel
    # setLevel: 只能碰主线程，而调用点常常在别的工作线程上
    AppHelper.callAfter(lambda: set_level(window, level))


def _objc_sel(obj, name):
    # PyObjC 的临时对象要显式查一下有没有这个方法，直接 getattr 在部分对象上会抛异常
    if not obj.respondsToSelector_ or not obj.respondsToSelector_(name):
        return None
    return getattr(obj, name, None)


def macos_web_process_pids():
    """本窗口 WKWebView 的内容进程（pid）：网页的 JS 堆、解码后的图片与图层都在这里。

    这类进程由 launchd 拉起，不在 python 的子进程里，只能从 WKWebView 的私有
    _webProcessProxy 问出来；问不到就返回空列表，调用处不计网页进程。
    """
    if sys.platform != 'darwin':
        return []
    try:
        import webview

        owners = list(getattr(webview, 'windows', None) or [])
    except Exception:
        log.debug('取窗口列表失败', exc_info=True)
        return []
    pids = []
    for win in owners:
        view = getattr(win, 'webview', None)
        if view is None:
            continue
        proxy_sel = _objc_sel(view, '_webProcessProxy')
        proxy = proxy_sel() if proxy_sel else None
        if proxy is None:
            continue
        pid_sel = _objc_sel(proxy, 'processIdentifier')
        pid = pid_sel() if pid_sel else None
        try:
            pid = int(pid) if pid is not None else 0
        except (TypeError, ValueError):
            pid = 0
        if pid > 0:
            pids.append(pid)
    return pids


def set_macos_app_name(name):
    """终止进程名还是「Python」，不改成 CFBundleName 的话，程序坞标签和菜单栏都会写 Python。

    NSProcessInfo 的 processName 默认取 argv[0]，setter 能直接覆盖这个显示名。
    """
    try:
        from Foundation import NSProcessInfo

        NSProcessInfo.processInfo().setProcessName_(name)
    except Exception:
        log.debug('设置进程显示名失败', exc_info=True)


# ---------------- 窗口方式：普通窗口 / 窗口化全屏 ----------------
# 必须走 pywebview 自己的窗口接口：它的 winforms / cocoa 后端会把这些调用切回界面线程
# （Control.Invoke / AppHelper.callAfter）。改成从网页的 JS 线程直接动原生窗口的话，
# 窗口状态随后会被界面线程按它自己的记录改回去，界面上看着就是「按了没反应」。

_window_mode = {'mode': 'window'}


def _set_fullscreen(win, on):
    if bool(_window_mode['mode'] != 'window') == on:
        return
    win.toggle_fullscreen()


def set_window_mode(win, mode):
    """切换窗口方式。mode: window 普通窗口 | max 窗口化全屏。"""
    mode = str(mode or 'window')
    if mode not in ('window', 'max'):
        return {'ok': False, 'error': '未知的窗口方式'}
    if win is None:
        return {'ok': False, 'error': '窗口未就绪'}
    try:
        _set_fullscreen(win, mode != 'window')
        if mode == 'window':
            win.restore()
    except Exception as exc:
        log.warning('切换窗口方式失败: %s', exc, exc_info=True)
        return {'ok': False, 'error': str(exc)}
    _window_mode['mode'] = mode
    return {'ok': True, 'mode': mode}
