'use strict';
// 加载页：系统 logo + 进度条。显示多久由加载本身决定：加载一完成就快速跑满进度条并关闭
(function (CM) {
  // 依赖 util.js 的 CM.U.h：它支持数组子节点与 html，自带的简化版会在提示渲染里抛异常
  const U = CM.U;
  if (!U) return;
  const h = U.h;
  const CFG = CM.CFG || { GAME_VERSION: '2.0.0' };
  // 延迟到渲染时再取：外壳注入的版本号比本文件的 SCENES 定义更晚到
  const VERSION = function () { return CFG.GAME_VERSION || '2.0.0'; };
  const REPO = 'https://github.com/CantLiLi/city-and-metro-ce/issues';

  // 三种场景：启动、进入地图、退出地图。提示各自独立。
  // 时长不再固定：进度条先慢爬到 warmPct 等加载，加载一完成就快速跑满并关闭
  const SCENES = {
    boot: {
      warm: 3100, warmPct: 70, fin: 480,
      tips: [
        { t: '正在准备城市数据与地铁线路，请稍候' },
        { t: '建议最大化或全屏窗口游玩' },
        { t: function () { return '本版本基于原版 v' + VERSION() + ' 修改'; } },
        { t: '有问题请反馈到本项目的 GitHub 仓库，而不是官方仓库。', link: REPO },
      ],
    },
    enter: {
      warm: 2900, warmPct: 72, fin: 480,
      tips: [
        { t: '正在生成城市与居民出行数据，请稍候' },
        { t: '开局资金有限：先修一条主干线，再慢慢延伸' },
        { t: '空格暂停／继续，1–9 切换速度（0.5× 到 1024×，还能自定义）' },
        { t: '想省事可以先跑「新手教程 · 青湾」，十几分钟上手' },
      ],
    },
    exit: {
      warm: 2900, warmPct: 72, fin: 480,
      tips: [
        { t: '正在保存进度并返回主菜单…' },
        { t: '进度已自动保存在本浏览器中，下次可点「继续游戏」' },
        { t: '也建议定期导出存档文件，换设备时更放心' },
        { t: '感谢游玩，欢迎到 GitHub 反馈问题与建议', link: REPO },
      ],
    },
  };

  // 按运行平台选图标：Windows / macOS / Linux / 移动端各一张
  function platform() {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
    if (/Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua)) return 'mobile';
    return 'linux';
  }
  const LOGO = {
    windows: 'resources/icon.png',
    macos: 'resources/logo-white.png',
    linux: 'resources/logo-navy.png',
    mobile: 'resources/favicon.png',
  };

  let root = null, finished = false, onKey = null, pctRaf = 0;

  function mount(title) {
    if (root) return null;
    dropFading();
    if (!document.body) return null;
    const tipEl = h('div', { class: 'lp-tip' });
    const barFill = h('i');
    const pctEl = h('b', { class: 'lp-pct' }, '0%');
    // 进场即完全不透明：早于本脚本的页面内容一律被挡住，不做淡入，避免主界面从下面透出来
    const logo = h('img', { class: 'lp-logo', alt: '城市与地铁社区版', src: LOGO[platform()] });
    root = h('div', { class: 'loadpage', id: 'loadpage', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'lp-stage' },
        logo,
        h('div', { class: 'lp-title' }, title || '城市与地铁社区版'),
        h('div', { class: 'lp-prog' }, h('div', { class: 'lp-bar' }, barFill), pctEl),
        tipEl));
    document.body.appendChild(root);
    return { tipEl: tipEl, barFill: barFill, pctEl: pctEl };
  }

  // CSS 里的三次贝塞尔缓动：给一组时间点，直接算出同一曲线下的取值
  function cubic(x1, y1, x2, y2, t) {
    const bz = function (a, b, k) { return 3 * a * (1 - k) * (1 - k) * k + 3 * b * (1 - k) * k * k + k * k * k; };
    let lo = 0, hi = 1, k = t;
    for (let i = 0; i < 18; i++) {
      if (bz(x1, x2, k) < t) lo = k; else hi = k;
      k = (lo + hi) / 2;
    }
    return bz(y1, y2, k);
  }

  const easeWarm = function (t) { return cubic(.3, .05, .55, .95, t); };
  const easeFin = function (t) { return cubic(.55, .05, .25, 1, t); };
  const linear = function (t) { return t; };

  // 按时间算条子宽度与数字，不再跟 CSS 过渡走。过渡的宽度只在样式提交时才生效，
  // 加载页刚挂上页面那几帧还没跑起来，回读永远是 0；断点调试、窗口尺寸一变过渡也会丢，
  // 回读出来就是 100% 掉回 72%。数值只由时间决定，两段（慢爬、快跑满）接得上，不会回退。
  function grow(barFill, pctEl, sc) {
    let from = 0, to = 0, t0 = 0, dur = 0, ease = easeWarm;
    const still = !!(CM.Settings && CM.Settings.reducedMotion && CM.Settings.reducedMotion());
    const draw = function (v) {
      barFill.style.width = v + '%';
      pctEl.textContent = Math.round(v) + '%';
    };
    draw(0);
    const step = function () {
      pctRaf = requestAnimationFrame(step);
      const k = dur > 0 ? (performance.now() - t0) / dur : 1;
      draw(k >= 1 ? to : from + (to - from) * ease(k));
    };
    const run = function (next, arc, ms) {
      from = to; to = Math.max(to, next); t0 = performance.now(); dur = ms; ease = arc;
    };
    // 减少动效时不要缓动：条子直接停在等待位置，只在收尾时补满
    run(sc.warmPct, still ? linear : easeWarm, still ? 1 : sc.warm);
    pctRaf = requestAnimationFrame(step);
    return run;
  }

  function setTips(tipEl, list) {
    tipEl.innerHTML = '';
    tipEl.appendChild(h('div', { class: 'lp-tips' }, list.map(function (tip) {
      const line = [h('span', { class: 'lp-tip-i' }, typeof tip.t === 'function' ? tip.t() : tip.t)];
      if (tip.link) line.push(h('a', { class: 'lp-tip-a', href: tip.link, target: '_blank', rel: 'noopener' }, 'GitHub 仓库'));
      return h('div', { class: 'lp-tip-line' }, line);
    })));
  }

  const OUT_MS = 520;

  // 兜底：加载页卡住时不会永远挡住界面。启动/进入/退出各自最长等待，到点强制收尾
  const WATCH = { boot: 12000, enter: 60000, exit: 30000 };

  // 正在淡出的旧加载页：新的一页挂上去之前必须彻底清掉，否则两层叠在一起，
  // 旧的那层停在 100% 淡出、新的从 0 涨起，看上去就是进度条往回跑
  let fading = null;

  function dropFading() {
    const el = fading;
    if (!el) return;
    fading = null;
    el.removeEventListener('transitionend', el._lpEnd);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function cleanup() {
    if (pctRaf) { cancelAnimationFrame(pctRaf); pctRaf = 0; }
    const el = root;
    if (el) {
      root = null;
      dropFading();
      fading = el;
      el.classList.add('is-out');
      const drop = function () {
        el.removeEventListener('transitionend', onEnd);
        if (fading === el) fading = null;
        if (el.parentNode) el.parentNode.removeChild(el);
      };
      const onEnd = function (e) { if (e.target === el && e.propertyName === 'opacity') drop(); };
      el._lpEnd = onEnd;
      el.addEventListener('transitionend', onEnd);
      setTimeout(drop, OUT_MS + 180);
    }
    if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null; }
  }

  let closing = null;
  function finish() {
    if (root) cleanup();
    if (finished) return;
    finished = true;
    const cb = closing;
    closing = null;
    if (cb) cb();
  }

  // 打开加载页。opts.scene：boot | enter | exit；opts.onDone：关闭后执行；
  // opts.onReady：加载页画出来之后执行，返回的函数在关闭后执行（用于把建城这类同步重活推到画面出现之后）。
  // 关闭时机由加载本身决定：进度条快速跑满后立刻关闭，不再固定显示几秒。
  // 给了 onReady 就在它返回（加载完成）后收尾；没给就立刻收尾。
  // 返回句柄：done() 手动标记加载完成
  function open(opts) {
    opts = opts || {};
    const sc = SCENES[opts.scene] || SCENES.boot;
    const onDone = opts.onDone;
    closing = onDone || null;
    finished = false;
    const ui = mount(opts.title);
    if (!ui) { finished = true; closing = null; if (onDone) onDone(); return { done: function () {} }; }
    const tipEl = ui.tipEl, barFill = ui.barFill, pctEl = ui.pctEl;
    let ready = false, closed = false, boot = 0;
    const run = grow(barFill, pctEl, sc);
    const tipList = opts.tips || sc.tips;
    if (opts.skippable !== false) {
      onKey = function (e) { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') done(); };
      document.addEventListener('keydown', onKey, true);
    }
    try { setTips(tipEl, tipList); } catch (e) { console.error(e); }
    // 卡住兜底：无论谁没来报「加载完成」，到点都强制收尾，加载页不会永远盖着界面
    boot = setTimeout(done, WATCH[opts.scene] || WATCH.boot);
    // 加载完成：把进度条补到 100%（快速收尾），满格后立刻关闭
    function done() {
      if (ready || closed) return;
      ready = true;
      if (boot) { clearTimeout(boot); boot = 0; }
      try { run(100, easeFin, sc.fin); } catch (e) { console.error(e); }
      setTimeout(close, sc.fin);
    }
    function close() {
      if (closed) return;
      closed = true;
      finish();
    }
    if (opts.onReady) {
      // 双重 rAF 之后再跑重活：先让加载页画出来，进度条的起始段动画同时进行
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (closed) return;
          let after = null;
          try { after = opts.onReady(); } catch (e) { console.error(e); }
          if (typeof after === 'function') { const prev = closing; closing = function () { if (prev) prev(); after(); }; }
          done();
        });
      });
    }
    // 没给 onReady 的场景（例如退出菜单要保留游戏状态）：立刻算加载完成，只跑「快速跑满 → 关闭」
    else requestAnimationFrame(function () { requestAnimationFrame(done); });
    return { done: done };
  }

  CM.LoadPage = {
    open: open,
    show: function (o) { open(o); },
    finish: finish,
    isOpen: function () { return !!root; },
    SCENES: SCENES,
    platform: platform,
    initial: null,
  };

  // 启动时立即挂遮罩：主脚本还要跑一长串初始化，等它调用 show() 时主界面可能已经画出来了。
  // main.js 初始化写完会调用 initial.done() 收尾；这里另外有 WATCH.boot 兜底
  CM.LoadPage.initial = open({ scene: 'boot', skippable: false, onDone: function () { if (CM.onLoadPageDone) CM.onLoadPageDone(); } });
})(window.CM = window.CM || {});
