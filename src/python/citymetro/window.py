"""桌面窗口的尺寸与平台特效。

窗口大小按实际屏幕来：先取屏幕的可用区域（扣掉菜单栏和 Dock / 任务栏），
再把设计分辨率按屏幕的实际长宽比等比缩放进去，不留黑边也不写死 1440×900。
"""

import ctypes
import logging
import os
import sys
import threading
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import webview

    AppWindow = webview.Window

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

    user32 = ctypes.WinDLL('user32', use_last_error=True)
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


def destroy_now(win):
    """销毁窗口。

    Window.destroy 带 _shown_call 装饰，它会把 destroyed 事件提前置为已触发，所以再去等窗口关闭就等不到了；
    退出线程要等的是窗口真的关掉，这里直接调底层 destroy_window。

    底层 destroy_window 是同步的：它要 Invoke 到 GUI 线程执行 Close()，而 Close() 会触发
    on_closing / on_close 事件回调——回调若跑在调用方线程，就和这次的 Invoke 互相等待，两边都卡死，
    窗口永远不关。所以关窗前先把 pywebview 自己那几个事件的回调线程锁摘掉，让回调在 GUI 线程里跑完。
    """
    if win is None:
        return
    _unlock_events(win)
    try:
        import webview.guilib as guilib

        guilib.initialize(guilib.forced_gui_)
        hwnd = window_handle()
        guilib.guilib.destroy_window(win.uid)
        wait_gone(hwnd, 2)
    except Exception:
        log.debug('底层销毁窗口失败，退回 window.destroy', exc_info=True)
        try:
            win.destroy()
        except Exception:
            log.debug('销毁窗口失败', exc_info=True)
    _kill_window(win)


def _unlock_events(win):
    events = getattr(win, 'events', None)
    if events is None:
        return
    for name in dir(events):
        if name.startswith('_'):
            continue
        try:
            setattr(getattr(events, name), '_should_lock', False)
        except Exception:
            pass


def _kill_window(win):
    """兜底：按句柄结束本进程的可见窗口。

    destroy_window 走不通（窗口对象已不在表里、GUI 线程已经退出）时，窗口还留在屏幕上；
    这时直接结束它，比让用户对着关不掉的白窗口等十几秒强。
    """
    if win is None or sys.platform != 'win32':
        return
    hwnd = window_handle()
    if not hwnd:
        return
    try:
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        WM_CLOSE = 0x0010
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        if not wait_gone(hwnd, 1.5):
            user32.SendMessageW(hwnd, WM_CLOSE, 0, 0)
        if not wait_gone(hwnd, 0.5):
            user32.DestroyWindow(hwnd)
    except Exception:
        log.debug('结束窗口失败', exc_info=True)


