'use strict';
// 启动与主循环
(function (CM) {
  const CFG = CM.CFG;
  const canvas = document.getElementById('map');
  const R = new CM.Renderer(canvas);
  const ui = new CM.UI(R);
  const tools = new CM.Tools(R, ui);
  ui.tools = tools;
  CM.R = R; CM.ui = ui; CM.tools = tools;
  CM.agents = new CM.Agents();
  CM.game = null;

  // 平滑切换：把当前画面复制到覆盖层上再淡出，新画面在下面重新绘制，避免地图与界面闪切
  let fadeT = null;
  function crossfade() {
    if (CM.Settings.reducedMotion() || !R.frame || !canvas.width || !canvas.height) return;
    const snap = document.createElement('canvas');
    snap.width = canvas.width; snap.height = canvas.height; snap.className = 'map-snap';
    try { snap.getContext('2d').drawImage(canvas, 0, 0); } catch (e) { return; }
    canvas.insertAdjacentElement('afterend', snap);
    setTimeout(function () { snap.style.opacity = '0'; }, 140);
    setTimeout(function () { snap.remove(); }, 900);
    const root = document.documentElement;
    root.classList.add('theme-fade'); clearTimeout(fadeT);
    fadeT = setTimeout(function () { root.classList.remove('theme-fade'); }, 700);
  }
  CM.crossfade = crossfade;
  // 浅色 / 深色主题：界面（CSS 变量）与地图（渲染主题）同步切换；选择由「设置」保存
  CM.setTheme = function (name) {
    name = name === 'dark' ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== name || R.themeName !== name) crossfade();
    document.documentElement.dataset.theme = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', name === 'dark' ? '#111925' : '#eaf1f7');
    if (R.themeName !== name) R.setTheme(name);
    if (CM.Stats && CM.Stats.isOpen()) CM.Stats.redraw();
  };
  CM.Settings.apply();

  // 开始界面背景：2012 年前后的城市与几条示意地铁线（真实车站位置）
  let preview = null, previewT = 0;
  function makePreview() {
    const city = new CM.City();
    city.generate(19900101, 2012);
    const M = CM.Metro, net = M.empty(), P = {}, byName = {};
    for (const p of CM.DATA.places) P[p[0]] = p;
    const LINES = [
      ['#e2382e', ['坑口', '花地湾', '芳村', '黄沙', '陈家祠', '西门口', '公园前', '农讲所', '烈士陵园', '东山口', '杨箕', '体育西路', '体育中心']],
      ['#2f7bd0', ['白云公园', '三元里', '越秀公园', '纪念堂', '公园前', '海珠广场', '江南西', '昌岗', '东晓南', '南洲']],
      ['#27ae60', ['五山', '华师', '岗顶', '石牌桥', '体育西路', '珠江新城', '广州塔', '客村', '沥滘', '厦滘']],
      ['#f0b429', ['西村', '小北', '淘金', '区庄', '动物园', '杨箕', '珠江新城', '猎德', '潭村', '员村', '车陂', '东圃', '鱼珠', '大沙地']],
    ];
    for (const L of LINES) {
      const lid = M.newLine(net); net.lines[lid].color = L[0];
      let prev = null;
      for (const nm of L[1]) {
        const p = P[nm]; if (!p) continue;
        let sid = byName[nm];
        if (!sid) { sid = M.addStation(net, p[1], p[2], { size: 'M', type: 'underground' }, city); net.stations[sid].name = nm; byName[nm] = sid; }
        if (prev && prev !== sid) M.addSegment(net, lid, prev, sid, [], 'underground');
        prev = sid;
      }
    }
    M.normalizeLines(net);
    return { city: city, net: net, compiled: M.compile(net, city), draft: null, preview: true, clock: { y: 2012, m: 6, d: 1, minute: 600 }, netVersion: 0 };
  }
  function previewCamera(dt) {
    previewT += dt;
    // 缓慢漂移，幅度小：需要新绘制的地图块很少，开始界面保持流畅
    R.cam.view = 1; R.cam.cx = 40 + 5 * Math.sin(previewT * 0.01); R.cam.cy = 41 + 2 * Math.sin(previewT * 0.008 + 1);
  }
  function fail(e, what) {
    console.error(e);
    ui.openScreen(CM.U.h('div', { class: 'card' }, CM.U.h('h2', null, what + '失败'), CM.U.h('div', { class: 'callout bad' }, String(e && e.message || e)),
      CM.U.h('div', { class: 'modal-actions' }, CM.U.h('button', { class: 'btn primary', onclick: function () { if (CM.game) ui.closeScreen(); else ui.showStart(); } }, '确定'))));
  }
  function start(g, isNew) {
    CM.game = g;
    R.setGame(g);
    CM.agents.reset();
    tools.tool = 'select'; tools.chain = null; tools.bends = []; tools.lineChoice = 'new';
    ui.attachGame(g);
    ui.closeScreen();
    R.cam.cx = 30; R.cam.cy = 41; R.cam.zoom = R.cam.tz = 18; R.cam.view = 1; R.cam.t = 1; R.cam.under = R.cam.tu = 0; R.cam.anchor = null;
    if (isNew) {
      g.setSpeed(0);
      ui.doAutosave();
      ui.toast('欢迎来到 1990 年的广州！游戏已暂停：先规划第一条线路，再按空格或 ▶ 开始。', 'info');
      ui.openPage('tasks', null, { root: true });
    } else {
      g.setSpeed(0);
      ui.markSaved(g, Date.now());
      ui.toast('存档已载入（' + g.clock.y + '年' + g.clock.m + '月），按空格继续', 'good');
    }
    ui.renderToolbar();
  }
  CM.newGame = function (opts) {
    ui.showLoading('正在生成 1990 年的广州，并计算居民出行…');
    setTimeout(function () {
      try { start(CM.Game.create(opts), true); } catch (e) { fail(e, '创建新游戏'); }
    }, 60);
  };
  CM.loadGame = function (data) {
    ui.showLoading('正在载入存档并恢复城市与交通状态…');
    setTimeout(function () {
      try { start(CM.Game.restore(data), false); } catch (e) { fail(e, '载入存档'); }
    }, 60);
  };
  CM.endGame = function () {
    CM.game = null;
    ui.closeSearch();
    if (CM.NetMap) CM.NetMap.close();
    ui.closePanel(true);
    ui.showHUD(false);
    CM.agents.reset();
    crossfade();   // 从游戏画面淡入开始界面背景，掩盖地图块的重新绘制
    if (!preview) preview = makePreview();
    R.setGame(preview);
    R.cam.zoom = R.cam.tz = 17; R.cam.t = 1; R.cam.under = R.cam.tu = 0;
  };

  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  function frame(t) {
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    const g = CM.game;
    if (g) {
      try { g.update(dt); } catch (e) { console.error(e); }
      try { CM.agents.update(dt, g, R); } catch (e) { console.error(e); }
      tools.tick(dt);
    } else if (preview) {
      previewCamera(dt);
    }
    try { R.render(dt, ui); } catch (e) { console.error(e); }
    ui.tick(dt);
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1) { R.stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    requestAnimationFrame(frame);
  }
  window.addEventListener('beforeunload', function () { if (CM.game && !ui.isSaved()) ui.doAutosave(); });
  window.addEventListener('resize', function () { R.resize(); });

  R.resize();
  R.cam.zoom = R.cam.tz = 17; R.cam.view = 1; R.cam.t = 1; previewCamera(0);
  requestAnimationFrame(frame);
  // 先显示开始界面，再在下一帧之后生成背景城市，地图淡入（打开不卡顿）
  canvas.classList.add('map-intro');
  CM.Save.init().then(function () { ui.showStart(); }, function () { ui.showStart(); });
  setTimeout(function () {
    if (!preview) { try { preview = makePreview(); } catch (e) { console.error(e); } }
    if (preview && !CM.game) R.setGame(preview);
    requestAnimationFrame(function () { canvas.classList.add('map-in'); });
  }, 80);
})(window.CM);
