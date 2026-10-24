// 运行监控：右下角显示本软件的 CPU、内存、显卡占用与帧率。
// 桌面版向外壳取整棵进程树的数据，浏览器里拿不到进程占用，对应数值显示为 —
(function (CM) {
  const ROWS = [['monCpu', 'cpu', 'CPU'], ['monRam', 'ram', 'RAM'], ['monGpu', 'gpu', 'GPU'], ['monFps', 'fps', 'FPS']];
  const box = document.createElement('div');
  box.id = 'perf';
  const cells = {};
  ROWS.forEach(function (r) {
    const k = document.createElement('span'); k.className = 'perf-k'; k.textContent = r[2];
    const v = document.createElement('span'); v.className = 'perf-v'; v.textContent = '—';
    const el = document.createElement('div'); el.className = 'perf-row';
    el.appendChild(k); el.appendChild(v);
    box.appendChild(el);
    cells[r[1]] = { row: el, val: v, key: r[0] };
  });
  const S = function () { return CM.Settings; };
  const on = function (k) { return !!(S().get('monitor') && S().get(k)); };
  let proc = null, polling = false, paintAt = 0, pollAt = 0;
  function visible() { return box.classList.contains('on'); }
  function refresh() {
    let any = false;
    for (const k in cells) {
      const show = on(cells[k].key);
      cells[k].row.classList.toggle('hide', !show);
      if (show) any = true;
    }
    box.classList.toggle('on', any);
    if (any) { paintAt = pollAt = 0; paint(); poll(); }
  }
  function poll() {
    if (polling || !CM.desktop || !CM.desktop.isDesktop()) return;
    if (!on('monCpu') && !on('monRam') && !on('monGpu')) return;
    polling = true;
    CM.desktop.call('perf_stats', [on('monGpu')]).then(function (r) { proc = r || null; }, function () { proc = null; })
      .then(function () { polling = false; });
  }
  function paint() {
    const d = proc || {};
    const fps = CM.R && CM.R.stats ? CM.R.stats.fps : 0;
    cells.cpu.val.textContent = d.cpu == null ? '—' : d.cpu + '%';
    cells.ram.val.textContent = d.ram == null ? '—' : (d.ram >= 1024 ? (d.ram / 1024).toFixed(1) + ' GB' : d.ram + ' MB');
    cells.gpu.val.textContent = d.gpu == null ? '—' : d.gpu + '%';
    cells.fps.val.textContent = String(Math.round(fps || 0));
  }
  function tick(dt) {
    if (!visible()) return;
    paintAt += dt; pollAt += dt;
    if (paintAt >= 0.4) { paintAt = 0; paint(); }
    if (pollAt >= 1) { pollAt = 0; poll(); }
  }
  document.body.appendChild(box);
  S().on(function (k) { if (k === 'monitor' || k.indexOf('mon') === 0) refresh(); });
  CM.Monitor = { tick: tick, refresh: refresh };
  refresh();
})(window.CM);
