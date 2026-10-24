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
  let acc = 0, lowNow = 0;   // acc：上次出样本到现在累计的帧时间
  // 1% Low：只看最近 LOW_WIN 秒内真正画出来的帧（超过 LOW_STALL 的按停顿丢弃），
  // 取其中最慢的 1% 帧的平均帧时间换算帧率
  const LOW_WIN = 3, LOW_STALL = 250, LOW_N_MAX = 2048;
  const lowMs = new Float32Array(LOW_N_MAX);
  let lowPos = 0, lowLen = 0;
  function lowReset() { lowPos = 0; lowLen = 0; }
  function lowPush(ms) {
    if (!(ms > 0) || ms > LOW_STALL) return;
    lowMs[lowPos] = ms; lowPos = (lowPos + 1) % LOW_N_MAX;
    if (lowLen < LOW_N_MAX) lowLen++;
  }
  function lowNewest(n) { return lowMs[(lowPos - n + LOW_N_MAX) % LOW_N_MAX]; }
  // 窗口按时间取：从最新一帧往回累到 LOW_WIN 秒为止，返回这段时间的帧数与总耗时
  function lowWindow() {
    let sum = 0, n = 0;
    while (n < lowLen && (sum === 0 || sum + lowNewest(n + 1) <= LOW_WIN * 1000)) { n++; sum += lowNewest(n); }
    return { n: n, ms: sum };
  }
  function lowValue() {
    const w = lowWindow();
    if (!w.n) return 0;
    const v = [];
    for (let i = 1; i <= w.n; i++) v.push(lowNewest(i));
    v.sort(function (a, b) { return b - a; });
    const k = Math.max(1, Math.round(v.length * 0.01));
    let sum = 0;
    for (let i = 0; i < k; i++) sum += v[i];
    return 1000 / (sum / k);
  }
  function pushSample(fps) {
    hist.push(fps);
    if (hist.length > SPARK_N) hist.shift();
    if (lowWindow().n >= 30) {   // 帧数太少时 1% 只取到一两帧，曲线上会是一串毛刺，攒够再画
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
    acc = 0;
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
    // 帧率与 1% Low 都按帧耗时算；主循环没画帧的那段（空闲降载）不是「一帧慢」，不计进去
    if ((on('monFps') || on('monLow')) && !(CM.Idle && (CM.Idle.light() || CM.Idle.asleep()))) {
      if (on('monLow')) lowPush(dt * 1000);
      const win = lowWindow();   // 只留最近 LOW_WIN 秒的帧
      acc += dt;
      if (win.ms && acc >= SPARK_DT - 1e-6) { pushSample(win.n / (win.ms / 1000)); acc = 0; }
    }
    // 进程占用（CPU/RAM/GPU）按时间刷新，跟降载无关
    if (paintAt >= 0.4) { paintAt = 0; paint(); }
    if (pollAt >= 1) { pollAt = 0; poll(); }
  }
  window.addEventListener('resize', function () { if (box.classList.contains('float')) applyPos(); });
  document.body.appendChild(box);
  S().on(function (k) { if (k === 'monitor' || k.indexOf('mon') === 0) refresh(); });
  CM.Monitor = { tick: tick, refresh: refresh };
  refresh();
})(window.CM);
