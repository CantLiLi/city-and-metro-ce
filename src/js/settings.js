'use strict';
// 设置：只保留常用项（主题、界面大小、地图标注、交通动画、显卡与帧率、运行监控、声音与三路音量、自动保存），保存在本地；变化时立即生效并通知各模块
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
    fpsLimit: 0,          // 最大帧率，0 表示不限制
    monitor: false,       // 右下角运行监控
    monCpu: true, monRam: true, monGpu: true, monFps: true,   // 监控里分别显示哪几项
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
    },
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (cur.theme === 'auto') Settings.apply('theme'); });
  CM.Settings = Settings;
})(window.CM);
