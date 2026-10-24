"""运行监控数据：本软件各进程的 CPU、内存占用，以及显卡占用。

Windows：WebView2 的浏览器、渲染、显卡进程都是 python.exe 的子进程，按父进程关系累加整棵树，
显卡占用只有系统性能计数器（PDH 的 GPU Engine 实例）能读到。
macOS：WebKit 的网页进程由 launchd 拉起，不在本进程的子进程里，所以按资源联盟（coalition）
把同一个应用拉起的全部进程找出来，显卡时间也只有联盟统计里有。
"""

import ctypes
import logging
import os
import sys
import threading
import time

log = logging.getLogger('citymetro')

WIN = sys.platform == 'win32'
MAC = sys.platform == 'darwin'

DWORD = ctypes.c_uint32
BOOL = ctypes.c_int32
HANDLE = ctypes.c_void_p
LPWSTR = ctypes.c_wchar_p
LPCWSTR = ctypes.c_wchar_p


class _FileTime(ctypes.Structure):
    _fields_ = [('dwLowDateTime', DWORD), ('dwHighDateTime', DWORD)]


class _ProcEntry(ctypes.Structure):
    _fields_ = [
        ('dwSize', DWORD),
        ('cntUsage', DWORD),
        ('th32ProcessID', DWORD),
        ('th32DefaultHeapID', ctypes.c_size_t),
        ('th32ModuleID', DWORD),
        ('cntThreads', DWORD),
        ('th32ParentProcessID', DWORD),
        ('pcPriClassBase', ctypes.c_long),
        ('dwFlags', DWORD),
        ('szExeFile', ctypes.c_wchar * 260),
    ]


class _MemCounters(ctypes.Structure):
    _fields_ = [
        ('cb', DWORD),
        ('PageFaultCount', DWORD),
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
    _fields_ = [('CStatus', DWORD), ('doubleValue', ctypes.c_double)]


class _PdhItem(ctypes.Structure):
    _fields_ = [('szName', LPWSTR), ('FmtValue', _PdhValue)]


TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_VM_READ = 0x0010
PDH_FMT_DOUBLE = 0x00000200
PDH_MORE_DATA = 0x800007D2
GPU_COUNTER = r'\GPU Engine(*)\Utilization Percentage'

_NATIVE = None


def _api():
    """按需加载 kernel32 / psapi / pdh；64 位下句柄必须声明成 HANDLE 才不会被截断。"""
    global _NATIVE
    if _NATIVE is not None:
        return _NATIVE
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    pdh = ctypes.WinDLL('pdh', use_last_error=True)
    k32.CreateToolhelp32Snapshot.argtypes = [DWORD, DWORD]
    k32.CreateToolhelp32Snapshot.restype = HANDLE
    k32.Process32FirstW.argtypes = [HANDLE, ctypes.POINTER(_ProcEntry)]
    k32.Process32FirstW.restype = BOOL
    k32.Process32NextW.argtypes = [HANDLE, ctypes.POINTER(_ProcEntry)]
    k32.Process32NextW.restype = BOOL
    k32.OpenProcess.argtypes = [DWORD, BOOL, DWORD]
    k32.OpenProcess.restype = HANDLE
    k32.CloseHandle.argtypes = [HANDLE]
    k32.GetProcessTimes.argtypes = [HANDLE] + [ctypes.POINTER(_FileTime)] * 4
    k32.GetProcessTimes.restype = BOOL
    psapi.GetProcessMemoryInfo.argtypes = [HANDLE, ctypes.POINTER(_MemCounters), DWORD]
    psapi.GetProcessMemoryInfo.restype = BOOL
    pdh.PdhOpenQueryW.argtypes = [LPCWSTR, ctypes.c_size_t, ctypes.POINTER(HANDLE)]
    pdh.PdhAddEnglishCounterW.argtypes = [HANDLE, LPCWSTR, ctypes.c_size_t, ctypes.POINTER(HANDLE)]
    pdh.PdhCollectQueryData.argtypes = [HANDLE]
    pdh.PdhGetFormattedCounterArrayW.argtypes = [
        HANDLE, DWORD, ctypes.POINTER(DWORD), ctypes.POINTER(DWORD), ctypes.c_void_p
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
            created, exited, kern, user = _FileTime(), _FileTime(), _FileTime(), _FileTime()
            if k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kern), ctypes.byref(user)):
                cpu += (_filetime(kern) + _filetime(user)) / 1e7
            mc = _MemCounters()
            mc.cb = ctypes.sizeof(_MemCounters)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(mc), mc.cb):
                mem += mc.WorkingSetSize
        finally:
            k32.CloseHandle(handle)
    return cpu, mem


