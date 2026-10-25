'use strict';
// 本地存档（无账号）：一个存储键装一份存档文件，清单只记录槽位指向哪个键。
// 桌面版由外壳把两者写进数据目录，网页版写进 IndexedDB（不可用时退回 localStorage）。
// 存档文件名对用户可见：<时间>_<地图名>.mksave；存入即完整文件（含格式、版本、校验和），
// 导出的文件与本地存的完全一致，导入也走同一套校验。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const KN = { index: 'index.json', file: '.mksave' };
  const VERSION = CFG.SAVE_VERSION, MIN_VERSION = CFG.SAVE_MIN_VERSION;
  const MAP_KEYS = ['pop', 'jobs', 'bh', 'taken', 'lu', 'street', 'urbanYear'];
  const KIND_LABEL = { auto: '自动存档', manual: '手动存档', backup: '升级前备份' };

  const desk = function () { return !!(CM.desktop && CM.desktop.isDesktop()); };
  function deskCall(name, args) {
    if (!CM.desktop || typeof CM.desktop.saveCall !== 'function') return Promise.reject(new Error('桌面接口不可用'));
    return CM.desktop.saveCall(name, args);
  }
  function fail(e) {
    if (!e) return '未知错误';
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) return '本地存储空间不足（可删除旧存档或导出备份后清理）';
    if (e.name === 'SecurityError') return '浏览器禁止本地存储（隐私模式或站点数据被阻止）';
    return (e && e.message) || String(e);
  }
  function parseJSON(text) {
    try { return { v: JSON.parse(text) }; } catch (e) { return { e: e }; }
  }
  function noop() {}

  // ---------------- 存储后端：put/get/del 三个异步原子操作 ----------------
  const Local = (function () {
    let db = null, dbFailed = false;
    function openDB() {
      if (db) return Promise.resolve(db);
      if (dbFailed) return Promise.resolve(null);
      return new Promise(function (resolve) {
        let req;
        try { req = indexedDB.open('city-metro', 3); } catch (e) { dbFailed = true; resolve(null); return; }
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onerror = function () { dbFailed = true; resolve(null); };
        req.onblocked = function () { dbFailed = true; resolve(null); };
        req.onsuccess = function () { db = req.result; resolve(db); };
      });
    }
    function write(d, key, text) {
      return new Promise(function (resolve, reject) {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(text, key);
        tx.oncomplete = function () { resolve(text); };
        tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写入失败')); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
      });
    }
    function op(mode, run) {
      return openDB().then(function (d) {
        if (!d) return new Promise(function (resolve) { resolve(run.ls()); });
        return new Promise(function (resolve, reject) {
          const tx = d.transaction('kv', mode), st = tx.objectStore('kv');
          const r = run.idb(st);
          let val = null;
          if (r) r.onsuccess = function () { val = r.result; };
          tx.oncomplete = function () { resolve(val); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB 操作失败')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
        });
      });
    }
    return {
      name: 'local',
      label: function () { return db ? 'IndexedDB' : 'localStorage'; },
      put: function (key, text) {
        return op('readwrite', {
          ls: function () { localStorage.setItem(key, text); return 'ls'; },
          idb: function (st) { st.put(text, key); },
        }).catch(function (e) { if (db) throw e; localStorage.setItem(key, text); return 'ls'; });
      },
      get: function (key) {
        return op('readonly', {
          ls: function () { return localStorage.getItem(key); },
          idb: function (st) { return st.get(key); },
        }).catch(function (e) { if (db) throw e; return localStorage.getItem(key); });
      },
      del: function (key) {
        return op('readwrite', {
          ls: function () { localStorage.removeItem(key); return null; },
          idb: function (st) { st.delete(key); },
        }).catch(function () { try { localStorage.removeItem(key); } catch (e) { noop(e); } });
      },
    };
  })();

  const Desk = {
    name: 'desk',
    label: function () { return '本地存档目录'; },
    put: function (key, text) {
      return deskCall('save_slot_write', [key, text]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写入存档失败');
      });
    },
    get: function (key) {
      return deskCall('save_slot_read', [key]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '读取存档失败');
        return r.text == null ? null : r.text;
      });
    },
    del: function (key) { return deskCall('save_slot_delete', [key]).then(noop, noop); },
  };
  const store = function () { return desk() ? Desk : Local; };

  // ---------------- 清单：内存副本 + 单条串行写 ----------------
  const EMPTY = function () { return { v: 1, slots: {} }; };
  // 清单读失败时禁止写盘：否则空清单会把磁盘上所有存档记录一起抹掉
  let idx = EMPTY(), bad = '', tail = Promise.resolve(), seq = 0, lastAt = 0, loaded = false;
  function stale() {
    const e = new Error('存档清单没有读取成功（' + bad + '），为避免覆盖原有记录，这次不写入');
    e.noWrite = true;
    return e;
  }
  function norm(o) {
    if (!o || typeof o !== 'object') return null;
    if (!o.slots || typeof o.slots !== 'object') return null;
    return { v: 1, slots: o.slots };
  }
  function loadIndex() {
    const S = store();
    return S.get(KN.index).then(function (text) {
      if (!text) return EMPTY();
      const r = parseJSON(text);
      const n = r.v ? norm(r.v) : null;
      if (!n) throw new Error('清单内容已损坏（不是合法的存档清单）');
      return n;
    }, function (e) { throw new Error('读取存档清单失败：' + fail(e)); }).then(function (n) {
      loaded = true;
      return n;
    });
  }
  // 第一个快照可能覆盖磁盘上的清单：确认读过才能写（读失败时 bad 已经挡住写盘）
  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    return Save.sync().catch(function () {});
  }
  // 写盘：只序列化当前快照，前一次写完再写下一次；期间有新请求就合并成一次
  let queued = false;
  function persist() {
    if (queued) return tail;
    if (bad) return Promise.reject(stale());
    queued = true;
    tail = tail.then(function () {
      queued = false;
      if (bad) throw stale();
      const text = JSON.stringify(idx);
      return store().put(KN.index, text);
    }).catch(function (e) {
      queued = false;
      bad = bad || fail(e);
      throw e;
    });
    return tail;
  }
  // 先确认清单已读进内存，再做局部增删：否则首个写入会把磁盘上的清单整个换掉
  function update(mutate) {
    return ensureLoaded().then(function () {
      mutate();
      return persist();
    });
  }

  // ---------------- 槽位与存档文件 ----------------
  function now() { lastAt = Math.max(Date.now(), lastAt + 1); return lastAt; }
  // 文件名对用户可见：Auto_Guangzhou_20261025_1500.mksave / Player_Guangzhou_20261025_1500.mksave
  function safeName(s) {
    const t = String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '')
      .replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, 16).join('') || '存档';
  }
  function stamp(at) {
    const d = new Date(at);
    const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function mapLabel(mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    return safeName((mp && mp.name) || mapId || '存档').replace(/\s/g, '_');
  }
  function keyHead(kind, mapId) {
    return (kind === 'auto' ? 'Auto_' : 'Player_') + mapLabel(mapId) + '_';
  }
  // 时间戳精确到秒：撞名（同一秒存两次）往后挪一秒，文件名与真实时间不会差太远
  function newKey(kind, mapId, at) {
    const used = {};
    for (const s of slots()) used[s.key] = 1;
    for (const k in idx.slots) used[idx.slots[k].key] = 1;
    let ms = at || now();
    for (;;) {
      const key = keyHead(kind, mapId) + stamp(ms) + KN.file;
      if (!used[key]) { lastAt = Math.max(lastAt, ms); return key; }
      ms += 1000;
    }
  }
  function slots() {
    return Object.keys(idx.slots).map(function (k) { return idx.slots[k]; }).filter(function (s) {
      return s && typeof s === 'object' && typeof s.slotId === 'string' && typeof s.gameId === 'string' && typeof s.key === 'string';
    });
  }
  function gameOf(gameId) {
    const list = slots().filter(function (s) { return s.gameId === gameId; });
    if (!list.length) return null;
    let g = null;
    for (const s of list) if (!g || s.savedAt > g.updatedAt) g = { gameId: s.gameId, name: s.name, mode: s.mode, map: s.map, createdAt: s.createdAt, updatedAt: s.savedAt };
    if (!g) return null;
    g.createdAt = list.reduce(function (a, s) { return Math.min(a, s.createdAt || s.savedAt); }, g.createdAt || g.updatedAt);
    return g;
  }
  function putSlot(meta) {
    idx.slots[meta.slotId] = meta;
    return persist();
  }
  function dropSlot(slotId) {
    if (!idx.slots[slotId]) return Promise.resolve();
    const key = idx.slots[slotId].key;
    return update(function () { delete idx.slots[slotId]; }).then(function () { return store().del(key); });
  }

  // ---------------- 存档文件（信封 + 校验） ----------------
  function envelope(payload, at) {
    const body = JSON.stringify(payload);
    return { format: CFG.SAVE_FORMAT, version: VERSION, gameVersion: CFG.GAME_VERSION, savedAt: at, checksum: U.fnv(body), body: body };
  }
  function decode(text) {
    const r = parseJSON(text);
    if (r.e) throw new Error('文件不是有效的存档（JSON 解析失败）');
    const env = r.v;
    if (!env || env.format !== CFG.SAVE_FORMAT) throw new Error('文件格式不正确：不是《城市与地铁社区版》存档');
    if (typeof env.version !== 'number' || env.version > VERSION) throw new Error('存档版本（' + env.version + '）高于当前游戏支持的版本（' + VERSION + '），无法导入');
    if (env.version < MIN_VERSION) throw new Error('该存档来自 1.0 版（旧示意地图），1.1 版起改用真实地理，旧地图数据无法对应，请开始新游戏');
    if (typeof env.body !== 'string' || U.fnv(env.body) !== env.checksum) throw new Error('存档校验失败：文件可能已损坏或被修改');
    const p = parseJSON(env.body);
    if (p.e) throw new Error('存档内容损坏');
    return { env: env, payload: migrate(p.v) };
  }
  function migrate(p) {
    if (!p || !p.meta || !p.clock || !p.city || !p.net || !p.econ || !p.tasks) throw new Error('存档缺少必要数据');
    const mp = CM.MAPS && CM.MAPS[p.meta.map || 'gz'];
    if (!mp) throw new Error('存档使用的地图「' + p.meta.map + '」在当前版本中不存在');
    const mv = p.meta.mapVersion || 1;
    if (mv > mp.mapVersion) throw new Error('存档使用的「' + mp.name + '」地图数据为第 ' + mv + ' 版，高于当前游戏的第 ' + mp.mapVersion + ' 版，请更新游戏后再载入');
    if (mv < (mp.minVersion || 1)) throw new Error('存档的「' + mp.name + '」地图数据版本（第 ' + mv + ' 版）过旧，当前版本无法兼容');
    if (mv < mp.mapVersion) {
      if (!mp.migrate) throw new Error('「' + mp.name + '」地图数据已从第 ' + mv + ' 版更新到第 ' + mp.mapVersion + ' 版，且没有可用的迁移方法');
      try { mp.migrate(p, mv); p.meta.mapVersion = mp.mapVersion; } catch (e) { throw new Error('存档迁移失败（' + fail(e) + '），原存档未改动'); }
    }
    const N = mp.cfg.W * mp.cfg.H;
    for (const k of MAP_KEYS) {
      const a = p.city[k];
      if (!a || !a.b || a.n !== N) throw new Error('城市数据不完整或尺寸不符');
    }
    return p;
  }
  function pick(payload, env) {
    const m = payload.meta, c = payload.clock;
    return {
      gameId: m.gameId, name: m.name, mode: m.mode, map: m.map || 'gz', scenario: m.scenario || '',
      createdAt: m.createdAt || 0, date: [c.y, c.m, c.d], savedAt: env.savedAt,
      stations: Object.keys((payload.net && payload.net.stations) || {}).length,
      funds: payload.econ && payload.econ.mode !== 'free' ? payload.econ.funds : null,
    };
  }

  // ---------------- 对外的接口 ----------------
  const Save = {};

  // 外壳的标志由 Python 在窗口 loaded 后注入，一定晚于本脚本执行。
  // 网页版没有外壳、也就不会有这个标志，所以用「有没有 pywebview 或桌面事件」来判断要不要等：
  // 等不到就按网页版走，最长 1.5 秒；等到了立刻继续
  function waitDesk() {
    if (desk()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        window.removeEventListener('pywebviewready', onReady);
        window.removeEventListener('__cmDesktopReady', onReady);
        resolve(v);
      };
      const onReady = function () { if (desk()) finish(true); };
      window.addEventListener('pywebviewready', onReady);
      window.addEventListener('__cmDesktopReady', onReady);
      const tick = function (left) {
        if (done) return;
        if (desk()) return finish(true);
        if (left <= 0) return finish(false);
        setTimeout(function () { tick(left - 50); }, 50);
      };
      tick(2500);
    });
  }

  let newest = null;
  let lastErr = '';
  function refreshLatest() {
    if (!desk()) return Promise.resolve(null);
    return deskCall('save_latest', [false]).then(function (r) {
      newest = r && r.ok && r.slot ? r.slot : null;
      lastErr = r && !r.ok ? ((r && r.error) || '读取最新存档失败') : '';
      return newest;
    }, function (e) { lastErr = fail(e); return null; });
  }
  Save.newestError = function () { return lastErr; };
  Save.newest = function () { return newest; };
  // 写完存档后刷新「最新」结论：写盘这一侧最清楚刚存的是哪份
  Save.refresh = function () { return refreshLatest(); };

  Save.init = function () {
    // 网页版没有 pywebview，直接走本地存储；桌面版等标志就位再判断
    return waitDesk().then(function (isDesk) {
      if (!isDesk) return Save.sync();
      return deskCall('save_index_get', []).then(function (r) {
        loaded = true;
        // 清单读不出来（损坏、权限、目录被占）：记下原因并禁止写盘，等用户点「修复存档清单」
        if (!r || !r.ok) { bad = (r && r.error) || '读取存档清单失败'; throw new Error(bad); }
        // 外壳在同一次扫描里一并给出了「哪份最新」，主页面和继续游戏都用这条结论
        if (r.latest) newest = r.latest;
        const n = r.index ? norm(r.index) : null;
        if (r.index && !n) { bad = '清单内容已损坏（不是合法的存档清单）'; throw new Error(bad); }
        if (n) { idx = n; bad = ''; return idx; }
        // 清单还不存在：按存档目录里的文件登记一份
        return Save.reload();
      });
    });
  };
  // 重新从存储读清单（外部改过存档目录、或怀疑内存副本与磁盘不一致时）
  Save.sync = function () {
    return loadIndex().then(function (n) { idx = n; bad = ''; return idx; }, function (e) { bad = fail(e); throw e; });
  };
  // 外壳按存档目录里的文件重新登记清单（只登记，不删任何存档）。
  // 重建出来的若是一份空清单，说明目录里没有任何存档文件，直接当空清单用，不算失败
  Save.reload = function () {
    if (!desk()) return Save.sync();
    return deskCall('save_rebuild', []).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '重建存档清单失败');
      const n = norm(r.index) || (r.count === 0 ? EMPTY() : null);
      if (!n) throw new Error('重建后的清单格式不对');
      idx = n; bad = '';
      if (!r.count) newest = null;
      else if (newest && !idx.slots[newest.slotId]) newest = null;
      return idx;
    });
  };
  Save.indexOk = function () { return !bad; };
  Save.backend = function () { return store().label(); };
  Save.isDesktop = desk;
  Save.available = function () {
    if (desk()) return true;
    try { const k = KN.index + '.t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  };

  // 主页面要显示的「继续游戏」信息：外壳扫过一次存档目录给出结论，之后每写一份存档就地更新；
  // 内存里没有结论时才去问一次外壳，避免主页面空着
  Save.resume = function () {
    if (!desk()) return Save.latest();
    if (newest && idx.slots[newest.slotId]) return newest;
    const own = Save.latest();
    if (own) return own;
    return newest;
  };
  Save.refreshLatest = refreshLatest;
  Save.list = function (mapId) {
    const byGame = Object.create(null);
    for (const s of slots()) {
      if (mapId && s.map !== mapId) continue;
      (byGame[s.gameId] || (byGame[s.gameId] = [])).push(s);
    }
    const out = [];
    for (const id in byGame) {
      const list = byGame[id].sort(function (a, b) { return b.savedAt - a.savedAt; });
      const g = gameOf(id);
      if (!g) continue;
      out.push(Object.assign(g, { slots: list, latest: list[0].savedAt }));
    }
    out.sort(function (a, b) { return b.latest - a.latest; });
    return out;
  };
  Save.latest = function (mapId) { const g = Save.list(mapId)[0]; return g ? g.slots[0] : null; };
  Save.hasSlot = function (slotId) { return !!(slotId && idx.slots[slotId]); };
  Save.slot = function (slotId) { return idx.slots[slotId] || null; };
  Save.usage = function () { return slots().reduce(function (n, s) { return n + (s.size || 0); }, 0); };
  Save.flush = function () { return tail.then(noop, noop); };
  Save.flushing = function () { return queued; };
  Save.describeFailure = function () { return bad ? '读取存档清单失败（' + bad + '），存档文件仍在，可用「修复存档清单」重新登记' : ''; };
  Save.dir = function () { return desk() ? deskCall('save_dir', []).then(function (r) { return (r && r.dir) || ''; }, function () { return ''; }) : Promise.resolve(''); };

  // kind：'auto' | 'manual'。opts：{ slotId（覆盖指定槽）, label, backup（不计入上限）}
  Save.save = function (game, kind, opts) {
    opts = Object.assign({}, opts);
    let payload;
    try { payload = game.serialize(); } catch (e) { return Promise.reject(new Error('序列化失败：' + fail(e))); }
    return writeSlot({
      payload: payload, kind: kind, slotId: opts.slotId || null, label: opts.label,
      backup: !!opts.backup, raw: opts.raw || null,
    }).catch(function (e) { return { ok: false, error: fail(e) }; });
  };
  // raw：直接落盘的存档文件文本（升级前备份用，保证与升级前的原档逐字节一致）
  async function writeSlot(o) {
    await ensureLoaded();
    const payload = o.payload;
    const base = pick(payload, envelope(payload, now()));
    // 只认「已经有记录」的槽位，指向不存在的槽位当新建处理
    let slotId = o.slotId && idx.slots[o.slotId] ? o.slotId : '';
    const target = slotId ? idx.slots[slotId] : null;
    if (target && target.gameId !== base.gameId) throw new Error('不能覆盖其他进度的存档');
    if (target && target.kind !== o.kind && o.kind !== 'backup' && !o.backup) throw new Error('不能把自动存档覆盖成手动存档');
    // 槽位与类型写进正文：重建清单时按文件自身登记，不依赖清单是否还在
    if (o.kind !== 'backup') slotId = slotId || newSlotId(base.gameId, o.kind);
    if (o.kind !== 'backup') payload.meta.slotId = slotId;
    payload.meta.kind = o.kind;
    const env = envelope(payload, now());
    const text = o.raw || JSON.stringify(env);
    const meta = Object.assign(pick(payload, env), {
      kind: o.kind, label: o.label || KIND_LABEL[o.kind] || '存档', size: text.length,
      key: newKey(o.kind, base.map, env.savedAt),
    });
    meta.slotId = slotId;
    const old = idx.slots[slotId] || null;
    // 先按上限腾位：写满时只删最旧的一份，新存档落盘后才有资格留下
    const limit = o.kind === 'auto' ? CFG.saves.maxAuto : CFG.saves.maxManual;
    const evict = o.kind === 'backup' ? [] : oldest(o.kind, limit, 1);
    await store().put(meta.key, text);
    try {
      await update(function () {
        if (slotId) idx.slots[slotId] = meta;
        for (const s of evict) if (s.slotId !== slotId) delete idx.slots[s.slotId];
      });
    } catch (e) { await store().del(meta.key); throw e; }
    const gone = (old && old.key && old.key !== meta.key ? [old.key] : [])
      .concat(evict.filter(function (s) { return s.slotId !== slotId; }).map(function (s) { return s.key; }));
    await Promise.all(gone.map(function (k) { return store().del(k); }));
    // 刚写好的这份就是最新：主页面「继续游戏」用的就是它，不必再问一次外壳
    if (o.kind !== 'backup' && (!newest || meta.savedAt >= (newest.savedAt || 0))) { newest = meta; lastErr = ''; }
    return { ok: true, slotId: slotId, savedAt: meta.savedAt, size: meta.size, removed: gone.length };
  }
  function newSlotId(gameId, kind) {
    return gameId + (kind === 'auto' ? '.a' : '.m') + now().toString(36) + (++seq).toString(36);
  }
  // 该类型最旧的 n 份（跨进度算：上限是磁盘空间口径，不是进度口径）
  function oldest(kind, limit, n) {
    const all = slots().filter(function (s) {
      return kind === 'auto' ? s.kind === 'auto' : (s.kind !== 'auto' && s.kind !== 'backup');
    }).sort(function (a, b) { return a.savedAt - b.savedAt; });
    return all.length >= limit ? all.slice(0, n) : [];
  }

  Save.load = function (slotId) {
    const meta = idx.slots[slotId];
    if (!meta) return Promise.reject(new Error(bad ? '读取存档清单失败（' + bad + '），现在只能看到空清单，存档文件应该还在，可点「修复存档清单」找回' : '存档不存在'));
    return store().get(meta.key).then(function (text) {
      if (!text) return Promise.reject(new Error('存档文件丢失：' + meta.label + ' 指向的 ' + meta.key + ' 不在存档目录里'));
      return decode(text);
    }, function (e) {
      return Promise.reject(new Error('读取存档文件失败：' + fail(e) + '（' + meta.key + '）'));
    }).then(function (r) { return finishLoad(r, meta); });
  };
  // 最新存档：桌面版由外壳扫描存档目录挑出最新的一份并连正文一起返回，前端不读清单也不排序
  Save.loadLatest = function () {
    if (!desk()) {
      const m = Save.latest();
      if (!m) return Promise.reject(new Error('还没有存档'));
      return Save.load(m.slotId);
    }
    return deskCall('save_latest', [true]).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '读取最新存档失败');
      if (!r.slot) throw new Error('还没有存档');
      if (typeof r.text !== 'string' || !r.text) throw new Error('存档文件丢失：' + r.slot.key);
      let d;
      try { d = decode(r.text); } catch (e) { throw new Error(fail(e) + '（' + r.slot.key + '）'); }
      return finishLoad(d, r.slot);
    });
  };
  function finishLoad(r, meta) {
    r.payload.meta.name = meta.name || r.payload.meta.name;
    r.meta = meta;
    if (meta && meta.slotId && !(newest && newest.slotId === meta.slotId)) newest = meta;
    return upgradeGuard(r, meta).then(function (extra) { return Object.assign(r.payload, extra); });
  }
  // 旧交通模型的存档（v1.8 及更早）在升级前先另存一份原档；备份失败时仍可载入但不自动保存（见 main.js）
  function upgradeGuard(r, meta) {
    const tv = (r.payload.traffic && r.payload.traffic.v) || 1;
    if (tv >= (CFG.TRAFFIC_MODEL || 1) || meta.kind === 'backup') return Promise.resolve({});
    const slotId = meta.gameId + '.bk' + (r.env.savedAt || meta.savedAt || 0);
    if (idx.slots[slotId]) return Promise.resolve({ __backupSlot: slotId });
    return writeSlot({
      payload: r.payload, kind: 'backup', slotId: slotId, raw: JSON.stringify(r.env),
      label: '升级前备份（v' + ((r.payload.meta && r.payload.meta.gameVersion) || r.env.gameVersion || '1.8.0') + '）',
    }).then(function (res) {
      return res.ok ? { __backupSlot: res.slotId } : { __backupFailed: res.error || '未知错误' };
    }, function (e) { return { __backupFailed: fail(e) }; });
  }

  Save.remove = function (slotId) {
    if (newest && newest.slotId === slotId) newest = null;
    return dropSlot(slotId);
  };
  Save.removeGame = function (gameId) {
    const keys = slots().filter(function (s) { return s.gameId === gameId; }).map(function (s) { return s.key; });
    if (newest && newest.gameId === gameId) newest = null;
    if (!keys.length) return Promise.resolve();
    return update(function () {
      for (const k in idx.slots) if (idx.slots[k].gameId === gameId) delete idx.slots[k];
    }).then(function () { return Promise.all(keys.map(function (k) { return store().del(k); })); });
  };
  Save.rename = function (gameId, name) {
    return update(function () {
      for (const k in idx.slots) if (idx.slots[k].gameId === gameId) idx.slots[k].name = name;
    });
  };

  Save.fileName = function (meta) {
    const head = keyHead((meta && meta.kind) || 'manual', (meta && meta.map) || 'gz');
    return head + stamp(meta && meta.savedAt ? meta.savedAt : Date.now()) + KN.file;
  };
  Save.download = function (text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  };
  Save.exportSlot = function (slotId) {
    const meta = idx.slots[slotId];
    if (!meta) return Promise.reject(new Error('存档不存在'));
    return store().get(meta.key).then(function (text) {
      if (!text) throw new Error('存档文件丢失：' + meta.key);
      return CM.desktop.exportJSON(text, Save.fileName(meta));
    }, function (e) {
      throw new Error('读取存档文件失败：' + fail(e) + '（' + meta.key + '）');
    });
  };
  Save.exportGame = function (game) {
    const payload = game.serialize();
    return CM.desktop.exportJSON(JSON.stringify(envelope(payload, now())), Save.fileName(pick(payload, { savedAt: now() })));
  };

  // 导入：校验通过后作为新的手动存档加入，不覆盖已有进度
  Save.importText = function (text) {
    let r;
    try { r = decode(text); } catch (e) { return Promise.reject(e); }
    return (async function () {
      await ensureLoaded();
      const p = r.payload;
      let gameId = p.meta.gameId, name = p.meta.name || '导入的进度';
      if (!gameId || gameOf(gameId)) {
        gameId = U.uid('g');
        name = name + '（导入）';
        p.meta.gameId = gameId;
        p.meta.name = name;
      }
      const slotId = newSlotId(gameId, 'manual');
      const env = envelope(p, now());
      const text2 = JSON.stringify(envelope(Object.assign(p, { meta: Object.assign(p.meta, { slotId: slotId, kind: 'manual' }) }), env.savedAt));
      const meta = Object.assign(pick(p, env), {
        slotId: slotId, kind: 'manual', label: '导入的存档',
        size: text2.length, key: newKey('manual', p.meta.map, env.savedAt),
      });
      const evict = oldest('manual', CFG.saves.maxManual, 1);
      await store().put(meta.key, text2);
      try {
        await update(function () {
          idx.slots[meta.slotId] = meta;
          for (const s of evict) if (s.slotId !== meta.slotId) delete idx.slots[s.slotId];
        });
      } catch (e) { await store().del(meta.key); throw e; }
      await Promise.all(evict.filter(function (s) { return s.slotId !== meta.slotId; })
        .map(function (s) { return store().del(s.key); }));
      return { ok: true, slotId: meta.slotId, gameId: gameId, name: name, map: meta.map, size: meta.size };
    })();
  };

  CM.Save = Save;
})(window.CM);
