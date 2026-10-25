'use strict';
// 本地存档（无账号）：桌面版由 Python 外壳把存档写进数据目录（saves/index.json + saves/slots/），
// 网页版保存在浏览器 IndexedDB（容量大，不可用时退回 localStorage）、索引在 localStorage。
// 支持多进度、自动/手动存档、文件导入导出（格式、版本、校验和检查）。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const P = CFG.saves.prefix;
  const IDX = P + 'index';

  // ---------------- 存储后端 ----------------
  // 桌面版：全部走桥，页面里不留存档数据；网页版：IndexedDB + localStorage
  const desk = function () { return !!(CM.desktop && CM.desktop.isDesktop()); };
  function deskCall(name, args) {
    if (!CM.desktop || typeof CM.desktop.saveCall !== 'function') return Promise.reject(new Error('桌面接口不可用'));
    return CM.desktop.saveCall(name, args);
  }
  function deskIndexError(r) { throw new Error((r && r.error) || '读取存档索引失败'); }

  let db = null, dbFailed = false;
  function openDB() {
    if (desk()) return Promise.resolve(null);
    if (db || dbFailed) return Promise.resolve(db);
    return new Promise(function (resolve) {
      let req;
      try { req = indexedDB.open('city-metro', 1); } catch (e) { dbFailed = true; resolve(null); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore('slots'); };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { dbFailed = true; resolve(null); };
      req.onblocked = function () { dbFailed = true; resolve(null); };
    });
  }
  function idbOp(mode, fn) {
    return openDB().then(function (d) {
      if (!d) throw new Error('IndexedDB 不可用');
      return new Promise(function (resolve, reject) {
        const tx = d.transaction('slots', mode);
        const st = tx.objectStore('slots');
        let result;
        const r = fn(st);
        if (r) r.onsuccess = function () { result = r.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写入失败')); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
      });
    });
  }
  const store = {
    put: function (key, str) {
      // 桌面版写完由读回校验（verify）确认，这里不做二次读
      if (desk()) return deskCall('save_slot_write', [key, str]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写入存档文件失败');
        return 'py';
      });
      return idbOp('readwrite', function (st) { return st.put(str, key); }).then(function () { return 'idb'; })
        .catch(function (e) { if (db) throw e; localStorage.setItem(key, str); return 'ls'; });
    },
    get: function (key, where) {
      if (desk()) return deskCall('save_slot_read', [key]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '读取存档文件失败');
        return r.text != null ? r.text : null;
      });
      if (where === 'ls') return Promise.resolve(localStorage.getItem(key));
      return idbOp('readonly', function (st) { return st.get(key); })
        .then(function (v) { return v != null ? v : localStorage.getItem(key); }, function () { return localStorage.getItem(key); });
    },
    del: function (key, where) {
      if (desk()) return deskCall('save_slot_delete', [key]).then(function () { /* 删不掉下次写入会覆盖 */ }, function () {});
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
      if (where === 'ls') return Promise.resolve();
      return idbOp('readwrite', function (st) { return st.delete(key); }).catch(function () { /* ignore */ });
    },
  };
  // 写入后校验：桌面版比对磁盘上的文本，网页版比对刚读回的文本
  function verify(key, str, where) {
    if (desk()) return deskCall('save_slot_verify', [key, str]).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    return store.get(key, where).then(function (back) { return back === str; }, function () { return false; });
  }

  function emptyIndex() { return { games: {}, slots: {} }; }
  // 索引：桌面版同步缓存一份（界面到处同步读列表），写入时串行刷到磁盘
  let pyIndex = null;
  // 清单没读出来时不能假装「没有存档」：那样下一次写入会把磁盘上完整的 index.json 覆盖成空的
  let idxFailed = '';
  function indexUnavailable() {
    const e = new Error('存档清单没有读取成功（' + idxFailed + '），为避免覆盖磁盘上的存档清单，本次不写入');
    e.noWrite = true;
    return e;
  }
  function readIndex() {
    if (desk()) return pyIndex || emptyIndex();
    try {
      const s = localStorage.getItem(IDX);
      if (!s) return emptyIndex();
      const o = JSON.parse(s);
      return o && o.games && o.slots ? o : emptyIndex();
    } catch (e) { return emptyIndex(); }
  }
  function normalizeIndex(o) {
    // 没有清单就是全新安装（外壳返回 index: null），那是真的没有存档，不算读失败
    if (!o || typeof o !== 'object') return emptyIndex();
    if (o.games && o.slots) return o;
    // 结构不对时按空处理，但不许写回去：磁盘上那份清单还可能有救
    idxFailed = idxFailed || '清单结构不正确';
    return emptyIndex();
  }
  let idxTail = Promise.resolve(), idxPending = 0;
  // 返回 Promise：桌面版索引落盘后 resolve，网页版立即 resolve
  function writeIndex(idx) {
    if (!desk()) { localStorage.setItem(IDX, JSON.stringify(idx)); return Promise.resolve(); }
    if (idxFailed) return Promise.reject(indexUnavailable());
    const copy = JSON.parse(JSON.stringify(idx));
    pyIndex = copy;
    idxPending++;
    const next = idxTail.catch(function () {}).then(function () {
      return deskCall('save_index_set', [copy]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写入存档索引失败');
      });
    });
    // 写盘失败时内存副本已经变了，磁盘却没变：留个标记，让界面去重读清单，
    // 不能一边显示新列表一边让磁盘留着旧的
    next.catch(function () { pyIndex = null; idxFailed = idxFailed || '写入存档清单失败'; });
    idxTail = next.then(function () { idxPending--; }, function () { idxPending--; });
    return next;
  }
  function errMsg(e) {
    if (!e) return '未知错误';
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) return '浏览器本地存储空间不足（可删除旧存档或导出备份后清理）';
    if (e.name === 'SecurityError') return '浏览器禁止本地存储（隐私模式或站点数据被阻止）';
    return e.message || String(e);
  }

  const Save = {};
  let writeTail = Promise.resolve(), writeSeq = 0, lastSavedAt = 0;
  function queueWrite(work) {
    const next = writeTail.then(work);
    writeTail = next.then(function () {}, function () {});
    return next;
  }
  function uniqueWriteId() { return U.uid('') + '-' + (++writeSeq).toString(36); }
  // 同一时钟刻度内也按写入顺序排序，确保自动轮换及「最近存档」正确。
  function savedAt(requested) { lastSavedAt = Math.max(Date.now(), requested || 0, lastSavedAt + 1); return lastSavedAt; }
  Save.init = function () {
    if (!desk()) return openDB();
    idxFailed = '';
    // 清单读不出来（损坏、丢失、桥还没注入）不算致命：外壳会先用上一版备份顶上，
    // 再不行就按 saves/slots 里的文件重建，只有这一切都失败才真的没有存档可列
    return deskCall('save_index_get', []).then(function (r) {
      if (!r || !r.ok) {
        idxFailed = (r && r.error) || '读取失败';
        pyIndex = emptyIndex();
        const e = new Error(idxFailed);
        e.soft = true;
        throw e;
      }
      pyIndex = normalizeIndex(r.index);
      // 清单能读但内容不全（文件比清单多）时照样自动补：只靠用户去点「修复」是不够的，
      // 重启后点「继续游戏」就该直接回到上次的存档
      return fillFromDir(r).then(function () { return readIndex(); });
    }, function (e) {
      // 桥还没注入或 IPC 失败：绝不能当成「没有存档」，否则下一次写入会覆盖磁盘清单
      idxFailed = errMsg(e);
      pyIndex = emptyIndex();
      const err = new Error('存档清单没有读到：' + idxFailed);
      err.soft = true;
      throw err;
    });
  };
  // 清单漏登记了存档文件（文件数比清单条数多）时自动按文件补齐，返回补齐后的清单。
  // 只在「重建结果比原来多」时才换掉内存里的清单，避免把用户手动删掉的记录又加回来
  function fillFromDir(r) {
    const before = Object.keys(readIndex().slots).length;
    const files = r && typeof r.files === 'number' ? r.files : 0;
    if (!(files > before)) return Promise.resolve(readIndex());
    // 重建期间用户可能已经存过一次档，写新清单会把那份刚存的记录挤掉：
    // 等排队中的写入都落盘，重建完再用磁盘上最新的清单覆盖内存
    return (Save.flush ? Save.flush() : Promise.resolve()).then(function () {
      return deskCall('save_index_rebuild', []);
    }).then(function (res) {
      const rebuilt = res && res.ok ? (Number(res.count) || 0) : 0;
      if (rebuilt <= before) return readIndex();
      idxFailed = '';
      return Save.sync().then(function (idx) {
        if (typeof console !== 'undefined') console.info('存档清单漏了存档，已按目录补齐：' + before + ' → ' + rebuilt);
        return idx;
      }, function () { return readIndex(); });
    }, function () { return readIndex(); });
  }
  // 存档位置说明：桌面版是数据目录，网页版是浏览器本地存储
  Save.backend = function () { return desk() ? '本地存档目录' : (db ? 'IndexedDB' : 'localStorage'); };
  Save.isDesktop = desk;
  Save.available = function () {
    if (desk()) return true;
    try { const k = P + '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  };
  Save.envelope = function (game) {
    const body = JSON.stringify(game.serialize());
    return { format: CFG.SAVE_FORMAT, version: CFG.SAVE_VERSION, gameVersion: CFG.GAME_VERSION, savedAt: Date.now(), checksum: U.fnv(body), body: body };
  };
  // kind: 'auto' | 'manual'；opts: { slotId（覆盖）, label }。返回 Promise<{ok, error, slotId}>
  Save.save = function (game, kind, opts) {
    opts = Object.assign({}, opts);
    let env;
    try { env = Save.envelope(game); } catch (e) { return Promise.resolve({ ok: false, error: '序列化失败：' + errMsg(e) }); }
    // 请求时即冻结快照及索引摘要；排队期间时间推进、切图或改名不改写本次快照。
    const snap = { id: game.id, name: game.name, mode: game.mode, map: game.mapId || 'gz', createdAt: game.createdAt,
      date: [game.clock.y, game.clock.m, game.clock.d], stations: game.compiled.stations.length, funds: game.econ.isFree() ? null : game.econ.funds };
    return queueWrite(function () {
      const idx = readIndex(); let slotId = opts.slotId;
      if (kind === 'auto') {
        const a1 = idx.slots[snap.id + '.a1'], a2 = idx.slots[snap.id + '.a2'];
        slotId = !a1 ? snap.id + '.a1' : (!a2 ? snap.id + '.a2' : (a1.savedAt <= a2.savedAt ? snap.id + '.a1' : snap.id + '.a2'));
      } else if (!slotId || !idx.slots[slotId]) {
        const manual = Object.values(idx.slots).filter(function (s) { return s.gameId === snap.id && s.kind === 'manual'; });
        if (manual.length >= CFG.saves.maxManual) return { ok: false, error: '该进度的手动存档已达上限（' + CFG.saves.maxManual + ' 个），请覆盖或删除旧存档' };
        slotId = snap.id + '.m' + uniqueWriteId();
      }
      const old = idx.slots[slotId];
      if (old && old.gameId !== snap.id) return { ok: false, error: '不能覆盖其他进度的存档' };
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId();
      env.savedAt = savedAt(env.savedAt); const str = JSON.stringify(env);
      const meta = { slotId: slotId, key: key, gameId: snap.id, kind: kind, label: opts.label || (kind === 'auto' ? '自动存档' : '手动存档'),
        date: snap.date, savedAt: env.savedAt, size: str.length, mode: snap.mode, name: snap.name, map: snap.map, stations: snap.stations, funds: snap.funds };
      // 写入串行化，使额度、轮换和覆盖均依据上一次已提交的索引；失败不覆盖旧数据。
      return store.put(key, str).then(function (where) {
        return verify(key, str, where).then(function (ok) {
          if (!ok) { store.del(key, where); return { ok: false, error: '写入后校验失败' }; }
          const idx2 = readIndex();
          idx2.games[snap.id] = { gameId: snap.id, name: snap.name, mode: snap.mode, map: snap.map, createdAt: snap.createdAt, updatedAt: env.savedAt };
          meta.store = where; idx2.slots[slotId] = meta;
          // 索引里放的是旧对象的副本：桌面版提交后索引会被替换成新副本
          const next = desk() ? JSON.parse(JSON.stringify(idx2)) : idx2;
          return writeIndex(next).then(function () {
            if (old && old.key && old.key !== key) store.del(old.key, old.store);
            return { ok: true, slotId: slotId, savedAt: env.savedAt, size: str.length };
          }, function (e) { store.del(key, where); return { ok: false, error: errMsg(e) }; });
        });
      });
    }).catch(function (e) { return { ok: false, error: errMsg(e) }; });
  };
  // mapId：只列出该地图的进度（不传则列出全部）
  Save.list = function (mapId) {
    const idx = readIndex();
    const games = Object.values(idx.games).filter(function (g) { return !mapId || (g.map || 'gz') === mapId; }).map(function (g) {
      const slots = Object.values(idx.slots).filter(function (s) { return s.gameId === g.gameId; }).sort(function (a, b) { return b.savedAt - a.savedAt; });
      return Object.assign({}, g, { slots: slots, latest: slots[0] ? slots[0].savedAt : 0 });
    }).filter(function (g) { return g.slots.length; });
    games.sort(function (a, b) { return b.latest - a.latest; });
    return games;
  };
  Save.latest = function (mapId) {
    const g = Save.list(mapId)[0];
    return g ? g.slots[0] : null;
  };
  // 槽位是否真的在清单里：界面据此判断「继续游戏」能不能点
  Save.hasSlot = function (slotId) { return !!(slotId && readIndex().slots[slotId]); };
  // 最近一个真实存在、且存档文件也在的槽位：清单里的记录指向不存在的文件时跳过
  Save.latestUsable = function (mapId) {
    for (const g of Save.list(mapId)) {
      for (const sl of g.slots) {
        if (readIndex().slots[sl.slotId]) return sl;
      }
    }
    return null;
  };
  Save.parseEnvelope = function (text) {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的存档（JSON 解析失败）'); }
    if (!env || env.format !== CFG.SAVE_FORMAT) throw new Error('文件格式不正确：不是《城市与地铁社区版》存档');
    if (typeof env.version !== 'number' || env.version > CFG.SAVE_VERSION) throw new Error('存档版本（' + env.version + '）高于当前游戏支持的版本（' + CFG.SAVE_VERSION + '），无法导入');
    if (env.version < CFG.SAVE_MIN_VERSION) throw new Error('该存档来自 1.0 版（旧示意地图）。1.1 版起改用真实的广州地理，旧存档的城市数据无法对应，请开始新游戏。');
    if (typeof env.body !== 'string' || U.fnv(env.body) !== env.checksum) throw new Error('存档校验失败：文件可能已损坏或被修改');
    let payload;
    try { payload = JSON.parse(env.body); } catch (e) { throw new Error('存档内容损坏'); }
    const ok = payload && payload.meta && payload.clock && payload.city && payload.net && payload.econ && payload.tasks;
    if (!ok) throw new Error('存档缺少必要数据');
    // 存档所属地图（1.4 版之前的存档都是广州）：按该地图的网格尺寸校验
    const mp = CM.MAPS && CM.MAPS[payload.meta.map || 'gz'];
    if (!mp) throw new Error('存档使用的地图「' + payload.meta.map + '」在当前版本中不存在');
    // 地图数据版本：缺省为 1（1.4 版及更早的广州 / 青湾存档）。存档版本高于当前地图数据时拒绝载入；
    // 低于当前版本时按地图登记的迁移函数处理（迁移只作用于解析出的副本，失败时原存档不受影响）
    const mv = payload.meta.mapVersion || 1;
    if (mv > mp.mapVersion) throw new Error('存档使用的「' + mp.name + '」地图数据为第 ' + mv + ' 版，高于当前游戏的第 ' + mp.mapVersion + ' 版，请更新游戏后再载入');
    if (mv < (mp.minVersion || 1)) throw new Error('存档的「' + mp.name + '」地图数据版本（第 ' + mv + ' 版）过旧，当前版本无法兼容');
    if (mv < mp.mapVersion) {
      if (!mp.migrate) throw new Error('「' + mp.name + '」地图数据已从第 ' + mv + ' 版更新到第 ' + mp.mapVersion + ' 版，且没有可用的迁移方法');
      try { mp.migrate(payload, mv); payload.meta.mapVersion = mp.mapVersion; } catch (e) { throw new Error('存档迁移失败（' + (e && e.message || e) + '），原存档未改动'); }
    }
    for (const k of ['pop', 'jobs', 'bh', 'taken', 'lu', 'street', 'urbanYear']) {
      const a = payload.city[k];
      if (!a || !a.b || a.n !== mp.cfg.W * mp.cfg.H) throw new Error('城市数据不完整或尺寸不符');
    }
    return { env: env, payload: payload };
  };
  function readSlotText(slotId) {
    const meta = readIndex().slots[slotId];
    const missing = function (m) {
      if (!m && idxFailed) return Promise.reject(new Error('存档清单没有读取成功（' + idxFailed + '），现在只能看到空清单。请在存档管理里点「刷新存档清单」后重试，你的存档文件应该还在'));
      if (m && idxFailed) return Promise.reject(new Error('存档清单没有读取成功（' + idxFailed + '），' + (m.label || m.slotId) + ' 的记录可能是旧的。请在存档管理里点「修复存档清单」后重试'));
      return Promise.reject(new Error(m ? '存档文件丢失：' + (m.label || m.slotId) + ' 记录指向的 ' + m.key + ' 不在存档目录里。可在「存档管理」导出其它存档，或用导入恢复备份' : '存档不存在'));
    };
    if (!meta) return missing(null);
    return store.get(meta.key, meta.store).then(function (text) {
      if (!text) return missing(meta);
      return { meta: meta, text: text };
    }, function (e) {
      // 读盘本身失败（权限、占用、桥出错）不能报成「存档不存在」
      return Promise.reject(new Error('读取存档文件失败：' + ((e && e.message) || e) + '（' + meta.key + '）'));
    });
  }
  // 进度重命名保存在索引中，不重写每个历史快照；读取与导出时将最新名称应用到副本。
  function parseSlot(r) {
    const parsed = Save.parseEnvelope(r.text);
    if (typeof r.meta.name === 'string' && parsed.payload.meta.name !== r.meta.name) {
      parsed.payload.meta.name = r.meta.name;
      parsed.env.body = JSON.stringify(parsed.payload);
      parsed.env.checksum = U.fnv(parsed.env.body);
    }
    return parsed;
  }
  // 载入：旧交通模型的存档（v1.8 及更早）在升级前先把原始存档另存为「升级前备份」（只建一次，不计入手动存档上限），
  // 备份失败时仍可载入，但不自动保存升级后的进度（见 main.js），原存档不受影响
  Save.load = function (slotId) {
    return readSlotText(slotId).then(function (r) {
      const p = parseSlot(r).payload;
      const tv = (p.traffic && p.traffic.v) || 1;
      if (tv >= (CFG.TRAFFIC_MODEL || 1) || r.meta.kind === 'backup') return p;
      return Save.backupBeforeUpgrade(r, p).then(function (res) {
        if (res.ok) p.__backupSlot = res.slotId; else p.__backupFailed = res.error || '未知错误';
        return p;
      });
    });
  };
  Save.backupBeforeUpgrade = function (r, payload) {
    let env = null; try { env = JSON.parse(r.text); } catch (e) { return Promise.resolve({ ok: false, error: '存档内容无法解析' }); }
    const meta = r.meta, from = (payload.meta && payload.meta.gameVersion) || env.gameVersion || '1.8.0';
    const slotId = meta.gameId + '.bk' + String(env.savedAt || meta.savedAt || 0);
    return queueWrite(function () {
      const idx = readIndex();
      if (idx.slots[slotId]) return { ok: true, slotId: slotId, existed: true };
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId(), text = r.text;
      return store.put(key, text).then(function (where) {
        return verify(key, text, where).then(function (ok) {
          if (!ok) { store.del(key, where); return { ok: false, error: '备份写入后校验失败' }; }
          const idx2 = readIndex();
          idx2.slots[slotId] = Object.assign({}, meta, { slotId: slotId, key: key, store: where, kind: 'backup', label: '升级前备份（v' + from + '）', savedAt: meta.savedAt, size: text.length });
          if (!idx2.games[meta.gameId]) idx2.games[meta.gameId] = { gameId: meta.gameId, name: meta.name, mode: meta.mode, map: meta.map, createdAt: payload.meta.createdAt, updatedAt: meta.savedAt };
          return writeIndex(desk() ? JSON.parse(JSON.stringify(idx2)) : idx2).then(function () { return { ok: true, slotId: slotId }; },
            function (e) { store.del(key, where); return { ok: false, error: errMsg(e) }; });
        });
      });
    }).catch(function (e) { return { ok: false, error: errMsg(e) }; });
  };
  Save.remove = function (slotId) {
    const idx = readIndex();
    const meta = idx.slots[slotId];
    if (!meta) return;
    delete idx.slots[slotId];
    if (!Object.values(idx.slots).some(function (s) { return s.gameId === meta.gameId; })) delete idx.games[meta.gameId];
    writeIndex(desk() ? JSON.parse(JSON.stringify(idx)) : idx);
    store.del(meta.key, meta.store);
  };
  Save.removeGame = function (gameId) {
    const idx = readIndex();
    for (const s of Object.values(idx.slots)) if (s.gameId === gameId) { delete idx.slots[s.slotId]; store.del(s.key, s.store); }
    delete idx.games[gameId];
    writeIndex(desk() ? JSON.parse(JSON.stringify(idx)) : idx);
  };
  Save.rename = function (gameId, name) {
    const idx = readIndex();
    if (!idx.games[gameId]) return;
    idx.games[gameId].name = name;
    for (const s of Object.values(idx.slots)) if (s.gameId === gameId) s.name = name;
    writeIndex(desk() ? JSON.parse(JSON.stringify(idx)) : idx);
  };
  Save.fileName = function (meta) {
    const d = meta.date || [0, 0];
    return '城市与地铁社区版_' + (meta.name || '存档').replace(/[\\/:*?"<>|]/g, '_') + '_' + d[0] + '年' + d[1] + '月.cmsave.json';
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
    return readSlotText(slotId).then(function (r) {
      return CM.desktop.exportJSON(JSON.stringify(parseSlot(r).env), Save.fileName(r.meta));
    });
  };
  Save.exportGame = function (game) {
    const env = Save.envelope(game);
    return CM.desktop.exportJSON(JSON.stringify(env), Save.fileName({ name: game.name, date: [game.clock.y, game.clock.m] }));
  };
  // 导入：校验通过后作为新的手动存档保存，不覆盖已有进度。返回 Promise
  Save.importText = function (text) {
    let r;
    try { r = Save.parseEnvelope(text); } catch (e) { return Promise.reject(e); }
    return queueWrite(function () {
      const idx = readIndex();
      const p = r.payload;
      let gameId = p.meta.gameId || U.uid('g'), name = p.meta.name || '导入的进度';
      if (idx.games[gameId]) { gameId = U.uid('g'); name = name + '（导入）'; p.meta.gameId = gameId; p.meta.name = name; }
      else p.meta.gameId = gameId;
      const body = JSON.stringify(p);
      const env = { format: CFG.SAVE_FORMAT, version: CFG.SAVE_VERSION, gameVersion: CFG.GAME_VERSION, savedAt: savedAt(), checksum: U.fnv(body), body: body };
      const str = JSON.stringify(env);
      const slotId = gameId + '.m' + uniqueWriteId();
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId();
      return store.put(key, str).then(function (where) {
        const idx2 = readIndex();
        idx2.games[gameId] = { gameId: gameId, name: name, mode: p.meta.mode, map: p.meta.map || 'gz', createdAt: p.meta.createdAt, updatedAt: env.savedAt };
        idx2.slots[slotId] = { slotId: slotId, key: key, store: where, gameId: gameId, kind: 'manual', label: '导入的存档', date: [p.clock.y, p.clock.m, p.clock.d], savedAt: env.savedAt, size: str.length, mode: p.meta.mode, map: p.meta.map || 'gz', name: name, stations: Object.keys(p.net.stations || {}).length, funds: p.econ.mode === 'free' ? null : p.econ.funds };
        return writeIndex(desk() ? JSON.parse(JSON.stringify(idx2)) : idx2).then(function () {
          return { slotId: slotId, gameId: gameId, name: name, map: p.meta.map || 'gz' };
        }, function (e) { store.del(key, where); throw new Error(errMsg(e)); });
      }, function (e) { throw new Error(errMsg(e)); });
    });
  };
  Save.usage = function () {
    let n = 0;
    for (const s of Object.values(readIndex().slots)) n += s.size || 0;
    return n;
  };
  // 等已排队的写入与索引落盘；删除、改名之后界面刷新列表前要等它
  Save.flush = function () { return idxTail.catch(function () {}); };
  Save.flushing = function () { return !!idxPending; };
  // 重新从磁盘读索引（外部改过存档目录、或怀疑内存副本与磁盘不一致时）
  Save.sync = function () {
    if (!desk()) return Promise.resolve(readIndex());
    return deskCall('save_index_get', []).then(function (r) {
      if (!r || !r.ok) deskIndexError(r);
      idxFailed = r && r.ok ? '' : ((r && r.error) || '读取失败');
      pyIndex = normalizeIndex(r.index);
      return pyIndex;
    }, function (e) { idxFailed = errMsg(e); return readIndex(); });
  };
  // 清单是否真正读到了：界面据此决定能不能写盘
  Save.indexOk = function () { return !desk() || (!!pyIndex && !idxFailed); };
  Save.dir = function () { return desk() ? deskCall('save_dir', []).then(function (r) { return (r && r.dir) || ''; }, function () { return ''; }) : Promise.resolve(''); };
  // 按存档目录里的文件重建清单：清单丢了或对不上时，用它是能把进度找回来的
  Save.rebuildIndex = function () {
    if (!desk()) return Promise.reject(new Error('网页版没有存档目录，无法重建清单'));
    return deskCall('save_index_rebuild', []).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '重建存档清单失败');
      idxFailed = '';
      return Save.sync();
    });
  };
  CM.Save = Save;
})(window.CM);
