'use strict';
// 设置：只保留常用项（主题、界面大小、地图标注、交通动画、显卡与模型渲染、建筑密度、帧率、运行监控、声音与三路音量、自动保存），保存在本地；变化时立即生效并通知各模块
(function (CM) {
  const KEY = 'cm1.settings';
  const SCALE_MIN = 0.5, SCALE_MAX = 1.5;
  const clampScale = function (v) { v = +v; return isFinite(v) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) : 1; };
  const DEF = {
    theme: 'auto',        // light | dark | auto（跟随系统）
    uiScale: 1,           // 界面大小
    labels: 'all',        // 地图标注：all 全部 | stations 仅车站 | none 关闭
    agents: true,         // 车辆、行人与列车动画
    gpu: true,            // 使用显卡渲染地图；关闭后走处理器（软件）渲染
    fpsLimit: 0,          // 最大帧率：0 垂直同步 | 30 | 60 | 90
    modelDetail: 'high',  // 模型质量：high 高质量模型（精细建筑、山体树木、列车车窗与乘客、完整车流） | mid 中 | low 低质量模型
    renderRes: 'high',    // 渲染精度：high 高分辨率 | mid 中 | low 低分辨率（降低模型光栅精度与像素比上限）
    shadow: true,         // 绘制阴影：关闭后建筑、地标、桥梁、车辆都不画投影
    bldDensity: 'full',   // 建筑密度：min 极低 | low 低 | mid 中 | high 高 | max 最高 | full 超高（地标建筑始终保留）
    lodLive: false,       // 实时 LOD：开启后缩放过程中就按当前缩放重算渲染精度；关闭则等缩放停下再换档
    winMode: 'window',    // 窗口方式：window 普通窗口 | max 窗口化全屏（仅桌面版）
    monitor: false,       // 右下角运行监控
    monCpu: true, monRam: true, monGpu: true, monFps: true, monLow: false,   // 监控里分别显示哪几项
    monFloating: false,   // 监控信息放进可拖动的浮动小窗
    sound: true, volume: 0.6,   // 总开关与总音量
    trainVol: 0.7, ambVol: 0.6, // 列车音效、城市环境音（v2.0）
    autosave: true,
  };
  let cur = Object.assign({}, DEF);
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) {
      for (const k in DEF) if (s[k] !== undefined) cur[k] = s[k];
      // 旧版的两个标注开关合并为一项
      if (s.labels === undefined && (s.stationLabels === false || s.mapLabels === false)) cur.labels = s.stationLabels === false ? 'none' : 'stations';
    } else {
      const t = localStorage.getItem('cm1.theme'); if (t === 'light' || t === 'dark') cur.theme = t;
      const so = JSON.parse(localStorage.getItem('cm1.sound') || 'null'); if (so) { cur.sound = so.enabled !== false; if (isFinite(so.volume)) cur.volume = so.volume; }
    }
  } catch (e) { /* 存储不可用时使用默认值 */ }
  cur.uiScale = clampScale(cur.uiScale);
  // 旧版的 120 / 144 等帧率上限已经取消，落回垂直同步
  const FPS_LIMITS = [0, 30, 60, 90];
  cur.fpsLimit = FPS_LIMITS.indexOf(+cur.fpsLimit) < 0 ? 0 : +cur.fpsLimit;
  const MODEL_DETAILS = ['high', 'mid', 'low'];
  const MODEL_RESS = ['high', 'mid', 'low'];
  // 旧版只有一个「模型渲染」开关（quality / perf），拆成模型质量与渲染精度两项后按原意迁移
  if (cur.modelQuality !== undefined) {
    if (cur.modelQuality === 'perf') { cur.modelDetail = 'low'; cur.renderRes = 'low'; }
    delete cur.modelQuality;
  }
  if (MODEL_DETAILS.indexOf(cur.modelDetail) < 0) cur.modelDetail = 'high';
  if (MODEL_RESS.indexOf(cur.renderRes) < 0) cur.renderRes = 'high';
  cur.shadow = cur.shadow !== false;
  if (['min', 'low', 'mid', 'high', 'max', 'full'].indexOf(cur.bldDensity) < 0) cur.bldDensity = 'full';
  cur.lodLive = cur.lodLive === true;
  if (cur.winMode === 'full') cur.winMode = 'max';   // 旧版的「独占全屏」已经取消
  if (['window', 'max'].indexOf(cur.winMode) < 0) cur.winMode = 'window';
  const subs = [];
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ } }
  // 显卡模式要内核启动参数，浏览器里只能等下次打开页面，桌面版则交给外壳写进启动偏好
  function syncGpu(v) { if (CM.desktop && CM.desktop.setGpu) CM.desktop.setGpu(v); }
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const mqRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  const Settings = {
    DEF: DEF,
    get: function (k) { return cur[k]; },
    all: function () { return Object.assign({}, cur); },
    set: function (k, v) {
      if (k === 'uiScale') v = clampScale(v);
      if (k === 'winMode' && ['window', 'max'].indexOf(v) < 0) return;
      if (cur[k] === v) return;
      cur[k] = v; save();
      Settings.apply(k);
      if (k === 'gpu') syncGpu(v);
      for (const f of subs) { try { f(k, v); } catch (e) { console.error(e); } }
    },
    // 拖动中：只改 CSS 变量，不保存、不广播，避免每帧重算 HUD 与声音
    preview: function (k, v) {
      if (k === 'uiScale') v = clampScale(v);
      if (cur[k] === v) return;
      cur[k] = v;
      if (k === 'uiScale') document.documentElement.style.setProperty('--uiz', String(v));
    },
    // 松手：补做保存与广播
    commit: function (k) {
      save();
      Settings.apply(k);
      const v = cur[k];
      for (const f of subs) { try { f(k, v); } catch (e) { console.error(e); } }
    },
    reset: function () {
      cur = Object.assign({}, DEF); save(); syncGpu(cur.gpu);
      Settings.apply();
      for (const k of Object.keys(DEF)) for (const f of subs) { try { f(k, cur[k]); } catch (e) { console.error(e); } }
    },
    on: function (fn) { subs.push(fn); },
    // 系统“减少动态效果”偏好（不再单独设置）
    reducedMotion: function () { return !!(mqRM && mqRM.matches); },
    resolvedTheme: function () { return cur.theme === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : cur.theme; },
    apply: function (k) {
      const root = document.documentElement;
      if (!k || k === 'theme') { if (CM.setTheme) CM.setTheme(Settings.resolvedTheme()); else root.dataset.theme = Settings.resolvedTheme(); }
      if (!k || k === 'uiScale') root.style.setProperty('--uiz', String(cur.uiScale));
      if (!k || k === 'sound' || k === 'volume') { if (CM.Sound) { CM.Sound.setEnabled(cur.sound); CM.Sound.setVolume(cur.volume); } }
      if (CM.Sound && (!k || k === 'trainVol')) CM.Sound.setTrainVolume(cur.trainVol);
      if (CM.Sound && (!k || k === 'ambVol')) CM.Sound.setAmbVolume(cur.ambVol);
      if (CM.R && (!k || k === 'labels' || k === 'agents')) { CM.R.labelsOn = cur.labels !== 'none'; CM.R.mapLabelsOn = cur.labels === 'all'; CM.R.agentsOn = cur.agents; }
      if (CM.R && CM.R.setModelOpts && (!k || k === 'modelDetail' || k === 'renderRes')) CM.R.setModelOpts(cur.modelDetail, cur.renderRes);
      if (CM.R && CM.R.setShadows && (!k || k === 'shadow')) CM.R.setShadows(cur.shadow !== false);
      if (CM.R && CM.R.setBldDensity && (!k || k === 'bldDensity')) CM.R.setBldDensity(cur.bldDensity);
      if (CM.R && CM.R.setLodLive && (!k || k === 'lodLive')) CM.R.setLodLive(cur.lodLive === true);
      // 窗口方式交给桌面外壳；网页版没有这个能力。启动时只在不是普通窗口时才动窗口，免得干预正常启动
      if (CM.desktop && CM.desktop.setWindowMode && (!k || k === 'winMode')) {
        CM.desktop.setWindowMode(cur.winMode).then(function (ok) {
          if (!ok && CM.ui && CM.ui.toast) CM.ui.toast('切换全屏方式失败', 'warn');
        }, function () { /* 外壳不可用时保持原样 */ });
      }
    },
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (cur.theme === 'auto') Settings.apply('theme'); });
  CM.Settings = Settings;
})(window.CM);
