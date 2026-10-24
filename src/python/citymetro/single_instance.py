"""单实例锁：避免同一份存档被两个进程同时读写。"""

import os
import sys


class InstanceLock:
    def __init__(self, path):
        self.path = path
        self._handle = None
        self._fh = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if sys.platform == 'win32':
            import msvcrt

            self._fh = open(self.path, 'a+b')
            try:
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                self._fh.close()
                self._fh = None
                return False
            return True
        import fcntl

        self._fh = open(self.path, 'a+b')
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._fh.close()
            self._fh = None
            return False
        return True

    def release(self):
        if self._fh is None:
            return
        try:
            if sys.platform == 'win32':
                import msvcrt

                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._fh.close()
            self._fh = None
