'use strict';
// 空闲降载：画面不再变化时不再重绘（省 CPU 与显卡），静得更久再停下每帧回调并释放可以重建的缓存与并行 Worker。
// 任何输入或状态变化立即恢复。只决定「画多少、什么时候画」，模拟与游戏逻辑照常运行。
(function (CM) {
  const LIGHT_MS = 3000;    // 无操作 3 秒：允许进入休眠判定
  const SLEEP_MS = 20000;   // 无操作 20 秒且画面静止：停每帧回调并释放内存
  const STILL_MS = 140;     // 画面静止这么久就不再重绘，不必等到鼠标也停下
  const GUARD_MS = 1000;    // 静止再久也每秒补画一帧，漏判最多晚一秒自愈
  let lastInput = performance.now(), lastBusy = lastInput, lastDraw = lastInput, forced = 0, light = false, asleep = false;
  const EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel',
    'keydown', 'keyup', 'touchstart', 'touchmove', 'input', 'compositionstart', 'resize', 'focus'];
  // 画面被外部改动过（换主题、改尺寸、换绘制目标、休眠释放缓存）：接下来必须补一帧
  function force() { forced = 2; }
  function touch() {
    lastInput = performance.now();
    if (!asleep) return;
    asleep = false;
    force();
    if (CM.wakeLoop) CM.wakeLoop();
  }
  for (const e of EVENTS) window.addEventListener(e, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', touch);

  // 相机这一帧动过没有：拖动、平移、跟随、缩放、倾斜最终都落在这几个字段上
  let camSnap = null;
  function camMoved() {
    const c = CM.R && CM.R.cam;
    if (!c) return false;
    const s = camSnap;
    if (s && s[0] === c.cx && s[1] === c.cy && s[2] === c.zoom && s[3] === c.view && s[4] === c.under && s[5] === c.t) return false;
    camSnap = [c.cx, c.cy, c.zoom, c.view, c.under, c.t];
    return true;
  }
  // 只有画面里真的在逐帧变化的内容才算忙：静态的框、标记画一次就会留在画面上
  function animated(g, R, ui) {
    if (ui && ui.selection) return true;                        // 选中站点的呼吸环
    if (R.hl) return true;                                      // 定位高亮的脉冲与流动虚线
    const T = CM.tools;
    if (T && (T.tool !== 'select' || T.drag || T.chain)) return true;   // 工具预览跟着指针走，绘线还有流动虚线
    if (g.draft) return true;                                   // 方案冲突图钉的脉冲
    if (R.labA != null && R.labA > 0.01 && R.labA < 0.99) return true;
    if (R.mapLabA != null && R.mapLabA > 0.01 && R.mapLabA < 0.99) return true;
    return false;
  }

  // 画面是否可能还在变：只要有一处为真就保持正常绘制
  function busy() {
    const g = CM.game, R = CM.R;
    if (!g || !R || R.game !== g) return true;              // 开始界面背景一直在动
    if (g.speed > 0 || g.jumping || g.pending) return true;  // 时间在走，车辆与时刻都在动
    if (!g.model || !g.model.settled) return true;           // 还在收敛，数据会变
    const c = R.cam;
    if (c.fly || Math.abs(c.zoom - c.tz) > 1e-3 || c.t !== c.view || c.under !== c.tu) return true;
    if (camMoved()) return true;
    if (R.isoJob || R.overviewJob || R.stats.lodPreparing) return true;
    const lf = R.layerFade || 0, bf = R.bFade || 0;
    if ((lf > 0 && lf < 1) || (bf > 0 && bf < 1)) return true;
    if (R.fx && R.fx.length) return true;
    if (CM.agents && CM.agents.fillPending) return true;
    if (CM.LoadPage && CM.LoadPage.isOpen && CM.LoadPage.isOpen()) return true;
    if (CM.Stats && CM.Stats.isOpen && CM.Stats.isOpen()) return true;
    if (CM.Tutorial && CM.Tutorial.active && CM.Tutorial.active()) return true;
    const ui = CM.ui;
    if (ui && (ui._celebrationActive || (ui._celebrationQueue && ui._celebrationQueue.length))) return true;
    return animated(g, R, ui);
  }

  // 释放可以重建的缓存与并行 Worker；游戏状态与模拟数据不动，唤醒后按需重建
  function release() {
    if (CM.R && CM.R.freeCaches) CM.R.freeCaches();
    if (CM.SimPar && CM.SimPar.stop) CM.SimPar.stop();
    if (typeof window.gc === 'function') { try { window.gc(); } catch (e) { /* 仅暴露时可用 */ } }
  }

  CM.Idle = {
    // 每帧开头调用，返回 full（正常绘制）、light（跳过绘制）或 sleep（停下每帧回调）
    feed: function (now) {
      if (busy()) { lastBusy = now; asleep = false; }
      const quiet = now - lastInput, still = now - lastBusy;
      if (!asleep && quiet >= SLEEP_MS && still >= SLEEP_MS) { asleep = true; release(); }
      else if (asleep && (quiet < LIGHT_MS || still < LIGHT_MS)) asleep = false;
      // 画面静止就停下重绘：鼠标在地图上移动、盯着面板读数字时，画面其实一动不动
      const f = forced > 0;
      if (f) forced--;
      if (asleep || f || still < STILL_MS || now - lastDraw >= GUARD_MS) { light = false; lastDraw = now; }
      else light = true;
      return asleep ? 'sleep' : (light ? 'light' : 'full');
    },
    light: function () { return light; },
    asleep: function () { return asleep; },
    force: force,
    touch: touch,
  };
})(window.CM);
