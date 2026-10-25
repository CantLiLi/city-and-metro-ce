"""桌面版的存档仓库：存档正文与索引都写在数据目录里，页面只通过桥读写。

目录结构：saves/index.json 是索引，saves/slots/ 下每个存档一个 JSON 文件（文件名即存档键）。
写入先落到 slots/ 下的临时文件再 os.replace，写到一半断电也不会把旧档写坏。
"""

import json
import logging
import os
import re
import threading

from citymetro import storage

log = logging.getLogger('citymetro')

KEY_MAX = 120
BODY_MAX = 64 * 1024 * 1024      # 单个存档正文上限，超出说明前端传来的是别的东西
KEY_PREFIX = 'cm1.slot.'         # 与前端 CFG.saves.prefix 拼出的存档键前缀一致
# 存档键 = KEY_PREFIX + slotId + '.' + 写入号（见前端 save.js 的 uniqueWriteId）。
# 末尾这段写入号只在文件名里出现，slotId 是清单的键，必须从文件名里剥离出来
WRITE_ID = re.compile(r'\.[0-9a-z]+-[0-9a-z]+$')


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
        entries, seen = {}, set()
        keep_games = {}
        try:
            names = os.listdir(os.path.join(self.root(), 'slots'))
        except OSError:
            names = []
        for name in names:
            if name.endswith('.tmp') or not name.startswith(KEY_PREFIX):
                continue
            # 文件名是「存档键」，不是槽位 id：槽位 id 要去掉前缀和末尾的写入号，与前端写进清单的一致
            slot_id = WRITE_ID.sub('', name[len(KEY_PREFIX):])
            game_id = slot_id.split('.', 1)[0]
            if not game_id:
                continue
            path = os.path.join(self.root(), 'slots', name)
            try:
                st = os.stat(path)
                env, payload = self._read_envelope(path)
            except (OSError, ValueError):
                continue
            payload_meta = (payload.get('meta') if isinstance(payload, dict) else None) or {}
            # 信封里没有逐槽的元数据：进度 id 与游戏日期从正文推，存档种类按文件名里有没有 a1/a2 判定
            clock = payload.get('clock') if isinstance(payload, dict) else None
            clock = clock if isinstance(clock, dict) else {}
            saved_at = int(env.get('savedAt') or getattr(st, 'st_mtime', 0) * 1000)
            entry = {
                'slotId': slot_id,
                'key': name,
                'gameId': game_id,
                'kind': ('auto' if ('.a1.' in name or '.a2.' in name)
                         else ('backup' if '.bk' in slot_id else 'manual')),
                'mode': payload_meta.get('mode') or 'challenge',
                'name': payload_meta.get('name') or game_id,
                'map': payload_meta.get('map') or 'gz',
                'label': '恢复的存档（' + ('自动' if ('.a1.' in name or '.a2.' in name) else '手动') + '）',
                'savedAt': saved_at,
                'date': [clock.get('y') or 0, clock.get('m') or 0, clock.get('d') or 0],
                'size': st.st_size,
                'store': 'py',
            }
            # 同一个槽位留下最新的那个文件（自动存档轮换会换文件名、旧的删不掉时也只会留一条记录）
            old = entries.get(slot_id)
            if old is not None:
                seen.add(old['key'])
                if old['savedAt'] > saved_at:
                    continue
            entries[slot_id] = entry
        # 重建只补清单里缺的槽位：清单里已有、但文件已被删掉的记录要跟着去掉，
        # 名称、日期这些前端写进去的字段则保留下来——否则每启动一次就会把清单洗成「恢复的存档」
        previous = self._read_index_raw() or {}
        previous_slots = previous.get('slots') if isinstance(previous.get('slots'), dict) else {}
        keep_games = previous.get('games') if isinstance(previous.get('games'), dict) else {}
        for slot_id, old in previous_slots.items():
            if not isinstance(old, dict):
                continue
            cur = entries.get(slot_id)
            if cur is None:
                if old.get('key') and old.get('key') not in seen:
                    log.info('存档清单里的 %s 指向的文件已不在存档目录，重建时去掉', slot_id)
                continue
            if old.get('key') != cur['key']:
                continue
            entries[slot_id] = dict(cur, **{k: old[k] for k in
                                            ('label', 'mode', 'name', 'map', 'date', 'kind', 'store')
                                            if old.get(k)})
        if not entries:
            # 全新安装只有空的 slots 目录：写一份空清单，别让它每次都当成「索引损坏」
            log.info('存档目录里没有存档文件，写入空清单')
            return {'ok': True, 'count': 0}
        games = {}
        for s in entries.values():
            old = keep_games.get(s['gameId']) if isinstance(keep_games.get(s['gameId']), dict) else None
            g = games.get(s['gameId'])
            if not g:
                g = games[s['gameId']] = {
                    'gameId': s['gameId'],
                    'name': (old or {}).get('name') or s['name'],
                    'mode': (old or {}).get('mode') or s['mode'],
                    'map': (old or {}).get('map') or s['map'],
                    'createdAt': (old or {}).get('createdAt') or s['savedAt'],
                    'updatedAt': s['savedAt'],
                }
            if g['updatedAt'] < s['savedAt']:
                g['updatedAt'] = s['savedAt']
        index = {'games': games, 'slots': entries}
        log.warning('按 %d 个存档文件重建存档清单（新增 %d 条）', len(entries), len(set(entries) - set(previous_slots)))
        res = self._set_index_locked(index)
        if not res.get('ok'):
            return res
        return {'ok': True, 'count': len(entries), 'index': index}

    @staticmethod
    def _read_envelope(path):
        """整份读出来再解析：存档正文可能有几 MB，只读头部拿不到时钟，日期就会退化成 0 年 0 月。"""
        with open(path, 'r', encoding='utf-8') as fh:
            env = json.load(fh)
        if not isinstance(env, dict):
            raise ValueError('存档信封不是对象')
        body = env.get('body')
        payload = json.loads(body) if isinstance(body, str) else {}
        return env, payload if isinstance(payload, dict) else {}

    def rebuild_index(self):
        """按 slots 里的文件重写清单：调用方用它补上清单里缺的存档。"""
        with self._lock:
            return self._rebuild_index_locked()

    def scan(self):
        """按 slots 里的文件算出清单该有的样子，但不写盘：get_index 用它与磁盘上的清单对比，
        发现漏登记才重建，正常启动不必碰磁盘。"""
        try:
            names = [n for n in os.listdir(os.path.join(self.root(), 'slots'))
                     if n.startswith(KEY_PREFIX) and not n.endswith('.tmp')]
        except OSError:
            names = []
        slots = {}
        for name in names:
            slot_id = WRITE_ID.sub('', name[len(KEY_PREFIX):])
            if slot_id:
                slots[slot_id] = name
        return {'files': len(names), 'slots': slots}

    def files(self):
        """存档目录里实际有几个存档文件：清单条数少于它，说明清单漏登记了。"""
        return self.scan()['files']

    def get_index(self):
        # 清单能读就交给前端；同时按 slots 里的文件核一遍：有漏登记的槽位（存档文件的槽位 id
        # 不在清单里）就当场补上，前端不必也不该自己拿「文件数 > 条数」这种会误判的口径去重建
        data = self._read_index_raw()
        if data is not None and not self._is_empty(data):
            missing = self._missing_slots(data)
            if not missing:
                return {'ok': True, 'index': data, 'count': len(data.get('slots') or {}),
                        'files': self.files()}
            log.warning('存档清单漏了 %d 个槽位，按文件补齐：%s', len(missing), ', '.join(sorted(missing))[:300])
            with self._lock:
                built = self._rebuild_index_locked()
            if built.get('ok'):
                built = dict(built, index=self._read_index_raw() or data, files=self.files(), rebuilt=True)
                return built
            return {'ok': True, 'index': data, 'count': len(data.get('slots') or {}),
                    'files': self.files(), 'error': built.get('error')}
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

    def _missing_slots(self, index):
        """磁盘上有存档文件、清单里却没有这个槽位（或清单记的文件已不在）。"""
        slots = index.get('slots') if isinstance(index.get('slots'), dict) else {}
        found = self.scan()['slots']
        missing = set(found) - set(slots)
        for slot_id, meta in slots.items():
            if slot_id in found or not isinstance(meta, dict):
                continue
            # 清单指向的文件确实还在（只是槽位 id 与文件名对不上）就不算漏登记
            if meta.get('key') in found.values():
                continue
            missing.add(slot_id)
        return missing

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
        # 清单读不出来时界面要给用户说清「存档文件还在」，这里顺带把磁盘上的存档数报上去
        try:
            return {'ok': True, 'dir': self.root(), 'files': self.files()}
        except OSError:
            return {'ok': True, 'dir': self.root(), 'files': 0}
