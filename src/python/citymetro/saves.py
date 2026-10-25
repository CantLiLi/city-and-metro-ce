"""桌面版的存档仓库：存档正文与索引都写在数据目录里，页面只通过桥读写。

目录结构：saves/index.json 是索引，saves/slots/ 下每个存档一个 JSON 文件（文件名即存档键）。
写入先落到 slots/ 下的临时文件再 os.replace，写到一半断电也不会把旧档写坏。
"""

import json
import logging
import os
import threading

from citymetro import storage

log = logging.getLogger('citymetro')

KEY_MAX = 120
BODY_MAX = 64 * 1024 * 1024      # 单个存档正文上限，超出说明前端传来的是别的东西
KEY_PREFIX = 'cm1.slot.'         # 与前端 CFG.saves.prefix 拼出的存档键前缀一致


class SaveStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._root = None

    # ---------------- 路径 ----------------
    def root(self):
        if self._root is None:
            path = os.path.join(storage.data_dir(), 'saves')
            os.makedirs(os.path.join(path, 'slots'), exist_ok=True)
            self._root = path
        return self._root

    def index_path(self):
        return os.path.join(self.root(), 'index.json')

    def _slot_path(self, key):
        # 键来自前端，只允许它出现在文件名里：路径分隔符、上跳与 Windows 的保留字符一律拒绝
        if not isinstance(key, str) or not key or len(key) > KEY_MAX:
            return None
        if any(c in key for c in '/\\:*?"<>|') or key.startswith('.') or '..' in key:
            return None
        return os.path.join(self.root(), 'slots', key)

    # ---------------- 原子写 ----------------
    def _write_text(self, path, text):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    # ---------------- 索引 ----------------
    @staticmethod
    def _is_empty(index):
        return not (isinstance(index, dict) and (index.get('games') or index.get('slots')))

    def _read_index_raw(self):
        try:
            with open(self.index_path(), 'r', encoding='utf-8') as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    # 每次覆盖清单前留一份上一版：清单不见了还能看出原来有哪些存档
    def _rotate_index(self):
        src = self.index_path()
        if not os.path.exists(src):
            return
        try:
            os.replace(src, src + '.prev')
        except OSError:
            log.debug('轮换存档索引备份失败', exc_info=True)

    def _backups(self):
        try:
            return [n for n in os.listdir(self.root()) if n.startswith('index.json.')]
        except OSError:
            return []

    def _load_backup(self):
        for name in ('index.json.prev', 'index.json.tmp'):
            path = os.path.join(self.root(), name)
            if not os.path.exists(path):
                continue
            try:
                with open(path, 'r', encoding='utf-8') as fh:
                    old = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(old, dict) and not self._is_empty(old):
                return name, old
        return None, None

    # 按 slots 里的存档文件重建清单；调用方负责持锁
    def _rebuild_index_locked(self):
        entries = {}
        try:
            names = os.listdir(os.path.join(self.root(), 'slots'))
        except OSError:
            names = []
        for name in names:
            if name.endswith('.tmp') or not name.startswith(KEY_PREFIX):
                continue
            tail = name[len(KEY_PREFIX):]
            game_id = tail.split('.', 1)[0]
            if not game_id:
                continue
            path = os.path.join(self.root(), 'slots', name)
            try:
                st = os.stat(path)
                with open(path, 'r', encoding='utf-8') as fh:
                    head = fh.read(4096)
                env = json.loads(head) if head.rstrip().endswith('}') else {}
                if not isinstance(env, dict):
                    env = {}
                body = env.get('body')
                payload = json.loads(body) if isinstance(body, str) else {}
                payload_meta = (payload.get('meta') if isinstance(payload, dict) else None) or {}
            except (OSError, ValueError):
                continue
            # 信封里没有逐槽的元数据：进度 id 与游戏日期从正文推，存档种类按文件名里有没有 a1/a2 判定
            clock = payload.get('clock') if isinstance(payload, dict) else None
            clock = clock if isinstance(clock, dict) else {}
            date = [clock.get('y') or 0, clock.get('m') or 0, clock.get('d') or 0]
            entry = {
                'slotId': name,
                'key': name,
                'gameId': game_id,
                'kind': 'auto' if ('.a1.' in name or '.a2.' in name) else 'manual',
                'mode': payload_meta.get('mode') or 'challenge',
                'name': payload_meta.get('name') or game_id,
                'map': payload_meta.get('map') or 'gz',
                'label': '恢复的存档',
                'savedAt': int(env.get('savedAt') or getattr(st, 'st_mtime', 0) * 1000),
                'date': date,
                'size': st.st_size,
            }
            entries[entry['slotId']] = entry
        if not entries:
            # 全新安装只有空的 slots 目录：写一份空清单，别让它每次都当成「索引损坏」
            log.info('存档目录里没有存档文件，写入空清单')
            return {'ok': True, 'count': 0}
        games = {}
        for s in entries.values():
            g = games.get(s['gameId'])
            if not g or g['updatedAt'] < s['savedAt']:
                games[s['gameId']] = {'gameId': s['gameId'], 'name': s['name'], 'mode': s['mode'],
                                      'map': s['map'], 'createdAt': s['savedAt'], 'updatedAt': s['savedAt']}
        index = {'games': games, 'slots': entries}
        log.warning('按 %d 个存档文件重建存档清单', len(entries))
        res = self._set_index_locked(index)
        if not res.get('ok'):
            return res
        return {'ok': True, 'count': len(entries), 'index': index}

    def rebuild_index(self):
        """按 slots 里的文件重写清单：调用方用它补上清单里缺的存档。"""
        with self._lock:
            return self._rebuild_index_locked()

    def files(self):
        """存档目录里实际有几个存档文件：清单条数少于它，说明清单漏登记了。"""
        try:
            names = os.listdir(os.path.join(self.root(), 'slots'))
        except OSError:
            return 0
        return len([n for n in names if n.startswith(KEY_PREFIX) and not n.endswith('.tmp')])

    def get_index(self):
        # 清单能读就原样交给前端，哪怕它比文件少：前端启动时发现文件数多于清单条数会自动补齐，
        # 后端在每次启动都扫一遍目录反而更慢
        data = self._read_index_raw()
        if data is not None and not self._is_empty(data):
            return {'ok': True, 'index': data, 'count': len(data.get('slots') or {}),
                    'files': self.files()}
        # 清单不存在、空的或读不出来：先把上一版备份顶上，再不行就按 slots 里的文件重建
        if not os.path.exists(self.index_path()):
            log.warning('存档清单不存在：%s', self.index_path())
        else:
            log.warning('读存档索引失败：%s', self.index_path())
        name, old = self._load_backup()
        if old is not None:
            log.warning('改用索引备份 %s（%d 个存档）', name, len(old.get('slots') or {}))
            return {'ok': True, 'index': old, 'recovered': name,
                    'count': len(old.get('slots') or {}), 'files': self.files()}
        with self._lock:
            built = self._rebuild_index_locked()
        if built.get('ok'):
            built = dict(built)
            built['index'] = self._read_index_raw()
            built['rebuilt'] = True
            built['files'] = self.files()
            built['count'] = built.get('count') or 0
            return built
        return {'ok': False, 'error': '存档索引损坏或丢失'}

    def set_index(self, index):
        if not isinstance(index, dict):
            return {'ok': False, 'error': '索引格式不对'}
        with self._lock:
            return self._set_index_locked(index)

    def _set_index_locked(self, index):
        # 空清单不能覆盖非空清单：前端读清单失败后会把内存里的空清单写回，那会把磁盘上所有进度一起抹掉
        if self._is_empty(index):
            old = self._read_index_raw()
            if old is not None and not self._is_empty(old):
                log.warning('拒绝用空清单覆盖已登记 %d 个存档的 %s', len(old.get('slots') or {}), self.index_path())
                return {'ok': False, 'error': '拒绝用空清单覆盖磁盘上已有的存档清单'}
            if self._backups():
                log.warning('拒绝用空清单覆盖 %s（旁边还有索引备份）', self.index_path())
                return {'ok': False, 'error': '拒绝用空清单覆盖存档索引（索引备份还在，说明之前有过存档）'}
        try:
            self._rotate_index()
            self._write_text(self.index_path(), json.dumps(index, ensure_ascii=False))
        except (OSError, TypeError, ValueError) as exc:
            log.warning('写存档索引失败: %s', exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True}

    # ---------------- 正文 ----------------
    def write_slot(self, key, text):
        path = self._slot_path(key)
        if not path:
            return {'ok': False, 'error': '存档键不合法'}
        if not isinstance(text, str):
            return {'ok': False, 'error': '存档内容格式不对'}
        if len(text) > BODY_MAX:
            return {'ok': False, 'error': '存档过大（超过 64 MB）'}
        with self._lock:
            try:
                self._write_text(path, text)
            except OSError as exc:
                log.warning('写存档失败 %s: %s', key, exc)
                return {'ok': False, 'error': str(exc)}
        return {'ok': True}

    def read_slot(self, key):
        path = self._slot_path(key)
        if not path:
            return {'ok': False, 'error': '存档键不合法'}
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                text = fh.read()
        except FileNotFoundError:
            return {'ok': True, 'text': None}
        except OSError as exc:
            log.warning('读存档失败 %s: %s', key, exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'text': text}

    # 读回校验：写入后确认落盘的字节与内存里的一致
    def verify_slot(self, key, text):
        got = self.read_slot(key)
        return {'ok': got.get('ok', False) and got.get('text') == text, 'error': got.get('error')}

    def delete_slot(self, key):
        path = self._slot_path(key)
        if not path:
            return {'ok': False, 'error': '存档键不合法'}
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning('删除存档失败 %s: %s', key, exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True}

    # ---------------- 目录信息 ----------------
    def info(self):
        return {'ok': True, 'dir': self.root()}
