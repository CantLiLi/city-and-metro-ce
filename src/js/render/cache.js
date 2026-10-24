// 渲染派生数据的持久缓存：桌面版落在用户数据目录，网页版退回 IndexedDB。
// 只存能随时重建的数据（轨道装饰分段等），读写失败一律当未命中，不影响游戏。
(function (CM) {
  const VERSION = '1';
  const KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/;
  const ENTRY_MAX = 300000;   // 单条文本上限，超了直接不存
  const FLUSH_MS = 600;
  const BATCH = 24;   // 单次写回的条数
  const DB_NAME = 'cm-render-cache';
  let dbp = null;
  let pending = Object.create(null);
  let timer = 0;

  function valid(k) { return typeof k === 'string' && KEY_RE.test(k); }

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      if (!window.indexedDB) { res(null); return; }
      let rq;
      try { rq = window.indexedDB.open(DB_NAME, 1); } catch (e) { res(null); return; }
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = rq.onblocked = function () { res(null); };
    });
    return dbp;
  }

  function idbGet(db, keys) {
    return new Promise(function (res) {
      const out = {};
      let tx;
      try { tx = db.transaction('kv', 'readonly'); } catch (e) { res(out); return; }
      const st = tx.objectStore('kv');
      for (const k of keys) {
        const rq = st.get(k);
        rq.onsuccess = function () { if (typeof rq.result === 'string') out[k] = rq.result; };
      }
      tx.oncomplete = tx.onerror = tx.onabort = function () { res(out); };
    });
  }

  function idbPut(db, items) {
    try {
      const st = db.transaction('kv', 'readwrite').objectStore('kv');
      for (const k in items) st.put(items[k], k);
    } catch (e) { /* 存不下就算了 */ }
  }

  function desktop() {
    const d = CM.desktop;
    return d && d.isDesktop() ? d : null;
  }

  function getMany(keys) {
    const list = (keys || []).filter(valid);
    if (!list.length) return Promise.resolve({});
    const d = desktop();
    if (d && d.readCache) return d.readCache(list).then(function (m) { return m || {}; }, function () { return {}; });
    return openDb().then(function (db) { return db ? idbGet(db, list) : {}; }, function () { return {}; });
  }

  // 分批写回：一次别塞太多条，桥那边是逐个落盘，条数多了会让主线程等太久
  function flush() {
    timer = 0;
    const keys = Object.keys(pending);
    if (!keys.length) return;
    const items = Object.create(null);
    for (let i = 0; i < keys.length && i < BATCH; i++) { items[keys[i]] = pending[keys[i]]; delete pending[keys[i]]; }
    if (Object.keys(pending).length) timer = setTimeout(flush, FLUSH_MS);
    const d = desktop();
    if (d && d.writeCache) { d.writeCache(items); return; }
    openDb().then(function (db) { if (db) idbPut(db, items); });
  }

  function put(key, text) {
    if (!valid(key) || typeof text !== 'string' || text.length > ENTRY_MAX || text === pending[key]) return;
    pending[key] = text;
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  CM.Cache = { version: VERSION, getMany: getMany, put: put, flush: flush };
})(window.CM);