PROC_ALL_PIDS = 1
PROC_PIDCOALITIONINFO = 20
RUSAGE_INFO_V2 = 2
COALITION_TYPE_RESOURCE = 0


class _RusageV2(ctypes.Structure):
    """<sys/resource.h> 里的 rusage_info_v2，时间单位是 mach 绝对时间。"""
    _fields_ = [
        ('ri_uuid', ctypes.c_uint8 * 16),
        ('ri_user_time', ctypes.c_uint64),
        ('ri_system_time', ctypes.c_uint64),
        ('ri_pkg_idle_wkups', ctypes.c_uint64),
        ('ri_interrupt_wkups', ctypes.c_uint64),
        ('ri_pageins', ctypes.c_uint64),
        ('ri_wired_size', ctypes.c_uint64),
        ('ri_resident_size', ctypes.c_uint64),
        ('ri_phys_footprint', ctypes.c_uint64),
        ('ri_proc_start_abstime', ctypes.c_uint64),
        ('ri_proc_exit_abstime', ctypes.c_uint64),
        ('ri_child_user_time', ctypes.c_uint64),
        ('ri_child_system_time', ctypes.c_uint64),
        ('ri_child_pkg_idle_wkups', ctypes.c_uint64),
        ('ri_child_interrupt_wkups', ctypes.c_uint64),
        ('ri_child_pageins', ctypes.c_uint64),
        ('ri_child_elapsed_abstime', ctypes.c_uint64),
        ('ri_diskio_bytesread', ctypes.c_uint64),
        ('ri_diskio_byteswritten', ctypes.c_uint64),
    ]


class _CoalitionInfo(ctypes.Structure):
    """<sys/proc_info.h> 里的 proc_pidcoalitioninfo。"""
    _fields_ = [
        ('coalition_id', ctypes.c_uint64 * 2),
        ('reserved1', ctypes.c_uint64),
        ('reserved2', ctypes.c_uint64),
        ('reserved3', ctypes.c_uint64),
    ]


COALITION_QOS = 7


class _CoalitionUsage(ctypes.Structure):
    """<bsd/sys/coalition.h> 里的 coalition_resource_usage，顺序与内核一致。"""
    _fields_ = [(name, ctypes.c_uint64) for name in (
        'tasks_started', 'tasks_exited', 'time_nonempty', 'cpu_time',
        'interrupt_wakeups', 'platform_idle_wakeups', 'bytesread', 'byteswritten',
        'gpu_time', 'cpu_time_billed_to_me', 'cpu_time_billed_to_others', 'energy',
        'logical_immediate_writes', 'logical_deferred_writes', 'logical_invalidated_writes',
        'logical_metadata_writes', 'logical_immediate_writes_to_external',
        'logical_deferred_writes_to_external', 'logical_invalidated_writes_to_external',
        'logical_metadata_writes_to_external', 'energy_billed_to_me', 'energy_billed_to_others',
        'cpu_ptime', 'cpu_time_eqos_len',
    )] + [('qos%d' % i, ctypes.c_uint64) for i in range(COALITION_QOS)] + [
        ('cpu_instructions', ctypes.c_uint64),
        ('cpu_cycles', ctypes.c_uint64),
        ('fs_metadata_writes', ctypes.c_uint64),
        ('pm_writes', ctypes.c_uint64),
    ]


class _Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


_MACH = None


def _mach():
    """按需加载 libproc 与联盟统计；取不到的接口保持 None，调用处逐项退让。"""
    global _MACH
    if _MACH is not None:
        return _MACH
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    lib.proc_listpids.restype = ctypes.c_int
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    lib.proc_pid_rusage.restype = ctypes.c_int
    system = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    try:
        kern = ctypes.CDLL('/usr/lib/libsystem_kernel.dylib', use_errno=True)
    except OSError:
        kern = lib
    coalition = None
    for owner in (kern, lib, system):
        coalition = getattr(owner, 'coalition_info_resource_usage', None)
        if coalition is not None:
            coalition.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
            coalition.restype = ctypes.c_int
            break
    system.mach_timebase_info.argtypes = [ctypes.POINTER(_Timebase)]
    system.mach_timebase_info.restype = ctypes.c_int
    tb = _Timebase()
    system.mach_timebase_info(ctypes.byref(tb))
    scale = (tb.numer / tb.denom) / 1e9 if tb.denom else 1e-9
    _MACH = (lib, coalition, scale)
    return _MACH


