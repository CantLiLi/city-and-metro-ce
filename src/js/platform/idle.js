'use strict';
// 空闲降载：一段时间没有鼠标、键盘操作且画面完全静止时，先跳过地图绘制（省 CPU 与显卡），
// 再停下每帧回调并释放可以重建的缓存与并行 Worker（省内存）。任何输入或状态变化立即恢复。
// 只决定「画多少、什么时候画」，模拟与游戏逻辑照常运行。
(function (CM) {
  const LIGHT_MS = 3000;    // 无操作 3 秒：跳过绘制
  const SLEEP_MS = 20000;   // 无操作 20 秒且画面静止：停每帧回调并释放内存
  let lastInput = performance.now(), lastBusy = lastInput, light = false, asleep = false;
  const EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel',
    'keydown', 'keyup', 'touchstart', 'touchmove', 'input', 'compositionstart', 'resize', 'focus'];
  function touch() {
    lastInput = performance.now();
    if (!asleep) return;
    asleep = false;
    if (CM.wakeLoop) CM.wakeLoop();
  }
  for (const e of EVENTS) window.addEventListener(e, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', touch);

  // 画面是否可能还在变：只要有一处为真就保持正常绘制
  function busy() {
    const g = CM.game, R = CM.R;
    if (!g || !R || R.game !== g) return true;              // 开始界面背景一直在动
    if (g.speed > 0 || g.jumping || g.pending) return true;  // 时间在走，车辆与时刻都在动
    if (!g.model || !g.model.settled) return true;           // 还在收敛，数据会变
    const c = R.cam;
    if (c.fly || Math.abs(c.zoom - c.tz) > 1e-3 || c.t !== c.view || c.under !== c.tu) return true;
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
    return false;
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
      light = !asleep && quiet >= LIGHT_MS && still >= LIGHT_MS;
      return asleep ? 'sleep' : (light ? 'light' : 'full');
    },
    light: function () { return light; },
    asleep: function () { return asleep; },
    touch: touch,
  };
})(window.CM);
