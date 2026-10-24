"""运行监控数据：本软件整棵进程树的 CPU、内存占用，以及显卡引擎占用。

WebView2 的浏览器、渲染、显卡进程都是 python.exe 的子进程，所以要按父进程关系把整棵树累加；
逐进程的显卡占用只有系统性能计数器（PDH 的 GPU Engine 实例）能读到。
"""

import ctypes
import logging
import os
import sys
import threading
import time
from ctypes import wintypes as wt

log = logging.getLogger('citymetro')

WIN = sys.platform == 'win32'
TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_VM_READ = 0x0010
PDH_FMT_DOUBLE = 0x00000200
PDH_MORE_DATA = 0x800007D2
GPU_COUNTER = r'\GPU Engine(*)\Utilization Percentage'


class _ProcEntry(ctypes.Structure):
    _fields_ = [
        ('dwSize', wt.DWORD),
        ('cntUsage', wt.DWORD),
        ('th32ProcessID', wt.DWORD),
        ('th32DefaultHeapID', ctypes.c_size_t),
        ('th32ModuleID', wt.DWORD),
        ('cntThreads', wt.DWORD),
        ('th32ParentProcessID', wt.DWORD),
        ('pcPriClassBase', ctypes.c_long),
        ('dwFlags', wt.DWORD),
        ('szExeFile', ctypes.c_wchar * 260),
    ]


class _MemCounters(ctypes.Structure):
    _fields_ = [
        ('cb', wt.DWORD),
        ('PageFaultCount', wt.DWORD),
        ('PeakWorkingSetSize', ctypes.c_size_t),
        ('WorkingSetSize', ctypes.c_size_t),
        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
        ('PagefileUsage', ctypes.c_size_t),
        ('PeakPagefileUsage', ctypes.c_size_t),
    ]


class _PdhValue(ctypes.Structure):
    _fields_ = [('CStatus', wt.DWORD), ('doubleValue', ctypes.c_double)]


class _PdhItem(ctypes.Structure):
    _fields_ = [('szName', wt.LPWSTR), ('FmtValue', _PdhValue)]


_NATIVE = None


def _api():
    """按需加载 kernel32 / psapi / pdh；64 位下句柄必须声明成 HANDLE 才不会被截断。"""
    global _NATIVE
    if _NATIVE is not None:
        return _NATIVE
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    pdh = ctypes.WinDLL('pdh', use_last_error=True)
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(_ProcEntry)]
    k32.Process32FirstW.restype = wt.BOOL
    k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(_ProcEntry)]
    k32.Process32NextW.restype = wt.BOOL
    k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k32.OpenProcess.restype = wt.HANDLE
    k32.CloseHandle.argtypes = [wt.HANDLE]
    k32.GetProcessTimes.argtypes = [wt.HANDLE] + [ctypes.POINTER(wt.FILETIME)] * 4
    k32.GetProcessTimes.restype = wt.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(_MemCounters), wt.DWORD]
    psapi.GetProcessMemoryInfo.restype = wt.BOOL
    pdh.PdhOpenQueryW.argtypes = [wt.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(wt.HANDLE)]
    pdh.PdhAddEnglishCounterW.argtypes = [wt.HANDLE, wt.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(wt.HANDLE)]
    pdh.PdhCollectQueryData.argtypes = [wt.HANDLE]
    pdh.PdhGetFormattedCounterArrayW.argtypes = [
        wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD), ctypes.c_void_p
    ]
    _NATIVE = (k32, psapi, pdh)
    return _NATIVE


def _tree(root):
    """root 这个进程以及它的所有子孙进程。"""
    k32 = _api()[0]
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return [root]
    parents = {}
    try:
        entry = _ProcEntry()
        entry.dwSize = ctypes.sizeof(_ProcEntry)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    kids = {}
    for pid, ppid in parents.items():
        kids.setdefault(ppid, []).append(pid)
    out, i = [root], 0
    while i < len(out):
        out.extend(kids.get(out[i], ()))
        i += 1
    return out


def _filetime(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def _sample(pids):
    """整棵树的累计 CPU 秒数与工作集合计（字节）。"""
    k32, psapi, _ = _api()
    cpu, mem = 0.0, 0
    access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
    for pid in pids:
        handle = k32.OpenProcess(access, False, pid)
        if not handle:
            continue
        try:
            created, exited, kern, user = wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
            if k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kern), ctypes.byref(user)):
                cpu += (_filetime(kern) + _filetime(user)) / 1e7
            mc = _MemCounters()
            mc.cb = ctypes.sizeof(_MemCounters)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(mc), mc.cb):
                mem += mc.WorkingSetSize
        finally:
            k32.CloseHandle(handle)
    return cpu, mem


class Perf:
    def __init__(self):
        self._lock = threading.Lock()
        self._prev = None
        self._query = None
        self._counter = None

    def _open_gpu(self, pdh):
        query, counter = wt.HANDLE(), wt.HANDLE()
        if pdh.PdhOpenQueryW(None, 0, ctypes.byref(query)) != 0:
            return False
        if pdh.PdhAddEnglishCounterW(query, GPU_COUNTER, 0, ctypes.byref(counter)) != 0:
            return False
        self._query, self._counter = query, counter
        return True

    def _gpu(self, pids):
        pdh = _api()[2]
        if self._counter is None and not self._open_gpu(pdh):
            return None
        if pdh.PdhCollectQueryData(self._query) != 0:
            return None
        size, count = wt.DWORD(0), wt.DWORD(0)
        rc = pdh.PdhGetFormattedCounterArrayW(self._counter, PDH_FMT_DOUBLE, ctypes.byref(size), ctypes.byref(count), None)
        if (rc & 0xFFFFFFFF) != PDH_MORE_DATA or not size.value or not count.value:
            return None
        buf = ctypes.create_string_buffer(size.value)
        if pdh.PdhGetFormattedCounterArrayW(self._counter, PDH_FMT_DOUBLE, ctypes.byref(size), ctypes.byref(count), buf) != 0:
            return None
        items = ctypes.cast(buf, ctypes.POINTER(_PdhItem))
        total = 0.0
        for i in range(count.value):
            name = items[i].szName
            if not name or not name.startswith('pid_'):
                continue
            try:
                pid = int(name[4:name.index('_', 4)])
            except ValueError:
                continue
            if pid in pids:
                total += items[i].FmtValue.doubleValue
        return round(min(100.0, max(0.0, total)), 1)

    def snapshot(self, want_gpu=True):
        if not WIN:
            return {'cpu': None, 'ram': None, 'gpu': None}
        pids = _tree(os.getpid())
        now = time.time()
        cpu_sec, mem = _sample(pids)
        with self._lock:
            prev, self._prev = self._prev, (cpu_sec, now)
            cpu = None
            if prev is not None:
                elapsed = max(1e-6, now - prev[1])
                cores = os.cpu_count() or 1
                cpu = round(max(0.0, (cpu_sec - prev[0]) / elapsed * 100 / cores), 1)
            gpu = self._gpu(set(pids)) if want_gpu else None
        return {'cpu': cpu, 'ram': int(mem / (1024 * 1024)), 'gpu': gpu}


_PERF = Perf()


def snapshot(want_gpu=True):
    try:
        return _PERF.snapshot(want_gpu)
    except Exception as exc:
        log.warning('读取运行占用失败: %s', exc)
        return {'cpu': None, 'ram': None, 'gpu': None}
