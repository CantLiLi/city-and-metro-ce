// 桌面外壳（pywebview）适配层：浏览器里打开时全部走原来的网页逻辑
(function (CM) {
  function bridge() {
    const w = window.pywebview;
    return w && w.api ? w.api : null;
  }
  // 只认 Python 端在窗口 loaded 后注入的标志；pywebview 在没有 js_api 时也会建 window.pywebview.api
  const isDesktop = function () { return !!(window.__CM_DESKTOP__ && bridge()); };
  const call = function (name, args) {
    const api = bridge();
    if (!api || typeof api[name] !== 'function') return Promise.reject(new Error('桌面接口不可用'));
    return Promise.resolve(api[name].apply(api, args || []));
  };
  const info = { isDesktop: isDesktop, call: call, name: '城市与地铁社区版', version: '', platform: '' };
  CM.desktop = info;

  // 让 CSS 能按平台分支：安卓壳的 app_info() 回 platform: 'android'，桌面壳回对应系统名。
  // 只在 <html> 上打标记，浏览器里打开（没有壳）不打，网页版与 PC 布局完全不受影响
  info.platform = function () { return info._platform || ''; };
  info.detectPlatform = function () {
    if (!isDesktop()) return Promise.resolve('');
    return call('app_info').then(function (r) {
      const p = (r && r.platform) || '';
      info._platform = p;
      if (p) document.documentElement.setAttribute('data-plat', p);
      return p;
    }, function () { return ''; });
  };
  info.detectPlatform();
  // 外壳的注入晚于本脚本时靠事件补一次：桌面壳派 pywebviewready，安卓壳另派 __cmDesktopReady
  ['pywebviewready', '__cmDesktopReady'].forEach(function (ev) {
    window.addEventListener(ev, function () { info.detectPlatform(); });
  });

  // 取消返回 null；打不开对话框、读不了文件一律 throw，调用方才能提示出来
  info.exportJSON = function (text, filename) {
    if (!isDesktop()) { CM.Save.download(text, filename); return Promise.resolve('download'); }
    return call('export_to_file', [text, filename || '']).then(function (r) {
      if (!r || (!r.ok && !r.error)) return 'cancel';
      if (!r.ok) throw new Error(r.error);
      return 'saved';
    });
  };

  info.importJSON = function () {
    if (!isDesktop()) return Promise.resolve(null);
    return call('open_import_file').then(function (r) {
      if (!r || (!r.ok && !r.error)) return null;
      if (!r.ok) throw new Error(r.error);
      return { text: r.text, name: r.name || '' };
    });
  };

  // 存档：正文与清单都由外壳写进数据目录（见 js/platform/save.js）
  const SAVE_METHODS = {
    save_slot_write: 1, save_slot_read: 1, save_slot_verify: 1, save_slot_delete: 1,
    save_index_get: 1, save_rebuild: 1, save_index_rebuild: 1, save_dir: 1, save_latest: 1,
  };
  info.saveCall = function (name, args) {
    if (!isDesktop() || !SAVE_METHODS[name]) return Promise.reject(new Error('桌面接口不可用'));
    return call(name, args || []);
  };
  info.saveDir = function () { return isDesktop() ? call('save_dir') : Promise.resolve(null); };
  info.openDataDir = function () { return isDesktop() ? call('open_data_dir') : Promise.reject(new Error('仅桌面版可用')); };
  // 显卡模式：外壳在下次启动时按这个值给内核加参数（关闭 GPU 加速时走软件渲染）
  info.setGpu = function (on) {
    if (!isDesktop()) return Promise.resolve(false);
    return call('set_gpu', [!!on]).then(function (r) { return !!(r && r.ok); }, function () { return false; });
  };
  // 窗口方式：window 普通窗口 | max 窗口化全屏
  info.setWindowMode = function (mode) {
    if (!isDesktop()) return Promise.resolve(false);
    return call('set_window_mode', [String(mode)]).then(function (r) { return !!(r && r.ok); }, function () { return false; });
  };
  info.openDoc = function (name) { return isDesktop() ? call('open_doc', [name]) : Promise.reject(new Error('仅桌面版可用')); };
  info.openExternal = function (url) { return isDesktop() ? call('open_external', [url]) : Promise.resolve(false); };
  // 渲染派生数据的磁盘缓存（见 js/render/cache.js）：批量读一批键，批量写回
  info.readCache = function (keys) {
    if (!isDesktop()) return Promise.resolve(null);
    return call('cache_read', [keys]).then(function (r) { return r && r.ok ? r.items : null; }, function () { return null; });
  };
  info.writeCache = function (items) {
    if (!isDesktop()) return Promise.resolve(false);
    return call('cache_write', [items]).then(function (r) { return !!(r && r.ok); }, function () { return false; });
  };
  // 由外壳关闭窗口：外壳会先等 __cmDesktopClose 把进度写完再销毁窗口。
  // 调不到 quit_app（启动早期外壳接口还没注进网页）时也要退出：退到 window.close()，
  // pywebview 的窗口都走同一个关闭事件，macOS 上一样先写盘再关窗。
  // nativeClosePending 只放行「下一次」原生 close，避免退回 close 时又绕回 quit 形成死循环
  let nativeClosePending = false;
  const closeNative = function () {
    nativeClosePending = true;
    try { window.close(); } catch (e) { /* ignore */ }
  };
  info.quit = function () {
    if (!isDesktop()) return Promise.resolve(false);
    return Promise.resolve(call('quit_app')).then(function (r) {
      if (r && r.ok) return true;
      closeNative();
      return false;
    }, function () {
      closeNative();
      return false;
    });
  };
  // 桌面版里链接了窗口的网页会把 window.close 变成空操作：本地页面只有脚本自己开的才允许自关。
  // 接口没就绪时前端会退到 window.close()，所以接管它：外壳接不上也还有一条能走的路。
  // 只装一次壳，重复调用没有副作用（它每次都会重新判 isDesktop，标志到得晚也没关系）
  const nativeClose = window.close;
  const closeHooked = function () {
    if (nativeClosePending) { nativeClosePending = false; return nativeClose.apply(window, arguments); }
    if (!isDesktop()) return nativeClose.apply(window, arguments);
    info.quit();
  };
  info.overrideClose = function () {
    if (window.close !== closeHooked) window.close = closeHooked;
    return true;
  };
})(window.CM);
