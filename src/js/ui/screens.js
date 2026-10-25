'use strict';
// 全屏界面：开始界面、选择地图、地图信息、开局简报、更新公告
(function (CM) {
  const U = CM.U, CFG = CM.CFG, UI = CM.UI;
  const h = U.h, ic = CM.icon;
  const snd = function (name) { if (CM.Sound) CM.Sound.play(name); };
  const LEVEL = ['入门', '普通', '进阶', '挑战'];

  // 公告是否已读（本机记录；无法访问本地存储时视为已读，不打扰）
  const NEWS_KEY = 'cm1.newsSeen';
  const newsSeen = function () { try { return localStorage.getItem(NEWS_KEY) === CFG.GAME_VERSION; } catch (e) { return true; } };
  const markNews = function () { try { localStorage.setItem(NEWS_KEY, CFG.GAME_VERSION); } catch (e) { /* ignore */ } };
  UI.prototype.newsUnread = function () { return !newsSeen(); };

  // 难度：点 + 文字
  const levelEl = function (n) {
    const d = h('span', { class: 'lvl', 'data-tip': '难度：' + LEVEL[n - 1] });
    for (let k = 1; k <= 4; k++) d.appendChild(h('i', { class: k <= n ? 'on' : '' }));
    d.appendChild(h('b', null, LEVEL[n - 1]));
    return d;
  };
  const REPO_ISSUES = 'https://github.com/CantLiLi/city-and-metro-ce/issues';

  // ======================== 开始界面 ========================
  // 标题装饰：线路、车站与城市剪影
  const TITLE_DECO = '<svg class="title-deco" viewBox="0 0 400 34" preserveAspectRatio="xMinYMid meet" aria-hidden="true"><path d="M150 22 H222 M290 22 H392" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>' +
    '<circle cx="168" cy="22" r="4.5" style="fill:var(--bg)" stroke="currentColor" stroke-width="2.4"/><circle cx="208" cy="22" r="4.5" style="fill:var(--bg)" stroke="currentColor" stroke-width="2.4"/>' +
    '<g fill="currentColor"><rect x="228" y="12" width="7" height="12" rx="1"/><rect x="237" y="6" width="8" height="18" rx="1"/><rect x="247" y="0" width="8" height="24" rx="1"/><rect x="257" y="8" width="7" height="16" rx="1"/><rect x="266" y="3" width="8" height="21" rx="1"/><rect x="276" y="13" width="7" height="11" rx="1"/></g>' +
    '<circle cx="308" cy="22" r="4.5" style="fill:var(--bg)" stroke="currentColor" stroke-width="2.4"/><circle cx="348" cy="22" r="4.5" style="fill:var(--bg)" stroke="currentColor" stroke-width="2.4"/></svg>';

  UI.prototype.showStart = function (opts) {
    const self = this;
    opts = opts || {};
    const latest = CM.Save.resume();
    const cont = latest;
    const storageOk = CM.Save.available();
    if (CM.Save.isDesktop() && !cont) console.warn('[存档] 没取到最新存档：', CM.Save.newestError() || '外壳返回空');
    const btn = function (icon, label, onclick, opts) {
      opts = opts || {};
      return h('button', { class: 'start-btn' + (opts.primary ? ' primary' : ''), disabled: opts.disabled ? true : null, onclick: onclick },
        ic(icon), h('span', { class: 'lb' }, label), opts.sub ? h('span', { class: 'sub' }, opts.sub) : null, ic('chev', 18, 'chev'));
    };
    const title = h('h1', { class: 'start-title' }, '城市', h('span', { class: 'yu' }, '与'), '地铁');
    const edition = h('div', { class: 'start-edition' }, 'Community Edition');
    const wrap = h('div', { class: 'start-wrap' },
      title, edition, h('div', { html: TITLE_DECO }),
      h('div', { class: 'start-menu' },
        btn('play', '开始游戏', function () { self.showModeSelect(); }, { primary: true, sub: '选择游戏模式' }),
        btn('clock', '继续游戏', function () { if (cont) self.loadLatest(); else self.showSaveManager(); }, { disabled: !cont, sub: cont ? ((CM.MAPS[cont.map || 'gz'] || {}).name || '') + ' · ' + cont.date[0] + '年' + cont.date[1] + '月' : '暂无存档' }),
        btn('gear', '设置', function () { self.showSettings(); }),
        btn('power', '退出', function () { self.quitGame(); })),
      CM.MAPS.tutorial ? h('button', { class: 'start-learn', onclick: function () { self._mapSel = 'tutorial'; self.showMapSelect('tutorial', 'free'); } }, ic('help', 16), h('span', null, '第一次玩？先试试'), h('b', null, '新手教程 · 青湾'), ic('chev', 14)) : null,
      !storageOk ? h('div', { class: 'callout bad', style: { marginTop: '14px' } }, ic('error'), h('div', { class: 'ct' }, '当前浏览器禁止本地存储，进度将无法自动保存。')) : null,
      h('div', { class: 'start-foot' }, '规划地铁、改变出行、塑造城市。', h('br'),
        h('a', { href: 'LICENSE.txt', target: '_blank', rel: 'noopener' }, '© 2026 VinsonFung · 仅限非商业使用'), h('br'),
        h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, '地图 © OpenStreetMap 贡献者 · ODbL'), ' · v' + CFG.GAME_VERSION),
      h('div', { class: 'start-foot start-feedback' }, h('a', { href: REPO_ISSUES, target: '_blank', rel: 'noopener' }, ic('help', 13), '遇到问题？点此反馈')));
    // 右上角：更新公告 + 深浅模式（同一组按钮）
    const news = h('button', { class: 'corner-btn' + (newsSeen() ? '' : ' dot'), 'data-tip': '更新公告', 'aria-label': '更新公告', onclick: function () { self.showNews(function () { self.showStart(); }); } }, ic('megaphone'));
    this.startTheme = h('button', { class: 'corner-btn', 'aria-label': '切换深浅模式', onclick: function () { self.toggleTheme(); } });
    const corner = h('div', { class: 'start-corner' }, news, this.startTheme);
    // start-stage：主菜单与地图详情二选一的舞台，地图列表从右侧滑出时详情在这里出现
    this.openScreen(h('div', { class: 'start-root' }, h('div', { class: 'start-stage' }, wrap), corner), null, 'start' + (opts.noAnim ? ' noanim' : ''));
    this.renderThemeBtns();
  };

  // ======================== 选择游戏模式 ========================
  // 自由建造只需选地图；经营挑战要再选一条难度档
  UI.prototype.showModeSelect = function () {
    const self = this;
    const back = function () { self.showStart(); };
    const card = function (icon, badge, title, desc, onclick) {
      return h('button', { class: 'mode-card', onclick: function () { snd('click'); onclick(); } },
        h('span', { class: 'mode-ico ' + badge }, ic(icon)),
        h('div', { class: 'mode-tx' }, h('b', null, title), h('small', null, desc)));
    };
    const left = h('div', { class: 'msel-left' },
      h('div', { class: 'msel-head' }, h('button', { class: 'iconbtn', 'data-tip': '返回主菜单', 'data-key': 'Esc', onclick: back }, ic('back')), h('h2', null, '选择游戏模式'), h('span', { class: 'grow' })),
      h('div', { class: 'msel-lh' }, ic('flag', 14), '模式'),
      h('div', { class: 'mode-list' },
        card('sparkle', 'b-teal', '自由建造', '不限资金，随意布线看效果', function () { self._mode = 'free'; self.showMapSelect(null, 'free'); }),
        card('trophy', 'b-orange', '经营挑战', '有限资金、任务目标与拨款结算', function () { self._mode = 'challenge'; self.showMapSelect(null, 'challenge'); })),
      h('div', { class: 'mode-sep' }),
      h('div', { class: 'msel-lh' }, ic('folder', 14), '以前的存档'),
      this.oldSaveList(),
      h('div', { class: 'msel-note' }, '存档可以直接打开，也可以继续在该进度上玩。'));
    this.openSheet(h('div', { class: 'card msel-card', tabindex: '-1' }, left), { esc: function () { self.closeSheet(); }, back: back });
  };
  // 选定模式下方：直接列出存档目录里的所有存档（跨地图、跨模式），点一条就打开
  UI.prototype.oldSaveList = function () {
    const self = this;
    const box = h('div', { class: 'old-list' });
    const all = CM.Save.list();
    if (!all.length) {
      box.appendChild(h('div', { class: 'note' }, CM.Save.indexOk() ? '还没有任何存档。' : CM.Save.describeFailure()));
      return box;
    }
    for (const gm of all) {
      const mp = CM.MAPS[gm.map || 'gz'] || {};
      for (const sl of gm.slots) {
        const free = sl.mode === 'free';
        const kind = sl.kind === 'auto' ? '自动' : sl.kind === 'backup' ? '备份' : '手动';
        box.appendChild(h('button', { class: 'old-row', title: sl.key || sl.slotId, onclick: function () {
          snd('click');
          self.showLoading('正在打开存档…');
          CM.Save.load(sl.slotId).then(function (d) { self.closeSheet(); CM.loadGame(d); }, function (e) {
            self.closeSheet();
            self.toast((e && e.message) || '存档读不出来', 'bad');
          });
        } },
          h('span', { class: 'badge ' + (free ? 'b-teal' : 'b-orange') }, ic(free ? 'sparkle' : 'trophy')),
          h('div', { class: 'old-tx' },
            h('b', null, gm.name),
            h('small', null, (mp.name || gm.map || '') + ' · ' + sl.date[0] + '年' + sl.date[1] + '月 · ' + kind + ' · ' + (sl.label || ''))),
          h('span', { class: 'tag' }, free ? '自由' : '经营'),
          ic('chev', 16)));
      }
    }
    return box;
  };

  // ======================== 选择地图 ========================
  // 选中即进入：点哪张地图就用哪张开局
  UI.prototype.showMapSelect = function (selId, mode, diff) {
    const self = this, all = CM.MAP_ORDER.slice();
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    let cur = mode || this._mode || 'challenge';
    const back = function () { self.showModeSelect(); };

    const start = function (id) {
      const mp = CM.MAPS[id], y0 = mp.cfg.START.y;
      self._mapSel = id;
      snd('build');
      if (mp.tutorial) CM.newGame({ map: id, mode: 'free', tutorial: true, name: '新手教程 · ' + mp.data.city });
      else if (cur === 'free') CM.newGame({ map: id, mode: 'free', name: '自由建造 · ' + mp.data.city + ' ' + y0 });
      else CM.newGame({ map: id, mode: 'challenge', diff: diff || self._diff || 'normal', name: '经营挑战 · ' + mp.data.city + ' ' + y0 });
    };
    const latest = function (id) {
      const sl = CM.Save.latest(id);
      if (!sl) return null;
      return h('button', { class: 'map-mode sub', onclick: function (e) { e.stopPropagation(); snd('click'); CM.Save.load(sl.slotId).then(function (d) { CM.loadGame(d); }, function (err) { self.toast(err && err.message ? err.message : '存档读不出来', 'bad'); }); } },
        h('span', { class: 'badge b-slate' }, ic('play')), h('div', { class: 'grow' }, h('b', null, '继续进度'), h('small', null, (sl.mode === 'free' ? '自由建造' : '经营挑战') + ' · ' + sl.date[0] + '年' + sl.date[1] + '月')),
        h('span', { class: 'tag info' }, '最近'), ic('chev', 16));
    };
    const list = h('div', { class: 'msel-list', role: 'listbox', 'aria-label': '地图' });
    const wraps = {};
    const mark = function () {
      for (const id in wraps) {
        const on = String(id) === String(selId);
        const w = wraps[id];
        w.it.classList.toggle('on', on);
        w.it.setAttribute('aria-selected', on ? 'true' : 'false');
        w.el.classList.toggle('open', on);
        if (on && !w.modes.childElementCount) { const l = latest(id); if (l) w.modes.appendChild(l); }
      }
    };
    for (const id of all) {
      const mp = CM.MAPS[id], n = CM.Save.list(id).length;
      const it = h('button', { class: 'msel-item', role: 'option', 'data-id': id, onclick: function () { start(id); } },
        h('span', { class: 'msel-thumb' }, h('img', { alt: '', src: CM.mapThumb(id, theme) || '' }), mp.tutorial ? h('span', { class: 'msel-flag' }, '教程') : null),
        h('span', { class: 'msel-it' },
          h('b', null, mp.title || mp.name),
          h('small', null, mp.tagline || mp.sub),
          h('span', { class: 'msel-meta' }, h('span', { class: 'tag' }, mp.region || ''), levelEl(mp.difficulty || 2), n ? h('span', { class: 'msel-prog' }, ic('save', 12), n + ' 个进度') : null)),
        ic('chev', 16));
      const modes = h('div', { class: 'msel-modes' });
      const el = h('div', { class: 'msel-map' }, it, modes);
      wraps[id] = { el: el, it: it, modes: modes };
      list.appendChild(el);
    }
    let sel = selId && CM.MAPS[selId] ? selId : null;
    const left = h('div', { class: 'msel-left' },
      h('div', { class: 'msel-head' }, h('button', { class: 'iconbtn', 'data-tip': '重新选择模式', 'data-key': 'Esc', onclick: back }, ic('back')), h('h2', null, '选择地图'), h('span', { class: 'grow' }), h('span', { class: 'msel-count' }, '共 ' + all.length + ' 张地图')),
      h('div', { class: 'msel-lh' }, ic('map', 14), cur === 'free' ? '自由建造' : '经营挑战', h('span', { class: 'tiny muted' }, '点击地图开始')),
      list,
      h('div', { class: 'msel-note' }, '每张地图的进度与存档各自独立。'));
    mark();
    const card = h('div', { class: 'card msel-card', tabindex: '-1' }, left);
    const ids = all.slice();
    let focused = sel || ids[0];
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.key === 'Enter') { start(focused); return; }
      const k = ids.indexOf(focused);
      focused = ids[(k + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length];
      selId = focused;
      mark();
      const w = wraps[focused];
      if (w && w.el.scrollIntoView) w.el.scrollIntoView({ block: 'nearest' });
    });
    this.openSheet(card, { esc: function () { self.closeSheet(); }, back: back });
    requestAnimationFrame(function () { card.focus({ preventScroll: true }); });
  };

  // ======================== 地图信息 ========================
  // 当前地图的来历、范围、特色与年表：进入游戏后从右上角「地图信息」打开
  UI.prototype.showMapInfo = function () {
    const self = this, id = (this.g() && this.g().mapId) || CM.mapId;
    const mp = CM.MAPS[id]; if (!mp) return;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const fmtDate = function (sl) { return sl.date[0] + '年' + sl.date[1] + '月'; };
    const y0 = mp.cfg.START.y;
    const close = function () { self.closeScreen(); };

    const fl = (mp.facts || []).filter(function (f) { return f[0] !== '模式'; }).slice();
    const mc = mp.cfg.macro && mp.cfg.macro !== 'auto' ? mp.cfg.macro : null;
    if (mc && mc.gdp0) { const mo = mp.cfg.money, v = mc.gdp0; fl.push(['开局 GDP', '约 ' + (v >= 1e8 ? (v / 1e8).toFixed(2) + ' 万' + mo.yi : U.fmtMoney(v, 0, mo))]); }
    const facts = h('div', { class: 'msel-facts' }, fl.map(function (f) { return h('div', null, h('span', null, f[0]), h('b', { title: f[1] }, f[1])); }));
    const feats = h('div', { class: 'msel-feats' }, (mp.features || []).map(function (f, k) {
      return h('div', { class: 'msel-feat', style: { animationDelay: (0.04 * k) + 's' } }, h('span', { class: 'badge ' + ['b-blue', 'b-teal', 'b-orange', 'b-violet'][k % 4] }, ic(f[0])), h('div', null, h('b', null, f[1]), h('small', null, f[2])));
    }));
    const hl = [[y0, '开局']].concat(mp.highlights || []);
    const tl = h('div', { class: 'msel-tl' }, hl.map(function (e, k) {
      return h('div', { class: 'msel-ev' + (k === 0 ? ' start' : '') }, h('b', null, String(e[0])), h('i'), h('span', null, e[1]));
    }));
    const block = function (icon, badge, title, kids) { return h('section', { class: 'msel-block' }, h('div', { class: 'msel-bh' }, h('span', { class: 'badge ' + badge }, ic(icon, 15)), h('b', null, title)), kids); };
    const games = CM.Save.list(id), latest = CM.Save.latest(id);
    const progress = games.length ? games.length + ' 个进度 · 最近 ' + (latest ? fmtDate(latest) : '—') : (mp.tutorial ? '还没有开始教程' : '还没有进度');
    const hero = h('div', { class: 'msel-hero' },
      h('img', { alt: '', src: CM.mapThumb(id, theme) || '' }),
      h('div', { class: 'msel-hero-tx' },
        h('div', { class: 'msel-kicker' }, h('span', null, mp.region || ''), h('i'), h('span', null, y0 + ' 年起'), h('i'), h('span', null, mp.kind === 'fictional' || mp.tutorial ? '虚构城市' : '真实地理')),
        h('h2', null, mp.title || mp.name),
        h('div', { class: 'msel-tagline' }, mp.tagline || mp.sub),
        h('div', { class: 'msel-chips' }, levelEl(mp.difficulty || 2), (mp.tags || []).map(function (t) { return h('span', { class: 'tag glass-tag' }, t); }))));

    const card = h('div', { class: 'card mapinfo' },
      h('div', { class: 'card-head' }, h('span', { class: 'badge b-blue' }, ic('map')),
        h('div', { class: 'grow' }, h('h2', null, '地图信息'), h('div', { class: 'tiny muted' }, (mp.name || '') + ' · ' + progress)),
        h('button', { class: 'iconbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: close }, ic('close'))),
      h('div', { class: 'msel-scroll' }, hero,
        block('info', 'b-blue', '城市概况', [h('p', { class: 'msel-intro' }, mp.intro || mp.desc), facts]),
        block('sparkle', 'b-violet', '地图特色', feats),
        block('calYear', 'b-orange', '大事年表', tl)));
    this.openScreen(card, close);
    // 地图信息只做查看：点卡片外的空白处不关闭，只认关闭按钮与 Esc
    this.screen.onpointerdown = null;
  };


  // ======================== 开局简报 ========================
  // 新开存档时：这座城市当时的交通格局、你的起点与首批任务；之后可在日期面板或菜单中再次查看
  UI.prototype.showBriefing = function (after) {
    const self = this, g = this.g(), D = CM.DATA, B = D.briefing, mp = CM.curMap();
    if (!g || !B) { if (after) after(); return; }
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const done = function () { self.closeScreen(); if (after) after(); };
    const city = g.city, tot = city.totals();
    let open = 0, regs = 0; for (let k = 0; k < city.regions.length; k++) { if (city.regions[k].scenic) continue; regs++; if (city.regionOpen[k]) open++; }
    const y0 = CFG.START.y;
    const hero = h('div', { class: 'brief-hero' }, h('img', { alt: '', src: CM.mapThumb(mp.id, theme) || '' }),
      h('div', { class: 'brief-hero-tx' }, h('div', { class: 'msel-kicker' }, h('span', null, '开局简报'), h('i'), h('span', null, y0 + ' 年 1 月')), h('h2', null, (D.city || mp.name) + ' · ' + y0), h('div', { class: 'msel-tagline' }, mp.tagline || '')));
    const parts = [hero];
    // 东京等：开局接管既有地铁
    if (B.inherit && g.mapInit && g.mapInit.metro) {
      const n = CM.Milestones ? CM.Milestones.netInfo(g) : null, L = Object.values(g.net.lines)[0];
      parts.push(h('div', { class: 'brief-inherit', style: { '--lc': (L && L.color) || 'var(--accent)' } },
        h('span', { class: 'bi-line' }), h('span', { class: 'badge' }, ic('train')),
        h('div', { class: 'grow' }, h('b', null, '你接管了' + (L ? L.name : '既有地铁')), h('small', null, g.mapInit.metro)),
        h('div', { class: 'bi-stats' },
          h('div', null, h('b', null, String(Object.keys(g.net.stations).length)), h('span', null, '座车站')),
          n ? h('div', null, h('b', null, U.fmtNum(n.km, 1)), h('span', null, '公里')) : null,
          g.model.daily && g.model.daily.metro ? h('div', null, h('b', null, U.fmtPeople(g.model.daily.metro)), h('span', null, '日客运（人次）')) : null)));
    }
    parts.push(h('p', { class: 'brief-lead' }, B.lead));
    parts.push(h('div', { class: 'msel-sec' }, ic('bus', 15), '当前交通格局'));
    parts.push(h('div', { class: 'brief-modes' }, (B.modes || []).map(function (m, k) {
      return h('div', { class: 'brief-mode', style: { animationDelay: (0.05 * k) + 's' } }, h('span', { class: 'badge ' + ['b-blue', 'b-teal', 'b-orange', 'b-violet'][k % 4] }, ic(m[0])), h('div', null, h('b', null, m[1]), h('small', null, m[2])));
    })));
    // 开局之后再次查看：起点数据改为当前情况
    const atStart = g.history.length <= 1;
    parts.push(h('div', { class: 'msel-sec' }, ic('flag', 15), atStart ? '你的起点' : '现在（' + g.clock.y + '年' + g.clock.m + '月）'));
    const free = g.econ.isFree();
    parts.push(h('div', { class: 'msel-facts brief-facts' },
      h('div', null, h('span', null, '模式'), h('b', null, free ? '自由建造' : '经营挑战')),
      h('div', null, h('span', null, free ? '资金' : '可用资金'), h('b', null, free ? '不限' : U.fmtMoney(g.econ.funds))),
      h('div', null, h('span', null, '人口'), h('b', null, U.fmtPeople(tot.pop))),
      h('div', null, h('span', null, '已开放区域'), h('b', null, open + ' / ' + regs)),
      h('div', null, h('span', null, '票价'), h('b', null, CFG.money.sym + g.econ.fare.flat)),
      g.macro && CM.Macro ? (function () { const mv = CM.Macro.view(g); return h('div', { 'data-tip': '地图范围的经济规模（估算），每年 1 月结算上一年' }, h('span', null, '城市经济'), h('b', null, (mv.last ? mv.last.y + ' 年 ' + UI.fmtBig(mv.last.nom) : '约 ' + UI.fmtBig(mv.fc.nom)) + ' · ' + mv.env.label)); })() : null));
    const tasks = (g.tasks.active || []).slice(0, 3);
    if (tasks.length) {
      parts.push(h('div', { class: 'msel-sec' }, ic('tasks', 15), atStart ? '首批任务' : '进行中的任务'));
      parts.push(h('div', { class: 'brief-tasks' }, tasks.map(function (t) { return h('div', null, ic('flag', 14), h('b', null, t.title), t.deadline ? h('span', null, '截止 ' + t.deadline[0] + '年' + t.deadline[1] + '月') : null); })));
    }
    const card = h('div', { class: 'card brief' },
      h('div', { class: 'brief-scroll' }, parts),
      h('div', { class: 'brief-acts' },
        h('span', { class: 'tiny muted grow' }, '游戏已暂停。之后可在日期面板或菜单中再次查看简报。'),
        h('button', { class: 'btn', onclick: function () { self.closeScreen(); self.openPage('tasks', null, { root: true }); } }, ic('tasks'), '查看任务'),
        h('button', { class: 'btn primary', onclick: done }, '开始规划', ic('arrowR'))));
    this.openScreen(card, done, 'brief-screen');
  };

  // ======================== 经济知识：经营挑战的财政与债券（教程与操作说明中可回看；只说明，不实际发行） ========================
  UI.prototype.econGuide = function () {
    const sec = function (icon, badge, title, items) {
      return h('div', { class: 'eg-sec' }, h('div', { class: 'eg-h' }, h('span', { class: 'badge ' + badge }, ic(icon)), h('b', null, title)), h('ul', null, items.map(function (t) { return h('li', null, t); })));
    };
    return h('div', { class: 'eg' },
      sec('coin', 'b-green', '钱从哪里来', ['政府拨款：每月初发放一次，= 基础额度 × 财力系数 × 满意度系数 × 任务修正。', '票款：每天按乘客数与票价结算。', '任务奖励：完成历史与动态任务时发放。']),
      sec('trend', 'b-violet', '城市经济怎样影响拨款', ['真实城市会模拟地图范围的 GDP、经济周期和历史经济事件（如石油危机、亚洲金融危机、全球金融危机），每年 1 月结算上一年。', 'GDP 不等于财政收入：地方财政收入约为 GDP 的一定比例，其中只有一部分安排给地铁。上一年财政收入高于预期，当年拨款的财力系数就高于 1，反之低于 1（限定在 ×0.70–1.30）。', '好的地铁能缩短通勤、缓解拥堵、提高可达性，从而小幅提高生产率；但建了地铁不一定增长，也抵消不了外部危机。']),
      sec('hammer', 'b-orange', '钱花在哪里', ['建设与拆迁：确认建设时一次支付。', '运营成本：列车运行与车站，每天结算。线路越长、车站越多，成本越高。']),
      sec('wallet', 'b-violet', '债券融资', ['地方债利率较低、额度较大；城投债利率较高、额度较小。', '新发行的利率随年代的市场利率、经济环境和本市财政状况浮动：财政稳健时更低，负债偏高、财力不足或有逾期时更高。', '期限 3 年或 6 年，利率在发行时锁定，之后按合同付息，不受报价变化影响；每年付一次利息，到期一次还本。', '借来的钱不算收入：进入「建设专项资金」，只能用于地铁建设及改扩建，不能拿来付运营成本或利息。', '每年能发行的额度与总债务都有上限，随城市、年代与财力变化。']),
      sec('warn', 'b-red', '还不上会怎样', ['利息与本金从一般资金支付；资金不足的部分记为逾期。', '逾期每月收取额外费用，并暂停城投债；逾期满 6 个月暂停全部发债。', '不会因为一次逾期就失败，一般资金有余额时会自动还清。挑战失败只看长期负余额、负债下限与满意度。']),
      sec('cursor', 'b-blue', '怎么操作', ['点顶栏的「资金」打开「财政与经济」面板：概览、经济、财政、融资四个分页。', '在「融资」页查看利率报价与构成，点「发行债券」选择种类、期限与金额，确认前会显示每年利息与到期日。', '「经济」页列出 GDP、增长来源、交通对经济的影响与正在发生的经济事件；统计窗口（G）的「经济」页有历年图表。']),
      h('div', { class: 'note' }, '青湾教程使用自由建造（资金不限），不模拟城市经济，这里只做说明，不会实际发行债券。可以在「菜单 → 操作说明」中随时回看。'));
  };
  UI.prototype.showEconGuide = function (onClose) {
    const self = this, close = function () { self.closeScreen(); if (onClose) onClose(); };
    const card = h('div', { class: 'card eg-card' },
      h('div', { class: 'card-head' }, h('span', { class: 'badge b-gold' }, ic('coin')), h('div', { class: 'grow' }, h('h2', null, '经营挑战的财政'), h('div', { class: 'tiny muted' }, '经济小知识 · 可随时回看')), h('button', { class: 'iconbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: close }, ic('close'))),
      this.econGuide(),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: close }, '知道了')));
    this.openScreen(card, close);
  };

  // ======================== 更新公告 ========================
  UI.prototype.showNews = function (onBack) {
    const self = this;
    const close = function () { if (onBack) onBack(); else self.closeScreen(); };
    markNews();
    const list = h('div', { class: 'news-list' });
    // 桌面版：当前版本的条目由 about.py 的 UPDATE_INFO 提供
    if (window.__CM_UPDATE_INFO__ && window.__CM_UPDATE_INFO__.length) {
      const body = h('ul', { class: 'news-b' }, window.__CM_UPDATE_INFO__.map(function (t) { return h('li', null, t); }));
      if (self.open['news-cur'] === undefined) self.open['news-cur'] = true;
      const sec = self.sec('news-cur', '', '', function () { return body; }, true);
      const head = sec.querySelector('.sec-h');
      head.replaceChildren.apply(head, [h('span', { class: 'news-v cur' }, 'v' + CFG.GAME_VERSION), h('span', { class: 'news-t' }, '本版本更新'), h('span', { class: 'tag good' }, '最新'), ic('chev', 14, 'chev')].filter(Boolean));
      list.appendChild(sec);
    }
    (CM.NEWS || []).forEach(function (v, k) {
      // 每个版本只列主要变化（篇幅统一）
      const body = h('ul', { class: 'news-b' }, (v.items || []).map(function (t) { return h('li', null, t); }));
      // 复用详情面板的折叠区块：最新版本默认展开
      const key = 'news-' + v.v;
      if (self.open[key] === undefined) self.open[key] = k === 0;
      const sec = self.sec(key, '', '', function () { return body; }, k === 0);
      const head = sec.querySelector('.sec-h');
      // 原生 replaceChildren 会把 null 写成文字，这里只传实际存在的节点
      head.replaceChildren.apply(head, [h('span', { class: 'news-v' + (k === 0 ? ' cur' : '') }, 'v' + v.v), h('span', { class: 'news-t' }, v.title), k === 0 ? h('span', { class: 'tag good' }, '最新') : null, h('span', { class: 'news-d' }, v.date), ic('chev', 14, 'chev')].filter(Boolean));
      list.appendChild(sec);
    });
    if (!list.firstChild) list.appendChild(h('div', { class: 'tiny muted' }, '暂无更新记录'));
    const card = h('div', { class: 'card news' },
      h('div', { class: 'card-head' }, h('span', { class: 'badge b-violet' }, ic('megaphone')), h('div', { class: 'grow' }, h('h2', null, '更新公告'), h('div', { class: 'tiny muted' }, '当前版本 v' + CFG.GAME_VERSION)),
        h('button', { class: 'iconbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: close }, ic('close'))),
      list);
    this.openScreen(card, close);
  };
})(window.CM);