def _coalition_id(lib, pid):
    info = _CoalitionInfo()
    rc = lib.proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
    if rc != ctypes.sizeof(info):
        return None
    return info.coalition_id[COALITION_TYPE_RESOURCE]


def _mac_pids():
    """与本进程同属一个资源联盟的进程（含 WebKit 的网页进程）。"""
    lib = _mach()[0]
    mine = _coalition_id(lib, os.getpid())
    buf = ctypes.create_string_buffer(4096 * 4)
    used = lib.proc_listpids(PROC_ALL_PIDS, 0, buf, len(buf))
    pids = []
    if used > 0:
        arr = (ctypes.c_int * (used // 4)).from_buffer(buf)
        for pid in arr:
            if pid <= 0:
                continue
            if mine is None:
                if pid == os.getpid():
                    pids.append(pid)
            elif _coalition_id(lib, pid) == mine:
                pids.append(pid)
    if not pids:
        pids = [os.getpid()]
    return pids, mine


def _mac_usage(lib, pids):
    """这些进程的累计 CPU 秒数与物理内存占用（字节）。"""
    cpu, mem = 0.0, 0
    scale = _mach()[2]
    for pid in pids:
        info = _RusageV2()
        if lib.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(info)) != 0:
            continue
        cpu += (info.ri_user_time + info.ri_system_time) * scale
        mem += info.ri_phys_footprint
    return cpu, mem


def _mac_gpu_seconds(coalition_id):
    """联盟累计的显卡时间；拿不到时返回 None。"""
    coalition = _mach()[1]
    if coalition is None or coalition_id is None:
        return None
    usage = _CoalitionUsage()
    if coalition(coalition_id, ctypes.byref(usage), ctypes.sizeof(usage)) != 0:
        return None
    return usage.gpu_time * _mach()[2]


def _rate(prev, cur, now, cores):
    if prev is None:
        return None
    elapsed = max(1e-6, now - prev[1])
    return round(max(0.0, (cur - prev[0]) / elapsed * 100 / cores), 1)


class Perf:
    def __init__(self):
        self._lock = threading.Lock()
        self._prev = None
        self._query = None
        self._counter = None

    def _open_gpu(self, pdh):
        query, counter = HANDLE(), HANDLE()
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
        size, count = DWORD(0), DWORD(0)
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

    def _snapshot_win(self, want_gpu):
        pids = set(_tree(os.getpid()))
        now = time.time()
        cpu_sec, mem = _sample(pids)
        gpu = self._gpu(pids) if want_gpu else None
        with self._lock:
            prev, self._prev = self._prev, (cpu_sec, now)
            cpu = _rate(prev, cpu_sec, now, os.cpu_count() or 1)
        return {'cpu': cpu, 'ram': int(mem / (1024 * 1024)), 'gpu': gpu}

    def _snapshot_mac(self, want_gpu):
        lib = _mach()[0]
        now = time.time()
        pids, coalition_id = _mac_pids()
        cpu_sec, mem = _mac_usage(lib, pids)
        gpu_sec = _mac_gpu_seconds(coalition_id) if want_gpu else None
        with self._lock:
            prev, self._prev = self._prev, (cpu_sec, now, gpu_sec)
            cpu = _rate(prev, cpu_sec, now, os.cpu_count() or 1)
            gpu = None
            if gpu_sec is not None and prev is not None and prev[2] is not None:
                elapsed = max(1e-6, now - prev[1])
                gpu = round(min(100.0, max(0.0, (gpu_sec - prev[2]) / elapsed * 100)), 1)
        return {'cpu': cpu, 'ram': int(mem / (1024 * 1024)), 'gpu': gpu}

    def snapshot(self, want_gpu=True):
        if WIN:
            return self._snapshot_win(want_gpu)
        if MAC:
            return self._snapshot_mac(want_gpu)
        return {'cpu': None, 'ram': None, 'gpu': None}


_PERF = Perf()


def snapshot(want_gpu=True):
    try:
        return _PERF.snapshot(want_gpu)
    except Exception as exc:
        log.warning('读取运行占用失败: %s', exc)
        return {'cpu': None, 'ram': None, 'gpu': None}
