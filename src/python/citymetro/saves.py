"""桌面版的存档仓库：存档文件与清单都写在数据目录里，页面只通过桥读写。

目录结构：saves/slots/index.json 是清单（只记槽位指向哪个文件），同目录下每个
「时间_地图名.mksave」就是一份完整存档，文件名由页面生成。
写入先落临时文件再 os.replace，写到一半断电也不会把旧档写坏。
"""

import json
import logging
import os
import threading

from citymetro import storage

log = logging.getLogger('citymetro')

KEY_MAX = 120
BODY_MAX = 64 * 1024 * 1024      # 单个存档正文上限，超出说明前端传来的是别的东西
INDEX_KEY = 'index.json'         # 与前端 save.js 的 KN.index 一致
FILE_SUFFIX = '.mksave'          # 与前端 KN.file 一致


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

    def slots_dir(self):
        path = os.path.join(self.root(), 'slots')
        os.makedirs(path, exist_ok=True)
        return path

    def index_path(self):
        return os.path.join(self.slots_dir(), INDEX_KEY)

    def _slot_path(self, key):
        # 键来自前端，只允许它出现在文件名里：路径分隔符、上跳与 Windows 的保留字符一律拒绝
        if not isinstance(key, str) or not key or len(key) > KEY_MAX:
            return None
        if any(c in key for c in '/\\:*?"<>|') or key.startswith('.') or '..' in key:
            return None
        return os.path.join(self.slots_dir(), key)

    # ---------------- 原子写 ----------------
    def _write_text(self, path, text):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    # ---------------- 清单 ----------------
    @staticmethod
    def _normalize(index):
        if not isinstance(index, dict):
            return None
        slots = index.get('slots')
        if not isinstance(slots, dict):
            return None
        return {'v': 1, 'slots': slots}

    def _read_index_raw(self):
        """返回 (内容, 是否读过)：文件不存在与文件坏了必须分开，坏了不能当空清单处理。"""
        try:
            with open(self.index_path(), 'r', encoding='utf-8') as fh:
                return json.load(fh), True
        except FileNotFoundError:
            return None, True
        except (OSError, ValueError):
            return None, False

    def read_index(self):
        data, readable = self._read_index_raw()
        if not readable:
            return {'ok': False, 'error': '清单内容已损坏（不是合法的存档清单）'}
        if data is None:
            return {'ok': True, 'index': None}
        norm = self._normalize(data)
        if norm is None:
            return {'ok': False, 'error': '清单内容已损坏（不是合法的存档清单）'}
        return {'ok': True, 'index': norm}

    def write_index(self, index):
        norm = self._normalize(index)
        if norm is None:
            return {'ok': False, 'error': '清单格式不对'}
        with self._lock:
            return self._write_index_locked(norm)

    def _write_index_locked(self, index):
        try:
            slots = self.slots_dir()
            self._write_text(os.path.join(slots, INDEX_KEY), json.dumps(index, ensure_ascii=False))
        except (OSError, TypeError, ValueError) as exc:
            log.warning('写存档清单失败: %s', exc)
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
        try:
            json.loads(text)
        except ValueError:
            return {'ok': False, 'error': '存档内容不是合法的 JSON'}
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

    # ---------------- 按文件重建清单 ----------------
    def _files(self):
        try:
            names = os.listdir(self.slots_dir())
        except OSError:
            return []
        return [n for n in names if n.endswith(FILE_SUFFIX) and n != INDEX_KEY]

    def _entry(self, name):
        """从一个存档文件读出清单条目；文件头里的 meta 就是前端写进去的槽位数据。"""
        path = os.path.join(self.slots_dir(), name)
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                env = json.load(fh)
            size = os.path.getsize(path)
        except (OSError, ValueError):
            return None
        if not isinstance(env, dict):
            return None
        body = env.get('body')
        try:
            payload = json.loads(body) if isinstance(body, str) else {}
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        meta = payload.get('meta') if isinstance(payload.get('meta'), dict) else {}
        clock = payload.get('clock') if isinstance(payload.get('clock'), dict) else {}
        econ = payload.get('econ') if isinstance(payload.get('econ'), dict) else {}
        net = payload.get('net') if isinstance(payload.get('net'), dict) else {}
        game_id = meta.get('gameId') if isinstance(meta.get('gameId'), str) else ''
        slot_id = meta.get('slotId') if isinstance(meta.get('slotId'), str) else ''
        if not slot_id:
            slot_id = (game_id or 'unknown') + '.' + os.path.splitext(name)[0]
        date = meta.get('date')
        if not isinstance(date, list):
            date = [clock.get('y') or 0, clock.get('m') or 0, clock.get('d') or 0]
        stations = net.get('stations') if isinstance(net.get('stations'), dict) else {}
        funds = econ.get('funds')
        return {
            'slotId': slot_id,
            'key': name,
            'gameId': game_id,
            'kind': meta.get('kind') or ('backup' if '.bk' in slot_id else 'manual'),
            'label': meta.get('label') or '存档',
            'name': meta.get('name') or '',
            'mode': meta.get('mode') or 'challenge',
            'map': meta.get('map') or 'gz',
            'scenario': meta.get('scenario') or '',
            'createdAt': meta.get('createdAt') or 0,
            'date': date,
            'savedAt': int(env.get('savedAt') or 0),
            'stations': len(stations),
            'funds': funds,
            'size': size,
        }

    def latest(self, with_text=True):
        """挑出最新的那份存档。with_text 为假时只回清单条目，主页面用它显示不读正文。"""
        best = None
        for name in self._files():
            entry = self._entry(name)
            if not entry:
                log.info('跳过无法解析的存档文件 %s', name)
                continue
            if best is None:
                best = entry
                continue
            if entry['savedAt'] != best['savedAt']:
                if entry['savedAt'] > best['savedAt']:
                    best = entry
            elif entry['key'] > best['key']:
                best = entry
        if best is None:
            return {'ok': True, 'slot': None, 'text': None}
        if not with_text:
            return {'ok': True, 'slot': best, 'text': None}
        path = os.path.join(self.slots_dir(), best['key'])
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                text = fh.read()
        except FileNotFoundError:
            return {'ok': False, 'error': '存档文件丢失：' + best['key']}
        except OSError as exc:
            log.warning('读存档失败 %s: %s', best['key'], exc)
            return {'ok': False, 'error': str(exc)}
        return {'ok': True, 'slot': best, 'text': text}

    def rebuild(self):
        """按 slots 里的存档文件重建清单：每个槽位只留最新的一份。"""
        best = {}
        for name in self._files():
            entry = self._entry(name)
            if not entry:
                log.info('跳过无法解析的存档文件 %s', name)
                continue
            old = best.get(entry['slotId'])
            # 同一槽位可能残留多份：先比正文里的 savedAt，再按文件名（时间戳单调）定先后
            if old is not None:
                if entry['savedAt'] != old['savedAt']:
                    if entry['savedAt'] < old['savedAt']:
                        continue
                elif entry['key'] <= old['key']:
                    continue
            best[entry['slotId']] = entry
        index = {'v': 1, 'slots': dict(sorted(best.items(), key=lambda kv: -kv[1]['savedAt']))}
        with self._lock:
            res = self._write_index_locked(index)
        if not res.get('ok'):
            return res
        log.info('按 %d 个存档文件重建清单', len(index['slots']))
        return {'ok': True, 'index': index, 'count': len(index['slots'])}

    # ---------------- 目录信息 ----------------
    def info(self):
        try:
            return {'ok': True, 'dir': self.root(), 'files': len(self._files())}
        except OSError:
            return {'ok': True, 'dir': self.root(), 'files': 0}