def wait_gone(hwnd, seconds):
    """等窗口句柄消失；句柄为 0（非 Windows 或本来就没有窗口）当作已关掉。"""
    if not hwnd:
        return True
    if sys.platform != 'win32':
        return True
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not user32.IsWindow(hwnd):
            return True
        time.sleep(0.05)
    return False


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

    user32 = ctypes.WinDLL('user32', use_last_error=True)
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
    ctypes.WinDLL('dwmapi', use_last_error=True).DwmSetWindowAttribute(
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


def _macos_parent_window():
    """挂面板的父窗口：本进程的 pywebview 窗口。

    不能用 NSApp.windows() 里的 keyWindow / mainWindow：点按钮的时候焦点常常还在菜单栏
    （启动器、Dock、系统通知），那两个都可能是空的，面板就成了没有父窗口的独立面板。
    """
    try:
        import webview

        owners = [w for w in (getattr(webview, 'windows', None) or []) if w.native is not None]
    except Exception:
        log.debug('取窗口列表失败', exc_info=True)
        return None
    for win in owners:
        if win.uid == 'master':
            return win.native
    return owners[0].native if owners else None


# 面板请求排队：runModal 会泵事件循环，工作线程等 runModal 返回，主线程上跑的是排队的另一个请求
_panel_lock = threading.Lock()
_panel_queue = []
_panel_pump_scheduled = False


def _macos_pump_panels():
    """AppKit 主线程上的面板泵：一次只开一个 runModal，排队进来的请求依次处理。

    之前是在工作线程上 callAfter 把 _show 排进主线程，再让工作线程空转等结果：
    主线程一旦正卡在另一个模态面板里（runModal 会泵事件循环，callAfter 要等它退出才被调用），
    那个 _show 就永远轮不到，用户看到的就是「点了没反应」。
    """
    global _panel_pump_scheduled
    with _panel_lock:
        _panel_pump_scheduled = False
    while True:
        with _panel_lock:
            if not _panel_queue:
                return
            request = _panel_queue.pop(0)
        try:
            request['result'] = _macos_run_panel(request['dialog_type'], request['title'], request['extensions'])
        except Exception as exc:
            log.warning('macOS 文件面板失败: %s', exc, exc_info=True)
            request['error'] = exc
        finally:
            request['event'].set()


def _run_modal_for_window(panel, parent):
    """以 sheet 形式把面板挂在父窗口上跑，返回 NSModalResponse。

    曾报「NSKVONotifying_NSOpenPanel object has no attribute 'runModalForWindow_'」：
    NSSavePanel/NSOpenPanel 是单例，AppKit 用过后会 KVO 换壳，PyObjC 在壳上找不到
    父类方法。这里从父窗口（也是 NSWindow 子类，方法一模一样）上取未绑定实现，
    用 panel 当 self 调用；取不到就直接开独立面板，别让「读取存档」整个失败。
    """
    try:
        method = type(parent).runModalForWindow_
        if callable(method):
            return method(panel, parent)
    except Exception:
        log.debug('借用窗口的 runModalForWindow: 失败，改用独立面板', exc_info=True)
    return panel.runModal()


def _macos_run_panel(dialog_type, title, extensions):
    from AppKit import NSApp, NSOpenPanel, NSSavePanel, NSApplicationActivationPolicyRegular

    parent = _macos_parent_window()
    if NSApp.activationPolicy() != NSApplicationActivationPolicyRegular:
        # 从命令行起的 python 不是常规应用：窗口没有激活权限，面板会开在别的应用后面
        NSApp.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    # 不激活的话面板会开在别的应用下面，看上去就是「点了没反应」
    NSApp.activateIgnoringOtherApps_(True)
    if parent is not None:
        # 窗口也要提到最前：面板挂在它上面，窗口在别的应用后面时面板一样看不到
        parent.makeKeyAndOrderFront_(None)

    if dialog_type == 'save':
        panel = NSSavePanel.savePanel()
        panel.setNameFieldStringValue_(title)
    else:
        panel = NSOpenPanel.openPanel()
        panel.setCanChooseFiles_(True)
        panel.setCanChooseDirectories_(False)
        panel.setAllowsMultipleSelection_(False)
    if extensions:
        # 用 UTType 而不是只认扩展名的 setAllowedFileTypes_：后者会把「所有文件」变成什么都选不了
        try:
            from UniformTypeIdentifiers import UTType

            types = []
            for ext in extensions:
                ut = UTType.typeWithFilenameExtension_(ext)
                if ut is not None:
                    types.append(ut)
            if types:
                panel.setAllowedContentTypes_(types)
        except Exception:
            panel.setAllowedFileTypes_(list(extensions))

    # 挂在窗口上（sheet）最贴合 macOS 习惯；取不到父窗口就开独立面板，两种情况都只处理这一个请求
    if parent is not None:
        code = _run_modal_for_window(panel, parent)
    else:
        code = panel.runModal()
    if code != 1:
        return None
    # savePanel 与 openPanel 都有 filename()，用 URL 更稳（沙箱下 filename 偶尔为空串）
    url = panel.URL()
    if url is not None:
        path = url.path()
        return str(path) if path else None
    path = panel.filename()
    return str(path) if path else None


def macos_file_panel(dialog_type, title, extensions):
    """macOS 的文件选择面板。

    在主线程上开着时直接开；在工作线程上（JS 调用一定在工作线程）就排进主线程的队列，
    由主线程的分发器逐个跑 runModal —— 主线程只负责跑面板，不会自己阻塞等结果。
    """
    if threading.current_thread() is threading.main_thread():
        # 主线程自己开：runModal 在这一点上就把本次面板跑完
        return _macos_run_panel(dialog_type, title, extensions)

    from PyObjCTools import AppHelper

    global _panel_pump_scheduled
    request = {'dialog_type': dialog_type, 'title': title, 'extensions': list(extensions),
               'event': threading.Event(), 'result': None, 'error': None}
    # 先排分发器再入队：反过来的话另一个线程可能刚入队就看到还没排分发器，于是再排一个
    with _panel_lock:
        schedule = not _panel_pump_scheduled
        if schedule:
            _panel_pump_scheduled = True
        _panel_queue.append(request)
    if schedule:
        AppHelper.callAfter(_macos_pump_panels)
    request['event'].wait()
    if request['error'] is not None:
        raise request['error']
    return request['result']


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


def _win32_set_attr(hwnd, attribute, value):
    data = ctypes.c_int(value)
    try:
        ctypes.WinDLL('dwmapi', use_last_error=True).DwmSetWindowAttribute(
            hwnd, attribute, ctypes.byref(data), ctypes.sizeof(data)
        )
    except Exception:
        log.debug('设置窗口属性 %s 失败', attribute, exc_info=True)


def _win32_fill_screen(hwnd):
    """把窗口铺到所在显示器的物理边界外 1px，盖住全屏时最外圈的白线。

    pywebview 进全屏时用 Screen.Bounds（逻辑像素）定位，再关掉圆角与边框；
    DWM 收起边框后剩下的 1px 接缝会露出 WinForms 窗体底色。窗口尺寸和位置都
    改成物理像素并各边多出 1px 后，接缝落在屏幕外，肉眼就看不到了。
    """
    if sys.platform != 'win32' or not hwnd:
        return
    try:
        import ctypes.wintypes

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        MONITOR_DEFAULTTONEAREST = 2
        monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        if not monitor:
            return

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ('cbSize', ctypes.wintypes.DWORD),
                ('rcMonitor', ctypes.wintypes.RECT),
                ('rcWork', ctypes.wintypes.RECT),
                ('dwFlags', ctypes.wintypes.DWORD),
            ]

        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return
        mon = info.rcMonitor
        x, y = mon.left - 1, mon.top - 1
        w, h = mon.right - mon.left + 2, mon.bottom - mon.top + 2
        SWP_NOZORDER, SWP_NOACTIVATE, SWP_FRAMECHANGED = 0x0004, 0x0010, 0x0020
        user32.SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
        # 圆角与边框色只在无边框全屏时才有意义
        _win32_set_attr(hwnd, 33, 1)
        _win32_set_attr(hwnd, 34, 0xFFFFFFFE)
    except Exception:
        log.debug('铺满显示器失败', exc_info=True)


