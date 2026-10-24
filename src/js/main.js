'use strict';
// 启动与主循环
(function (CM) {
  const CFG = CM.CFG;
  const canvas = document.getElementById('map');
  const R = new CM.Renderer(canvas);
  // 显卡模式只在启动时决定一次：关闭时改画到要求频繁读取的画布（浏览器按软件光栅化处理）
  if (CM.Settings.get('gpu') === false) R.setGpu(false);
  const ui = new CM.UI(R);
  const tools = new CM.Tools(R, ui);
  ui.tools = tools;
  CM.R = R; CM.ui = ui; CM.tools = tools;
  CM.Follow.init(ui);
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
    // 颜色按广州地铁配色：1 号线黄、2 号线蓝、3 号线橙、5 号线红
    const LINES = [
      ['#f3d03e', ['坑口', '花地湾', '芳村', '黄沙', '陈家祠', '西门口', '公园前', '农讲所', '烈士陵园', '东山口', '杨箕', '体育西路', '体育中心']],
      ['#00629b', ['白云公园', '三元里', '越秀公园', '纪念堂', '公园前', '海珠广场', '江南西', '昌岗', '东晓南', '南洲']],
      ['#eca154', ['五山', '华师', '岗顶', '石牌桥', '体育西路', '珠江新城', '广州塔', '客村', '沥滘', '厦滘']],
      ['#c5003e', ['西村', '小北', '淘金', '区庄', '动物园', '杨箕', '珠江新城', '猎德', '潭村', '员村', '车陂', '东圃', '鱼珠', '大沙地']],
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
  // 开始界面背景：镜头沿一条环形路线缓慢巡游几处城市地标（位置与缩放用 Catmull-Rom 平滑插值，速度约 0.3–0.5 格/秒，
  // 新进入画面的地图块少，保持流畅），同时列车在示意线路上运行、汽车在道路上行驶。菜单在左侧，焦点放在画面偏右
  const TOUR = [[44, 39.5, 17.5], [48.6, 45, 19], [44.5, 50.5, 17.5], [31, 45.5, 17], [18.5, 45.5, 18.5], [22, 37.5, 18], [34, 37.5, 17], [47.5, 34.5, 18.5]];
  const TOUR_SEG = 24;   // 每段秒数
  function previewCamera(dt) {
    previewT += dt;
    const n = TOUR.length, u = (previewT / TOUR_SEG) % n, k = Math.floor(u), f = u - k;
    const P = function (i) { return TOUR[((i % n) + n) % n]; };
    const cr = function (j) {
      const p0 = P(k - 1)[j], p1 = P(k)[j], p2 = P(k + 1)[j], p3 = P(k + 2)[j];
      return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    };
    const c = R.cam;
    c.view = 1; c.fly = null; c.anchor = null;
    c.zoom = c.tz = cr(2);
    const d = R.screenToWorldDelta(R.w * 0.14, 0);
    c.cx = cr(0) - d.x; c.cy = cr(1) - d.y;
  }
  function fail(e, what) {
    console.error(e);
    ui.openScreen(CM.U.h('div', { class: 'card' }, CM.U.h('h2', null, what + '失败'), CM.U.h('div', { class: 'callout bad' }, String(e && e.message || e)),
      CM.U.h('div', { class: 'modal-actions' }, CM.U.h('button', { class: 'btn primary', onclick: function () { if (CM.game) ui.closeScreen(); else ui.showStart(); } }, '确定'))));
  }
  function start(g, isNew) {
    if (CM.Soundscape) CM.Soundscape.reset();
    if (CM.Follow) CM.Follow.stop(true);
    if (CM.Tutorial) CM.Tutorial.detach();
    CM.game = g;
    R.setGame(g);
    CM.agents.reset();
    tools.tool = 'select'; tools.chain = null; tools.bends = []; tools.lineChoice = 'new';
    ui.attachGame(g);
    ui.closeScreen();
    const mp = CM.curMap(), cam = mp.cam || { cx: CFG.W / 2, cy: CFG.H / 2, zoom: 18 };
    R.cam.cx = cam.cx; R.cam.cy = cam.cy; R.cam.zoom = R.cam.tz = cam.zoom; R.cam.view = 1; R.cam.t = 1; R.cam.under = R.cam.tu = 0; R.cam.anchor = null; R.cam.fly = null;
    g.setSpeed(0);
    if (g.tutorial && CM.Tutorial) {
      if (isNew) ui.doAutosave(); else ui.markSaved(g, Date.now());
      CM.Tutorial.attach(ui, g);
    } else if (isNew) {
      ui.doAutosave();
      // 开局简报：这座城市当时的交通格局（东京为接管银座线）；关闭后打开任务面板
      const tip = function () { ui.toast('游戏已暂停：先规划线路，再按空格或 ▶ 开始。', 'info'); ui.openPage('tasks', null, { root: true }); };
      if (CM.DATA.briefing && ui.showBriefing) ui.showBriefing(tip); else tip();
    } else {
      ui.markSaved(g, Date.now());
      ui.toast('存档已载入（' + g.clock.y + '年' + g.clock.m + '月），按空格继续', 'good');
    }
    // 旧存档升级（升级前的原存档已由 Save.load 另存为备份）：提示并保存升级后的进度
    if (!isNew && g.upgradeNote) {
      // 读入的旧快照与内存中的升级结果不同；备份失败时尤其不能把尚未落盘的升级标为「已保存」。
      ui.markUnsaved();
      ui.toast(g.upgradeNote, g.backupFailed ? 'warn' : 'info'); g.upgradeNote = null;
      if (!g.backupFailed) ui.doAutosave();
    }
    ui.renderToolbar();
  }
  // opts.map：地图（默认广州）；opts.tutorial：新手教程
  CM.newGame = function (opts) {
    if (CM.Soundscape) CM.Soundscape.reset();
    const mp = CM.MAPS[opts.map] || CM.MAPS.gz;
    // 加载页期间完成生成，动画走完再切换到游戏画面，避免建图卡住时露出空地图
    if (!CM.LoadPage) {
      ui.showLoading('正在生成 ' + mp.cfg.START.y + ' 年的' + mp.data.city + '，并计算居民出行…');
      setTimeout(function () {
        try { CM.useMap(mp.id); start(CM.Game.create(opts), true); } catch (e) { CM.useMap(CM.game ? CM.game.mapId : 'gz'); fail(e, '创建新游戏'); }
      }, 60);
      return;
    }
    // 同样是先出加载页再建城：建城是同步的重活，放在加载页画出来之后
    CM.LoadPage.open({
      scene: 'enter',
      onReady: function () {
        let game = null, err = null;
        try { CM.useMap(mp.id); game = CM.Game.create(opts); } catch (e) { err = e; if (CM.game) CM.useMap(CM.game.mapId || 'gz'); }
        return function () {
          if (err) { fail(err, '创建新游戏'); return; }
          ui.closeScreen();
          start(game, true);
        };
      },
    });
  };
  CM.loadGame = function (data) {
    if (CM.Soundscape) CM.Soundscape.reset();
    if (!CM.LoadPage) {
      ui.showLoading('正在载入存档并恢复城市与交通状态…');
      setTimeout(function () {
        try { CM.useMap((data.meta && data.meta.map) || 'gz'); start(CM.Game.restore(data), false); } catch (e) { CM.useMap(CM.game ? CM.game.mapId : 'gz'); fail(e, '载入存档'); }
      }, 60);
      return;
    }
    // 先让加载页画出来再恢复存档：恢复是同步的重活，放在它后面才不会「点一下没反应」
    CM.LoadPage.open({
      scene: 'enter',
      onReady: function () {
        let game = null, err = null;
        try {
          CM.useMap((data.meta && data.meta.map) || 'gz');
          game = CM.Game.restore(data);
        } catch (e) { err = e; if (CM.game) CM.useMap(CM.game.mapId || 'gz'); }
        return function () {
          if (err) { fail(err, '载入存档'); return; }
          ui.closeScreen();
          start(game, false);
        };
      },
    });
  };
  CM.endGame = function () {
    if (CM.Soundscape) CM.Soundscape.reset();
    ui.clearCelebrations();
    CM.game = null;
    if (CM.Follow) CM.Follow.stop(true);
    if (CM.Tutorial) CM.Tutorial.detach();
    CM.useMap('gz');   // 开始界面背景是广州
    ui.closeSearch();
    if (CM.NetMap) CM.NetMap.close();
    if (CM.Stats && CM.Stats.isOpen()) CM.Stats.close();
    ui.closePanel(true);
    ui.showHUD(false);
    ui.setTooltip(null);
    CM.agents.reset();
    crossfade();   // 从游戏画面淡入开始界面背景，掩盖地图块的重新绘制
    // 清掉游戏里的视图状态：分析图层、选中与高亮、建设工具、相机飞行与缩放锚点、地下视图、特效
    ui.layer = 'none'; R.layer = 'none'; R.heatKey = ''; R.layerFade = 0;
    ui.selection = null; ui.highlightLine = null; ui.multi = null;
    tools.tool = 'select'; tools.chain = null; tools.bends = []; tools.drag = null; tools.ptr = null; tools.hover = null; tools.keys.clear();
    R.cv.style.cursor = '';
    if (!preview) preview = makePreview();
    R.setGame(preview);
    R.fx = [];
    R.cam.t = 1; R.cam.under = R.cam.tu = 0; R.cam.fly = null; R.cam.anchor = null;
    previewCamera(0);
  };

  let last = performance.now(), pending = 0, gate = 0, fpsAcc = 0, fpsN = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const elapsed = Math.max(0, t - last);
    last = t;
    // 最大帧率：按屏刷的整数倍跳帧。每轮只扣掉一个间隔、余量留到下一轮，
    // 否则高刷屏上只能按「几个刷新周期」取整（144Hz 屏要 3 个周期才够 1/60 秒，结果只有 48 帧）
    const limit = +CM.Settings.get('fpsLimit') || 0;
    pending += elapsed;
    if (limit > 0) {
      const step = 1000 / limit;
      gate += elapsed;
      if (gate < step) return;
      gate = gate >= step * 3 ? 0 : gate - step;
    } else gate = 0;
    const dt = Math.min(0.1, pending / 1000);
    pending = 0;
    const workStarted = performance.now();
    const g = CM.game;
    if (g) {
      try { g.update(dt); } catch (e) { console.error(e); }
      try { CM.agents.update(dt, g, R); } catch (e) { console.error(e); }
      try { CM.Follow.tick(dt); } catch (e) { console.error(e); }
      try { CM.Tutorial.tick(dt); } catch (e) { console.error(e); }
      tools.tick(dt);
    } else if (preview && R.game === preview) {
      previewCamera(dt);
      try { CM.agents.updatePreview(dt, preview, R); } catch (e) { console.error(e); }
    }
    try { R.render(dt, ui); R.present(); } catch (e) { console.error(e); }
    try { CM.Soundscape.tick(dt); } catch (e) { console.error(e); }
    ui.tick(dt);
    if (CM.Monitor) CM.Monitor.tick(dt);
    R.noteFrameTime(performance.now() - workStarted);
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1) { R.stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  }
  window.addEventListener('beforeunload', function () { if (CM.game && !ui.isSaved()) ui.doAutosave(); });
  window.addEventListener('resize', function () { R.resize(); });
  // 桌面版：外壳等这里把进度写完再销毁窗口（标志由 Python 端在 loaded 后注入，可能晚于本脚本）
  window.__cmDesktopClose = function () {
    if (!CM.desktop || !CM.desktop.isDesktop()) return Promise.resolve();
    const g = CM.game;
    if (!g || ui.isSaved()) return Promise.resolve();
    return Promise.resolve(ui.doAutosave(true)).catch(function () {});
  };

  R.resize();
  R.cam.zoom = R.cam.tz = 17; R.cam.view = 1; R.cam.t = 1; previewCamera(0);
  requestAnimationFrame(frame);
  // 先显示开始界面，再在下一帧之后生成背景城市，地图淡入（打开不卡顿）
  canvas.classList.add('map-intro');
  CM.onLoadPageDone = function () { canvas.classList.add('map-in'); };
  CM.Save.init().then(function () { ui.showStart(); }, function () { ui.showStart(); });
  setTimeout(function () {
    if (!preview) { try { preview = makePreview(); } catch (e) { console.error(e); } }
    if (preview && !CM.game) R.setGame(preview);
    if (!CM.LoadPage.isOpen()) requestAnimationFrame(function () { canvas.classList.add('map-in'); });
  }, 80);
})(window.CM);
