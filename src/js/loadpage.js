'use strict';
// 启动加载页：系统 logo + 进度条，驻留 15s 后进入主界面；提示每 3s 换一条，进度条先慢到 70% 再收尾
(function (CM) {
  const U = CM.U, h = U ? U.h : null;
  const CFG = CM.CFG || { GAME_VERSION: '2.0.0' };
  const REPO = 'https://github.com/CantLiLi/city-and-metro-ce';
  const HOLD_MS = 15000;
  const TIP_MS = 3000;
  const WARM_MS = 11000;   // 慢速爬到 70%
  const WARM_PCT = 70;
  const FIN_MS = 1600;     // 收尾冲到 100%

  const TIPS = [
    { t: '正在准备城市数据与地铁线路，请稍候' },
    { t: '建议最大化或全屏窗口游玩' },
    { t: '本版本基于原版 v' + CFG.GAME_VERSION + ' 修改' },
    { t: '有问题请反馈到本项目的 GitHub 仓库，而不是官方仓库。', link: REPO },
  ];

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

  let root = null, finished = false, holdTimer = null, tipTimer = null, finTimer = null;

  function mount() {
    if (root || finished || !document.body) return null;
    const tipEl = h('div', { class: 'lp-tip' });
    const barFill = h('i');
    root = h('div', { class: 'loadpage', id: 'loadpage', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'lp-stage' },
        h('img', { class: 'lp-logo', src: LOGO[platform()], alt: '城市与地铁' }),
        h('div', { class: 'lp-title' }, '城市与地铁'),
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

  function cleanup() {
    clearTimeout(holdTimer); clearTimeout(finTimer); clearInterval(tipTimer);
    if (root) { root.classList.add('is-out'); const el = root; root = null; setTimeout(function () { el.remove(); }, 360); }
    document.removeEventListener('keydown', onKey, true);
  }

  function finish() {
    if (finished) return;
    finished = true;
    cleanup();
    if (CM.onLoadPageDone) CM.onLoadPageDone();
  }

  function onKey(e) { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') finish(); }

  function show(opts) {
    opts = opts || {};
    if (finished || root) { if (opts.onDone) opts.onDone(); return; }
    const ui = mount();
    if (!ui) { if (opts.onDone) opts.onDone(); return; }
    const tipEl = ui.tipEl, barFill = ui.barFill;
    // 两段式：先慢速爬到 70%，再快速收尾到 100%，最后留一小段满格
    barFill.style.transition = 'width ' + WARM_MS + 'ms cubic-bezier(.3,.05,.55,.95)';
    requestAnimationFrame(function () { requestAnimationFrame(function () { barFill.style.width = WARM_PCT + '%'; }); });
    finTimer = setTimeout(function () {
      barFill.style.transition = 'width ' + FIN_MS + 'ms cubic-bezier(.55,.05,.25,1)';
      barFill.style.width = '100%';
    }, WARM_MS);
    let i = 0;
    setTip(tipEl, TIPS[i]);
    tipTimer = setInterval(function () {
      i = (i + 1) % TIPS.length;
      setTip(tipEl, TIPS[i]);
    }, TIP_MS);
    holdTimer = setTimeout(finish, HOLD_MS);
    document.addEventListener('keydown', onKey, true);
  }

  CM.LoadPage = { show: show, finish: finish, isOpen: function () { return !!root; }, TIPS: TIPS, platform: platform };
})(window.CM = window.CM || {});
