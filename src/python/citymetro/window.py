"""桌面窗口的尺寸与平台特效。

窗口大小按实际屏幕来：设计分辨率只在屏幕上放不下时才用来兜底缩放，
不再写死 1440×900。
"""

import ctypes
import logging
import os
import sys

log = logging.getLogger('citymetro')

# 窗口四周留出的桌面空白比例，以及窗口最小尺寸相对屏幕的上限
SCREEN_MARGIN = 0.06
MAX_SCREEN_RATIO = 0.9
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


def window_size():
    """按当前屏幕算出窗口大小与最小尺寸（pywebview 的逻辑像素，WinForms 自己按 DPI 换算）。"""
    try:
        screen = _main_screen()
    except Exception:
        log.debug('读取屏幕信息失败，使用设计尺寸', exc_info=True)
        screen = None
    if screen is None:
        return DESIGN_SIZE, MIN_WINDOW_SIZE

    width, height = int(screen.width), int(screen.height)
    usable_w = round(width * (1 - SCREEN_MARGIN * 2))
    usable_h = round(height * (1 - SCREEN_MARGIN * 2))
    # 设计比例放得下就按屏幕铺开，放不下才整体等比缩小
    fit = min(usable_w / DESIGN_SIZE[0], usable_h / DESIGN_SIZE[1], 1.0)
    size = (round(DESIGN_SIZE[0] * fit), round(DESIGN_SIZE[1] * fit))
    # 最小尺寸不能超过屏幕本身，否则窗口一旦缩小就再也拉不回来
    min_size = (
        min(MIN_WINDOW_SIZE[0], round(width * MAX_SCREEN_RATIO)),
        min(MIN_WINDOW_SIZE[1], round(height * MAX_SCREEN_RATIO)),
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


def set_macos_app_name(name):
    """终止进程名还是「Python」，不改成 CFBundleName 的话，程序坞标签和菜单栏都会写 Python。

    NSProcessInfo 的 processName 默认取 argv[0]，setter 能直接覆盖这个显示名。
    """
    try:
        from Foundation import NSProcessInfo

        NSProcessInfo.processInfo().setProcessName_(name)
    except Exception:
        log.debug('设置进程显示名失败', exc_info=True)
