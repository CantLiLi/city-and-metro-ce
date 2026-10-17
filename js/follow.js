'use strict';
// 列车跟随模式：点击地图上行驶的列车，镜头平滑跟随它运行；底部卡片显示线路、方向、下一站、速度与所处位置
// （地下 / 地面 / 高架、跨江、停站）。进入地下区间时自动切换到地下视图。H 隐藏界面（只留一行字幕），Esc 或拖动地图退出。
(function (CM) {
  const U = CM.U, h = U.h, CFG = CM.CFG;
  const ic = function (n, s) { return CM.icon(n, s); };
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };
  let ui = null, R = null, t = null, card = null, hidden = false, under0 = 0, autoUnder = false, lastInfo = 0, lineId = null, routeR = -1;
  const TYPE = { underground: '地下', surface: '地面', elevated: '高架' };

  function trains() { return CM.agents ? CM.agents.trains : []; }
  // 当前位置信息
  function info() {
    const A = CM.agents, net = A.netRef, g = CM.game;
    if (!t || !t.g || !net || !g) return null;
    const rt = t.g.rt, L = t.g.legs[t.leg], n = rt.stIdx.length, C = net.C;
    const pos = A.trainPos(t, {}), p = {};
    U.posAt(rt.pts, rt.cum, pos.d, p);
    const nextIdx = rt.loop ? (L.rev ? rt.stIdx[L.k] : rt.stIdx[(L.k + 1) % n]) : (L.rev ? rt.stIdx[L.k] : rt.stIdx[L.k + 1]);
    const prevIdx = rt.loop ? (L.rev ? rt.stIdx[(L.k + 1) % n] : rt.stIdx[L.k]) : (L.rev ? rt.stIdx[L.k + 1] : rt.stIdx[L.k]);
    const term = rt.loop ? null : C.stations[L.rev ? rt.stIdx[0] : rt.stIdx[n - 1]];
    const seg = rt.segRefs[L.k], sd = seg && C.segs.get(seg.id), type = sd ? sd.seg.type : 'underground';
    const hh = A.heightAt(rt, p);
    const v = A.trainSpeed(t);
    const dwell = t.t >= L.T, hold = t.t < 0;
    const water = g.city.waterAt(p.x, p.y) ? g.city.riverNameAt(p.x, p.y) : null;
    const rg = g.city.regionAt(p.x, p.y);
    let lf = 0;
    const model = g.model, W = A.W, f = W ? model.freqAt(t.g.r, W) : 0;
    if (f > 0 && net.rideEdge[t.g.r]) lf = model.edgeLoadAt(net.rideEdge[t.g.r][2 * L.k + (L.rev ? 1 : 0)], W) / (f * rt.cap);
    return {
      x: p.x, y: p.y, h: hh, rt: rt, line: rt.line, type: type, v: v, dwell: dwell, hold: hold, water: water,
      next: C.stations[nextIdx], prev: C.stations[prevIdx], term: term, loopDir: rt.loop ? (t.g.dir === 0 ? '顺行' : '逆行') : null,
      toNext: Math.abs(L.d1 - pos.d) * CFG.CELL_M, region: rg ? rg.name.replace(/（.*）/, '') : '', lf: lf, cars: rt.cars,
    };
  }
  const stn = function (s) { return /站$/.test(s.name) ? s.name : s.name + '站'; };
  function statusText(o) {
    if (o.hold) return '在' + stn(o.prev) + '等候发车';
    if (o.dwell) return '停靠' + stn(o.next);
    if (o.water) return (o.type === 'underground' ? '在' + o.water + '江底隧道中穿行' : '正在跨越' + o.water + (o.type === 'elevated' ? '（高架桥）' : '（桥梁）'));
    const where = o.type === 'underground' ? '地下区间' : (o.type === 'elevated' ? '高架区间' : '地面区间');
    return '驶向' + stn(o.next) + ' · ' + where + (o.region ? ' · ' + o.region : '');
  }
  function render(o) {
    if (!card) return;
    const g = CM.game, paused = !g || g.speed === 0;
    card.innerHTML = '';
    const L = o.line, num = String(L.num || L.name.replace(/[^0-9]/g, '') || '•');
    card.appendChild(h('div', { class: 'fc-head' },
      h('span', { class: 'fc-num', style: { background: L.color } }, num), h('span', { class: 'fc-line' }, L.name),
      h('span', { class: 'fc-dir' }, o.term ? '开往 ' + o.term.name : '环线 · ' + o.loopDir), h('span', { class: 'grow' }),
      paused ? h('span', { class: 'tag' }, '已暂停') : null));
    card.appendChild(h('div', { class: 'fc-status' }, statusText(o)));
    card.appendChild(h('div', { class: 'fc-grid' },
      h('div', null, '下一站', h('b', null, o.dwell ? '本站' : U.fmtNum(o.toNext / 1000, 2) + ' km')),
      h('div', null, '速度', h('b', null, Math.round(o.v * 3.6) + ' km/h')),
      h('div', null, '线路', h('b', null, TYPE[o.type] || '')),
      h('div', null, '满载率', h('b', null, o.lf > 0 ? U.fmtPct(o.lf, 0) : '—'))));
    card.appendChild(h('div', { class: 'fc-hint' }, 'H 显示界面 · Esc 退出跟随'));
    card.appendChild(h('div', { class: 'fc-acts' },
      h('button', { class: 'btn sm ghost', 'data-tip': '同一线路的上一列车', onclick: function () { Follow.cycle(-1); } }, ic('back', 14), '上一列'),
      h('button', { class: 'btn sm ghost', 'data-tip': '同一线路的下一列车', onclick: function () { Follow.cycle(1); } }, '下一列', ic('chev', 14)),
      h('button', { class: 'btn sm ghost', onclick: function () { autoUnder = !autoUnder; if (!autoUnder) setUnder(under0); render(o); } }, autoUnder ? '自动地下视图：开' : '自动地下视图：关'),
      h('span', { class: 'grow' }),
      paused ? h('button', { class: 'btn sm', onclick: function () { ui.togglePause(); } }, ic('play', 14), '继续') : null,
      h('button', { class: 'btn sm', onclick: function () { Follow.toggleUI(); } }, '隐藏界面', h('kbd', null, 'H')),
      h('button', { class: 'btn sm primary', onclick: function () { Follow.stop(); } }, '退出', h('kbd', null, 'Esc'))));
  }
  function setUnder(v) { if (R.cam.tu !== v) { R.setUnder(v === 1); if (ui) ui.renderToolbar(); } }

  const Follow = {
    used: false,
    init: function (u) { ui = u; R = u.R; },
    active: function () { return !!t; },
    // 屏幕坐标处的列车（只认本帧画出的）
    pick: function (sx, sy) {
      if (!R) return null;
      let best = null, bd = 13;
      for (const tr of trains()) {
        if (tr.dying || !tr.g || tr.drawn == null || R.frame - tr.drawn > 1 || tr.alpha < 0.3) continue;
        const d = Math.hypot(tr.sx - sx, tr.sy - sy);
        if (d < bd) { bd = d; best = tr; }
      }
      return best;
    },
    describe: function (tr) {
      const old = t; t = tr; const o = info(); t = old;
      return o ? { title: o.line.name + ' 列车', lines: [(o.term ? '开往 ' + o.term.name : '环线') + ' · ' + statusText(o), '点击跟随这列车'] } : null;
    },
    start: function (tr) {
      if (!tr || !ui) return;
      const was = !!t;
      t = tr; lineId = tr.g.rt.lineId; routeR = tr.g.r;
      Follow.used = true;
      if (!was) { under0 = R.cam.tu; autoUnder = true; }
      R.cam.fly = null; R.cam.anchor = null;
      if (!was && R.cam.tz < 30) { R.cam.tz = 32; R.cam.anchor = null; }
      R.follow = tr;
      if (!card) { card = h('div', { id: 'followCard', class: 'hud glass' }); document.getElementById('app').appendChild(card); }
      document.body.classList.add('following');
      if (ui.tools && ui.tools.tool !== 'select') ui.tools.setTool('select');
      if (!was) snd('swoosh');
      lastInfo = 0;
      Follow.tick(0);
    },
    // quiet：换地图、返回菜单等场合，不恢复视图、不提示
    stop: function (quiet) {
      if (!t && !card) return;
      t = null; if (R) R.follow = null;
      if (card) { card.remove(); card = null; }
      document.body.classList.remove('following');
      if (hidden) Follow.toggleUI(false);
      if (!quiet && R) { if (autoUnder) setUnder(under0); snd('soft'); }
    },
    toggleUI: function (on) {
      hidden = on == null ? !hidden : !!on;
      document.body.classList.toggle('cinema', hidden);
      if (hidden && ui) ui.setTooltip(null);
    },
    cycle: function (dir) {
      if (!t) return;
      const list = trains().filter(function (tr) { return !tr.dying && tr.g && tr.g.rt.lineId === lineId; }).sort(function (a, b) { return a.id - b.id; });
      if (list.length < 2) { ui.toast('这条线路目前只有这一列车在运行', 'info'); return; }
      const k = list.indexOf(t);
      Follow.start(list[(k + dir + list.length) % list.length]);
    },
    tick: function (dt) {
      if (!t) return;
      if (!CM.game) { Follow.stop(true); return; }
      // 列车下线（线路调整或减少班次）：换同一线路的另一列，没有则退出
      if (t.dying || !t.g) {
        const alt = trains().find(function (tr) { return !tr.dying && tr.g && tr.g.r === routeR; }) || trains().find(function (tr) { return !tr.dying && tr.g && tr.g.rt.lineId === lineId; });
        if (alt) { Follow.start(alt); return; }
        Follow.stop(); ui.toast('这列车已结束运营（夜间停运或线路调整），已退出跟随', 'info'); return;
      }
      const o = info(); if (!o) return;
      const c = R.cam, k = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
      c.fly = null; c.anchor = null;
      c.cx += (o.x - c.cx) * k; c.cy += (o.y - c.cy) * k;
      if (autoUnder) setUnder(o.type === 'underground' && o.h < -0.01 ? 1 : 0);
      const now = performance.now();
      if (now - lastInfo > 250) { lastInfo = now; render(o); }
    },
  };
  CM.Follow = Follow;
})(window.CM);
