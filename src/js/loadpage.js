'use strict';
// 加载页：系统 logo + 进度条。启动时驻留 8s；进入地图与退出回主界面时各 4s，各带一组对应提示
(function (CM) {
  // 依赖 util.js 的 CM.U.h：它支持数组子节点与 html，自带的简化版会在 setTip 里抛异常
  const U = CM.U;
  if (!U) return;
  const h = U.h;
  const CFG = CM.CFG || { GAME_VERSION: '2.0.0' };
  const VERSION = CFG.GAME_VERSION || '2.0.0';
  const REPO = 'https://github.com/CantLiLi/city-and-metro-ce/issues';

  // 三种场景：启动、进入地图、退出地图。时长与提示各自独立
  const SCENES = {
    boot: {
      hold: 8000, tip: 1500, warm: 6200, warmPct: 70, fin: 1000,
      tips: [
        { t: '正在准备城市数据与地铁线路，请稍候' },
        { t: '建议最大化或全屏窗口游玩' },
        { t: '本版本基于原版 v' + VERSION + ' 修改' },
        { t: '有问题请反馈到本项目的 GitHub 仓库，而不是官方仓库。', link: REPO },
      ],
    },
    enter: {
      hold: 4000, tip: 1400, warm: 2900, warmPct: 72, fin: 800,
      tips: [
        { t: '正在生成城市与居民出行数据，请稍候' },
        { t: '开局资金有限：先修一条主干线，再慢慢延伸' },
        { t: '空格暂停／继续，1 / 2 / 3 切换 1× / 3× / 8× 速度' },
        { t: '想省事可以先跑「新手教程 · 青湾」，十几分钟上手' },
      ],
    },
    exit: {
      hold: 4000, tip: 1400, warm: 2900, warmPct: 72, fin: 800,
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

  let root = null, finished = false, holdTimer = null, tipTimer = null, finTimer = null, onKey = null;

  function mount(title) {
    if (root || !document.body) return null;
    const tipEl = h('div', { class: 'lp-tip' });
    const barFill = h('i');
    // 进场即完全不透明：早于本脚本的页面内容一律被挡住，不做淡入，避免主界面从下面透出来
    root = h('div', { class: 'loadpage', id: 'loadpage', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'lp-stage' },
        h('img', { class: 'lp-logo', src: LOGO[platform()], alt: '城市与地铁社区版' }),
        h('div', { class: 'lp-title' }, title || '城市与地铁社区版'),
        h('div', { class: 'lp-bar' }, barFill),
        tipEl));
    document.body.appendChild(root);
    return { tipEl: tipEl, barFill: barFill };
  }

  function setTip(tipEl, tip) {
    const frag = [h('span', { class: 'lp-tip-i' }, tip.t)];
    if (tip.link) frag.push(h('a', { class: 'lp-tip-a', href: tip.link, target: '_blank', rel: 'noopener' }, 'GitHub 仓库'));
    tipEl.innerHTML = '';
    tipEl.appendChild(h('div', { class: 'lp-tip-in' }, frag));
  }

  const OUT_MS = 520;

  function cleanup() {
    clearTimeout(holdTimer); clearTimeout(finTimer); clearInterval(tipTimer);
    holdTimer = finTimer = tipTimer = null;
    const el = root;
    if (el) {
      root = null;
      el.classList.add('is-out');
      const drop = function () {
        el.removeEventListener('transitionend', onEnd);
        if (el.parentNode) el.parentNode.removeChild(el);
      };
      const onEnd = function (e) { if (e.target === el && e.propertyName === 'opacity') drop(); };
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
  // opts.onReady：加载页画出来之后执行，返回的函数在关闭后执行（用于把建城这类同步重活推到画面出现之后）
  function open(opts) {
    opts = opts || {};
    const sc = SCENES[opts.scene] || SCENES.boot;
    const onDone = opts.onDone;
    closing = onDone || null;
    finished = false;
    const ui = mount(opts.title);
    if (!ui) { finished = true; closing = null; if (onDone) onDone(); return; }
    const tipEl = ui.tipEl, barFill = ui.barFill;
    // 两段式：先慢速爬到 warmPct，再快速收尾到 100%，最后留一小段满格
    barFill.style.transition = 'width ' + sc.warm + 'ms cubic-bezier(.3,.05,.55,.95)';
    requestAnimationFrame(function () { requestAnimationFrame(function () { barFill.style.width = sc.warmPct + '%'; }); });
    finTimer = setTimeout(function () {
      barFill.style.transition = 'width ' + sc.fin + 'ms cubic-bezier(.55,.05,.25,1)';
      barFill.style.width = '100%';
    }, sc.warm);
    // 计时器先挂上：提示渲染或轮换出错也不能让加载页关不掉
    holdTimer = setTimeout(finish, sc.hold);
    const tipList = opts.tips || sc.tips;
    if (opts.skippable !== false) {
      onKey = function (e) { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') finish(); };
      document.addEventListener('keydown', onKey, true);
    }
    let i = 0;
    const tick = function () {
      try { setTip(tipEl, tipList[i % tipList.length]); } catch (e) { console.error(e); }
      i += 1;
    };
    tick();
    tipTimer = setInterval(tick, sc.tip);
    if (opts.onReady) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          let after = null;
          try { after = opts.onReady(); } catch (e) { console.error(e); }
          if (typeof after === 'function') { const prev = closing; closing = function () { if (prev) prev(); after(); }; }
        });
      });
    }
  }

  CM.LoadPage = {
    open: open,
    show: function (o) { open(o); },
    finish: finish,
    isOpen: function () { return !!root; },
    SCENES: SCENES,
    platform: platform,
  };

  // 启动时立即挂遮罩：主脚本还要跑一长串初始化，等它调用 show() 时主界面可能已经画出来了
  open({ scene: 'boot', skippable: false, onDone: function () { if (CM.onLoadPageDone) CM.onLoadPageDone(); } });
})(window.CM = window.CM || {});