def _set_fullscreen(win: 'AppWindow', on: bool) -> bool:
    if bool(_window_mode['mode'] != 'window') == on:
        return False
    win.toggle_fullscreen()
    if sys.platform == 'win32':
        hwnd = window_handle()
        if hwnd:
            if on:
                _win32_fill_screen(hwnd)
            else:
                _win32_set_attr(hwnd, 33, 0)
                _win32_set_attr(hwnd, 34, 0xFFFFFFFF)
    return True


def set_window_mode(win: 'AppWindow | None', mode: Any) -> dict[str, Any]:
    """切换窗口方式。mode: window 普通窗口 | max 窗口化全屏。

    已经是目标方式时直接返回成功：前端启动时会同步一次（设置里的值），
    这时窗口本来就是普通窗口，再去动它只会白白引入失败。
    """
    mode = str(mode or 'window')
    if mode not in ('window', 'max'):
        return {'ok': False, 'error': '未知的窗口方式'}
    if _window_mode['mode'] == mode:
        return {'ok': True, 'mode': mode, 'changed': False}
    if win is None:
        return {'ok': False, 'error': '窗口未就绪'}
    try:
        # _set_fullscreen 返回 False 说明窗口本来就已经是目标方式，状态以它为准
        changed = _set_fullscreen(win, mode != 'window')
    except Exception as exc:
        log.warning('切换窗口方式失败: %s', exc, exc_info=True)
        return {'ok': False, 'error': str(exc)}
    _window_mode['mode'] = mode
    return {'ok': True, 'mode': mode, 'changed': changed}
