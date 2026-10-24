// 运行监控：右下角显示本软件的 CPU、内存、显卡占用与帧率。
// 桌面版向外壳取整棵进程树的数据，浏览器里拿不到进程占用，对应数值显示为 —
(function (CM) {
  const ROWS = [
    ['monCpu', 'cpu', 'CPU'], ['monRam', 'ram', 'RAM'], ['monGpu', 'gpu', 'GPU'],
    ['monFps', 'fps', 'FPS'], ['monLow', 'low', '1% FPS'],
  ];
  const box = document.createElement('div');
  box.id = 'perf';
  // 标题栏只在浮动小窗里出现：标题、拖动把手、收回右下角的按钮
  const bar = document.createElement('div');
  bar.className = 'perf-bar';
  const barTitle = document.createElement('span');
  barTitle.className = 'perf-title';
  barTitle.textContent = '性能监控';
  const btnClose = document.createElement('button');
  btnClose.className = 'perf-x';
  btnClose.textContent = '×';
  btnClose.title = '收回右下角';
  bar.appendChild(barTitle); bar.appendChild(btnClose);
  box.appendChild(bar);
  const cells = {};
  ROWS.forEach(function (r) {
    const k = document.createElement('span'); k.className = 'perf-k'; k.textContent = r[2];
    const v = document.createElement('span'); v.className = 'perf-v'; v.textContent = '—';
    const el = document.createElement('div'); el.className = 'perf-row';
    el.appendChild(k); el.appendChild(v);
    box.appendChild(el);
    cells[r[1]] = { row: el, val: v, key: r[0] };
  });
  // 曲线：帧率与 1% Low 各占一张小图，各自带标题、各自定纵轴
  const SPARK_H = 26, SPARK_N = 300, SPARK_DT = 0.1;
  function makeChart(cap) {
    const wrap = document.createElement('div');
    wrap.className = 'perf-chart';
    const t = document.createElement('span');
    t.className = 'perf-cap'; t.textContent = cap;
    const cv = document.createElement('canvas');
    cv.className = 'perf-spark';
    cv.style.height = SPARK_H + 'px';
    wrap.appendChild(t); wrap.appendChild(cv);
    return { wrap: wrap, cv: cv };
  }
  const chartFps = makeChart('FPS');
  const chartLow = makeChart('1% FPS');
  box.appendChild(chartFps.wrap);
  box.appendChild(chartLow.wrap);
  const hist = [], histLow = [];
  let acc = 0, frames = 0, lowNow = 0;   // 当前 0.1 秒窗口内累计的帧时间与帧数
  // 1% Low：逐帧帧时间按 1 ms 分档计数（超过 255 ms 并入最后一档），只保留最近 LOW_N 帧
  const LOW_N = 1200, LOW_BUCKETS = 256;
  const lowRing = new Uint16Array(LOW_N);
  const lowCount = new Uint32Array(LOW_BUCKETS);
  let lowPos = 0, lowLen = 0;
  function lowReset() { lowCount.fill(0); lowPos = 0; lowLen = 0; }
  function lowPush(ms) {
    const b = Math.min(LOW_BUCKETS - 1, Math.max(0, Math.round(ms)));
    if (lowLen === LOW_N) lowCount[lowRing[lowPos]]--;
    else lowLen++;
    lowRing[lowPos] = b; lowCount[b]++;
    lowPos = (lowPos + 1) % LOW_N;
  }
  // 最慢的 1% 帧的平均帧时间换算成帧率（没有数据时返回 0）
  function lowValue() {
    if (!lowLen) return 0;
    const k = Math.max(1, Math.round(lowLen * 0.01));
    let need = k, sum = 0;
    for (let b = LOW_BUCKETS - 1; b >= 0 && need > 0; b--) {
      const n = lowCount[b];
      if (!n) continue;
      const take = Math.min(n, need);
      sum += take * (b + 0.5);
      need -= take;
    }
    return 1000 / (sum / k);
  }
  function pushSample(fps) {
    hist.push(fps);
    if (hist.length > SPARK_N) hist.shift();
    if (lowLen >= 60) {   // 帧数太少时 1% 只取到一两帧，曲线上会是一串毛刺，攒够再画
      lowNow = lowValue();
      histLow.push(lowNow);
      if (histLow.length > SPARK_N) histLow.shift();
    }
    drawAll();
  }
  function drawSpark(cv, data, color, fill) {
    const cssW = cv.clientWidth || 96;
    const zoom = (cv.getBoundingClientRect().width / cssW) || 1;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * zoom);
    const W = Math.max(1, Math.round(cssW * dpr)), H = Math.max(1, Math.round(SPARK_H * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, W, H);
    c.lineWidth = Math.max(1, dpr);
    c.setLineDash([2 * dpr, 2 * dpr]);
    c.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    if (!data.length) {   // 还没有采样：先摆一条底线，让空曲线也有个样子
      c.beginPath(); c.moveTo(0, H - 0.5); c.lineTo(W, H - 0.5); c.stroke();
      return;
    }
    let peak = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > peak) peak = data[i];
    const top = Math.max(60, Math.ceil(peak / 30) * 30);   // 纵轴上限：至少 60，按 30 的整数倍向上取
    const px = function (i) { return (i / (SPARK_N - 1)) * (W - 1); };
    const py = function (v) { return H - 1 - Math.min(1, v / top) * (H - 3); };
    const trace = function () {
      c.beginPath();
      c.moveTo(px(0), py(data[0]));
      for (let i = 1; i < data.length; i++) c.lineTo(px(i), py(data[i]));
    };
    c.beginPath(); c.moveTo(0, py(60) + 0.5); c.lineTo(W, py(60) + 0.5); c.stroke();
    c.setLineDash([]);
    c.lineJoin = 'round';
    if (fill) {
      trace();
      c.lineTo(px(data.length - 1), H);
      c.lineTo(px(0), H);
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    }
    trace();
    c.strokeStyle = color;
    c.stroke();
  }
  function drawAll() {
    if (on('monFps')) drawSpark(chartFps.cv, hist, 'rgba(150, 205, 255, 0.95)', 'rgba(150, 205, 255, 0.16)');
    if (on('monLow')) drawSpark(chartLow.cv, histLow, 'rgba(255, 190, 110, 0.95)', null);
  }
  const S = function () { return CM.Settings; };
  const on = function (k) { return !!(S().get('monitor') && S().get(k)); };
  // 浮动小窗：位置记在本地，拖动超出屏幕时收回来
  const POS_KEY = 'cm1.monpos';
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { pos = null; }
  function applyPos() {
    if (!pos) return;
    const r = box.getBoundingClientRect();
    if (!r.width) return;   // 还没显示出来，等下一次刷新再摆
    const z = (r.width / (box.offsetWidth || r.width)) || 1;
    const x = Math.max(0, Math.min(Math.max(0, window.innerWidth - r.width), pos.x));
    const y = Math.max(0, Math.min(Math.max(0, window.innerHeight - r.height), pos.y));
    box.style.left = (x / z) + 'px';
    box.style.top = (y / z) + 'px';
  }
  let drag = null;
  bar.addEventListener('pointerdown', function (e) {
    if (e.target === btnClose) return;
    const r = box.getBoundingClientRect();
    drag = {
      x0: e.clientX, y0: e.clientY, l0: r.left, t0: r.top, w: r.width, h: r.height,
      z: (r.width / (box.offsetWidth || r.width)) || 1,
    };
    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器没有指针捕获 */ }
    e.preventDefault();
  });
  bar.addEventListener('pointermove', function (e) {
    if (!drag) return;
    const x = Math.max(0, Math.min(Math.max(0, window.innerWidth - drag.w), drag.l0 + e.clientX - drag.x0));
    const y = Math.max(0, Math.min(Math.max(0, window.innerHeight - drag.h), drag.t0 + e.clientY - drag.y0));
    pos = { x: x, y: y };
    box.style.left = (x / drag.z) + 'px';
    box.style.top = (y / drag.z) + 'px';
  });
  const endDrag = function () {
    if (!drag) return;
    drag = null;
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (err) { /* 隐私模式写不进去就算了 */ }
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  btnClose.addEventListener('click', function () { S().set('monFloating', false); });
  let proc = null, polling = false, paintAt = 0, pollAt = 0;
  function visible() { return box.classList.contains('on'); }
  function refresh() {
    let any = false;
    for (const k in cells) {
      const show = on(cells[k].key);
      cells[k].row.classList.toggle('hide', !show);
      if (show) any = true;
    }
    chartFps.wrap.classList.toggle('hide', !on('monFps'));
    chartLow.wrap.classList.toggle('hide', !on('monLow'));
    box.classList.toggle('on', any);
    const floating = any && on('monFloating');
    box.classList.toggle('float', floating);
    if (floating) { if (!pos) pos = { x: 12, y: 12 }; applyPos(); }
    else { box.style.left = ''; box.style.top = ''; }
    acc = 0; frames = 0;
    if (!on('monFps') && !on('monLow')) { hist.length = 0; histLow.length = 0; lowNow = 0; lowReset(); }
    if (any) { paintAt = pollAt = 0; paint(); drawAll(); poll(); }
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
    cells.low.val.textContent = lowNow ? String(Math.round(lowNow)) : '—';
  }
  function tick(dt) {
    if (!visible()) return;
    paintAt += dt; pollAt += dt;
    if (on('monFps') || on('monLow')) {
      // 休眠时主循环只跑 1 帧/秒，那一帧会把曲线拉成谷底，这一段时间不采样
      if (CM.Idle && CM.Idle.asleep()) { acc = 0; frames = 0; }
      else {
        if (on('monLow')) lowPush(Math.min(999, dt * 1000));
        acc += dt; frames++;
        if (acc >= SPARK_DT - 1e-6) { pushSample(frames / acc); acc = 0; frames = 0; }
      }
    }
    if (paintAt >= 0.4) { paintAt = 0; paint(); }
    if (pollAt >= 1) { pollAt = 0; poll(); }
  }
  window.addEventListener('resize', function () { if (box.classList.contains('float')) applyPos(); });
  document.body.appendChild(box);
  S().on(function (k) { if (k === 'monitor' || k.indexOf('mon') === 0) refresh(); });
  CM.Monitor = { tick: tick, refresh: refresh };
  refresh();
})(window.CM);
