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
  const info = { isDesktop: isDesktop, call: call, name: '城市与地铁', version: '' };
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
  info.openDoc = function (name) { return isDesktop() ? call('open_doc', [name]) : Promise.reject(new Error('仅桌面版可用')); };
  info.openExternal = function (url) { return isDesktop() ? call('open_external', [url]) : Promise.resolve(false); };
})(window.CM);
