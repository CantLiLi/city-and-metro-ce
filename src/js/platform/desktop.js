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
  const info = { isDesktop: isDesktop, call: call, name: '城市与地铁社区版', version: '' };
  CM.desktop = info;

  info.exportJSON = function (text, filename) {
    if (!isDesktop()) { CM.Save.download(text, filename); return Promise.resolve('download'); }
    return call('choose_save_file', ['save']).then(function (path) {
      if (!path) return 'cancel';
      return call('write_export_file', [path, text]).then(function (r) {
        if (r && r.ok) return 'saved';
        throw new Error((r && r.error) || '写入文件失败');
      });
    });
  };

  info.importJSON = function () {
    if (!isDesktop()) return Promise.resolve(null);
    return call('choose_save_file', ['open']).then(function (path) {
      if (!path) return null;
      return call('read_import_file', [path]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '读取文件失败');
        return { text: r.text, name: String(path).split(/[\\/]/).pop() };
      });
    });
  };

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
  // 由外壳关闭窗口：外壳会先等 __cmDesktopClose 把进度写完再销毁窗口
  info.quit = function () {
    if (!isDesktop()) return Promise.resolve(false);
    return call('quit_app').then(function (r) { return !!(r && r.ok); }, function () { return false; });
  };
})(window.CM);
