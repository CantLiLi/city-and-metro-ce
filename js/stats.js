'use strict';
// 统计面板：概览指标卡 + 交通 / 城市 / 财政 / 线路图表（SVG，悬停十字线与提示、图例、表格视图）
(function (CM) {
  const U = CM.U;
  const h = U.h;
  // 分类色（固定顺序，不循环）：浅色 / 深色各自一套
  const PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  };
  const TABS = [['overview', '概览', 'chart'], ['traffic', '交通', 'metro'], ['finance', '财政', 'wallet'], ['milestones', '里程碑', 'flag']];
  let ui = null, tab = 'overview', range = 'all', isOpen = false, charts = [], body = null, sig = '';

  function pal() { return PALETTE[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light']; }
  function game() { return ui && ui.g ? ui.g() : CM.game; }
  function esc(s) { return U.esc ? U.esc(String(s)) : String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- 数据 ----------
  function liveRec(g) {
    const d = g.model.daily || {}, tot = g.city.totals();
    return {
      y: g.clock.y, m: g.clock.m, d: g.clock.d, live: true, pop: tot.pop, jobs: tot.jobs, share: d.metroShare || 0,
      cong: d.cong || 1, commute: d.commute || 0, riders: d.metro || 0, sat: g.econ.sat, funds: g.econ.isFree() ? null : g.econ.funds,
      coverage: d.coverage || 0, stations: g.compiled.stations.length, crowd: d.crowdShare || 0,
    };
  }
  function timeline(g) {
    let H = g.history.slice();
    H.push(liveRec(g));
    if (range !== 'all') H = H.slice(-(+range) - 1);
    return H;
  }
  function recLabel(r) { return r.live ? '当前 · ' + r.y + '年' + r.m + '月' + r.d + '日' : r.y + '年' + r.m + '月'; }
  function pick(H, key) { return H.map(function (r) { const v = r[key]; return v == null || !isFinite(v) ? null : v; }); }

  // ---------- 刻度 ----------
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + (Math.abs(lo) || 1); }
    const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), r = step0 / mag;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
    const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
    const t = []; for (let v = a; v <= b + step * 1e-6; v += step) t.push(+v.toFixed(10));
    return { lo: a, hi: b, ticks: t };
  }

  // ---------- 图表外壳：标题、副标题、图例、表格切换、提示框 ----------
  function shell(o, legendItems) {
    const card = h('div', { class: 'chart-card' + (o.wide ? ' wide' : '') });
    const plot = h('div', { class: 'ch-plot' });
    const tip = h('div', { class: 'ch-tip' });
    const tbl = h('div', { class: 'ch-tbl', style: { display: 'none' } });
    let tableOn = false;
    const tBtn = null;
    card.append(h('div', { class: 'ch-head' }, o.icon ? CM.icon(o.icon, 16, 'muted') : null, h('div', { class: 'ch-title' }, o.title), tBtn));
    if (o.sub) card.appendChild(h('div', { class: 'ch-sub' }, o.sub));
    if (legendItems && legendItems.length >= 2) card.appendChild(h('div', { class: 'ch-legend' }, legendItems.map(function (it) { return h('span', null, h('i', { class: it.sq ? 'sq' : '', style: { background: it.color } }), it.name); })));
    card.append(plot, tbl);
    return { card: card, plot: plot, tip: tip };
  }
  function showTip(sh, html, x, y) {
    const tip = sh.tip;
    tip.innerHTML = html; tip.style.opacity = '1';
    const W = sh.plot.clientWidth, tw = tip.offsetWidth;
    tip.style.left = (x + 14 + tw > W ? Math.max(0, x - tw - 14) : x + 14) + 'px';
    tip.style.top = Math.max(0, y) + 'px';
  }
  function hideTip(sh) { sh.tip.style.opacity = '0'; }
  function tipRows(title, rows) {
    return '<div class="tt">' + esc(title) + '</div>' + rows.map(function (r) { return '<div class="tr">' + (r.color ? '<i style="background:' + r.color + '"></i>' : '') + '<span>' + esc(r.name) + '</span><b style="margin-left:auto;padding-left:10px">' + esc(r.v) + '</b></div>'; }).join('');
  }
  function emptyState(sh, text) { sh.plot.innerHTML = ''; sh.plot.appendChild(h('div', { class: 'empty-chart' }, text)); }

  // ---------- 折线 / 面积图（单一纵轴） ----------
  function lineChart(o) {
    const sh = shell(Object.assign({}, o, { table: function () { return seriesTable(o); } }), o.series.map(function (s) { return { name: s.name, color: s.color }; }));
    const draw = function () {
      const n = o.labels.length;
      let cnt = 0, lo = Infinity, hi = -Infinity;
      for (const s of o.series) for (const v of s.vals) if (v != null) { cnt++; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (cnt < 2 || n < 2) { emptyState(sh, o.empty || '至少需要两个月的记录。继续运营后这里会显示趋势。'); return; }
      if (o.min0 !== false) lo = Math.min(0, lo);
      if (o.refs) for (const r of o.refs) { if (r.v > hi) hi = r.v; if (r.v < lo) lo = r.v; }
      if (o.max != null) hi = Math.min(Math.max(hi, lo + 1e-6), o.max);
      if (o.int && hi - lo < 4) hi = lo + 4;      // 计数类数据：刻度取整数
      const W = Math.max(260, sh.plot.clientWidth || 420), Hh = o.height || 170;
      const pl = 48, pr = 14, pt = 10, pb = 22;
      const nt = niceTicks(lo, hi, 4);
      const X = function (i) { return pl + i / (n - 1) * (W - pl - pr); };
      const Y = function (v) { return pt + (1 - (v - nt.lo) / (nt.hi - nt.lo)) * (Hh - pt - pb); };
      const af = o.axisFmt || o.fmt;
      let s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" height="' + Hh + '" font-size="10.5">';
      for (const t of nt.ticks) {
        const y = Y(t).toFixed(1);
        s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(' + (t === 0 ? '--line-strong' : '--line') + ')" stroke-width="1"/>';
        s += '<text x="' + (pl - 6) + '" y="' + y + '" dy="3.5" text-anchor="end" style="fill:var(--muted)">' + esc(af(t)) + '</text>';
      }
      const nx = Math.min(6, n), seen = {};
      for (let q = 0; q < nx; q++) {
        const i = Math.round(q / (nx - 1) * (n - 1)); if (seen[i]) continue; seen[i] = 1;
        const lab = o.xs[i], anc = q === 0 ? 'start' : (q === nx - 1 ? 'end' : 'middle');
        s += '<text x="' + X(i).toFixed(1) + '" y="' + (Hh - 5) + '" text-anchor="' + anc + '" style="fill:var(--muted)">' + esc(lab) + '</text>';
      }
      if (o.refs) for (const r of o.refs) {
        const y = Y(r.v).toFixed(1);
        s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--faint)" stroke-dasharray="4 4" stroke-width="1"/>';
        s += '<text x="' + (W - pr) + '" y="' + y + '" dy="-4" text-anchor="end" style="fill:var(--muted)">' + esc(r.label) + '</text>';
      }
      o.series.forEach(function (sr) {
        let d = '', pen = false, first = -1, last = -1;
        for (let i = 0; i < n; i++) {
          const v = sr.vals[i];
          if (v == null) { pen = false; continue; }
          const x = X(i).toFixed(1), y = Y(v).toFixed(1);
          if (!pen) { d += 'M' + x + ' ' + y; pen = true; if (first < 0) first = i; }
          else if (o.step) d += 'H' + x + 'V' + y; else d += 'L' + x + ' ' + y;
          last = i;
        }
        if (o.area && o.series.length === 1 && first >= 0) {
          const y0 = Y(Math.max(nt.lo, 0)).toFixed(1);
          s += '<path d="' + d + 'L' + X(last).toFixed(1) + ' ' + y0 + 'L' + X(first).toFixed(1) + ' ' + y0 + 'Z" fill="' + sr.color + '" fill-opacity="0.1"/>';
        }
        s += '<path d="' + d + '" fill="none" stroke="' + sr.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
        if (last >= 0) s += '<circle cx="' + X(last).toFixed(1) + '" cy="' + Y(sr.vals[last]).toFixed(1) + '" r="4" fill="' + sr.color + '" style="stroke:var(--surface-solid)" stroke-width="2"/>';
      });
      s += '<g class="hov" style="display:none"><line y1="' + pt + '" y2="' + (Hh - pb) + '" style="stroke:var(--line-strong)" stroke-width="1"/>' + o.series.map(function (sr) { return '<circle r="4.5" fill="' + sr.color + '" style="stroke:var(--surface-solid)" stroke-width="2"/>'; }).join('') + '</g>';
      s += '<rect x="' + pl + '" y="0" width="' + (W - pl - pr) + '" height="' + Hh + '" fill="transparent"/></svg>';
      sh.plot.innerHTML = s; sh.plot.appendChild(sh.tip);
      const hov = sh.plot.querySelector('.hov'), hl = hov.querySelector('line'), dots = hov.querySelectorAll('circle');
      sh.plot.onmousemove = function (e) {
        const r = sh.plot.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width;
        const i = U.clamp(Math.round((sx - pl) / (W - pl - pr) * (n - 1)), 0, n - 1);
        const x = X(i);
        hov.style.display = ''; hl.setAttribute('x1', x); hl.setAttribute('x2', x);
        const rows = [];
        o.series.forEach(function (sr, k) {
          const v = sr.vals[i];
          if (v == null) { dots[k].style.display = 'none'; } else { dots[k].style.display = ''; dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(v)); }
          rows.push({ name: sr.name, color: sr.color, v: v == null ? '—' : o.fmt(v) });
        });
        showTip(sh, tipRows(o.tips[i], rows), x * r.width / W, 4);
      };
      sh.plot.onmouseleave = function () { hov.style.display = 'none'; hideTip(sh); };
    };
    charts.push(draw);
    sh.card._draw = draw;
    return sh.card;
  }
  function seriesTable(o) {
    const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, '时间'), o.series.map(function (s) { return h('th', null, s.name); })));
    for (let i = o.labels.length - 1, c = 0; i >= 0 && c < 240; i--, c++) t.appendChild(h('tr', null, h('td', null, o.tips[i]), o.series.map(function (s) { return h('td', null, s.vals[i] == null ? '—' : o.fmt(s.vals[i])); })));
    return t;
  }

  // ---------- 堆叠柱状图（正值；段间留 2px 间隙） ----------
  function stackChart(o) {
    const sh = shell(Object.assign({}, o, { table: function () {
      const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, o.periodName || '时间'), o.series.map(function (s) { return h('th', null, s.name); }), h('th', null, '合计')));
      for (let i = o.labels.length - 1; i >= 0; i--) { let tot = 0; for (const s of o.series) tot += s.vals[i] || 0; t.appendChild(h('tr', null, h('td', null, o.labels[i]), o.series.map(function (s) { return h('td', null, o.fmt(s.vals[i] || 0)); }), h('td', null, o.fmt(tot)))); }
      return t;
    } }), o.series.map(function (s) { return { name: s.name, color: s.color, sq: true }; }));
    const draw = function () {
      const n = o.labels.length;
      if (!n) { emptyState(sh, o.empty || '尚无完整月份的记录。'); return; }
      const tots = o.labels.map(function (_, i) { let t = 0; for (const s of o.series) t += Math.max(0, s.vals[i] || 0); return t; });
      const hi = Math.max.apply(null, tots);
      const W = Math.max(260, sh.plot.clientWidth || 420), Hh = o.height || 180;
      const pl = 48, pr = 10, pt = 10, pb = 22;
      const nt = niceTicks(0, hi > 0 ? hi : 1, 4);
      const Y = function (v) { return pt + (1 - v / nt.hi) * (Hh - pt - pb); };
      const slot = (W - pl - pr) / n, bw = Math.max(2, Math.min(26, slot * 0.68));
      const X = function (i) { return pl + slot * (i + 0.5); };
      let s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" height="' + Hh + '" font-size="10.5">';
      for (const t of nt.ticks) { const y = Y(t).toFixed(1); s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(' + (t === 0 ? '--line-strong' : '--line') + ')"/><text x="' + (pl - 6) + '" y="' + y + '" dy="3.5" text-anchor="end" style="fill:var(--muted)">' + esc(o.axisFmt(t)) + '</text>'; }
      const nx = Math.min(n, Math.max(2, Math.floor((W - pl) / 64))), seen = {};
      for (let q = 0; q < nx; q++) { const i = nx === 1 ? 0 : Math.round(q / (nx - 1) * (n - 1)); if (seen[i]) continue; seen[i] = 1; s += '<text x="' + X(i).toFixed(1) + '" y="' + (Hh - 5) + '" text-anchor="middle" style="fill:var(--muted)">' + esc(o.xs[i]) + '</text>'; }
      for (let i = 0; i < n; i++) {
        let acc = 0;
        s += '<g class="col" data-i="' + i + '">';
        o.series.forEach(function (sr, k) {
          const v = Math.max(0, sr.vals[i] || 0); if (v <= 0) return;
          const y1 = Y(acc), y2 = Y(acc + v); acc += v;
          let top = y2, hh = y1 - y2;
          if (acc < tots[i] - 1e-9 && hh > 3) { top += 2; hh -= 2; }
          s += '<rect x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.8, hh).toFixed(1) + '" rx="' + Math.min(3, bw / 4) + '" fill="' + sr.color + '"/>';
        });
        s += '</g>';
      }
      s += '<rect class="hit" x="' + pl + '" y="0" width="' + (W - pl - pr) + '" height="' + Hh + '" fill="transparent"/></svg>';
      sh.plot.innerHTML = s; sh.plot.appendChild(sh.tip);
      const cols = sh.plot.querySelectorAll('.col');
      sh.plot.onmousemove = function (e) {
        const r = sh.plot.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width;
        const i = U.clamp(Math.floor((sx - pl) / slot), 0, n - 1);
        cols.forEach(function (c, k) { c.style.opacity = k === i ? '1' : '0.45'; });
        const rows = o.series.map(function (sr) { return { name: sr.name, color: sr.color, v: o.fmt(sr.vals[i] || 0) }; });
        rows.push({ name: '合计', v: o.fmt(tots[i]) });
        showTip(sh, tipRows(o.labels[i], rows), X(i) * r.width / W, 4);
      };
      sh.plot.onmouseleave = function () { cols.forEach(function (c) { c.style.opacity = '1'; }); hideTip(sh); };
    };
    charts.push(draw);
    return sh.card;
  }

  // ---------- 横向条形图（排名；线路用线路自身颜色） ----------
  function hbarChart(o) {
    const sh = shell(Object.assign({}, o, { table: function () {
      const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, o.nameCol || '名称'), h('th', null, o.valCol || '数值'), o.extraCol ? h('th', null, o.extraCol) : null));
      for (const it of o.items) t.appendChild(h('tr', null, h('td', null, it.name), h('td', null, o.fmt(it.v)), o.extraCol ? h('td', null, it.extra || '') : null));
      return t;
    } }), null);
    const draw = function () {
      sh.plot.innerHTML = '';
      if (!o.items.length) { emptyState(sh, o.empty || '暂无数据'); return; }
      const max = Math.max.apply(null, o.items.map(function (it) { return it.v; })) || 1;
      const box = h('div', { class: 'hbars' });
      o.items.forEach(function (it, k) {
        const row = h('div', { class: 'hbar-row' },
          h('div', { class: 'hbar-name' }, it.sw ? h('i', { style: { background: it.sw } }) : null, h('span', null, it.name)),
          h('div', { class: 'hbar-track' }, h('div', { class: 'hbar-fill', style: { width: Math.max(0.6, it.v / max * 100) + '%', background: it.color } })),
          h('div', { class: 'hbar-val' }, o.fmt(it.v)));
        row.addEventListener('mouseenter', function () { const r = sh.plot.getBoundingClientRect(), rr = row.getBoundingClientRect(); showTip(sh, tipRows(it.name, it.tip || [{ name: o.valCol || '数值', v: o.fmt(it.v) }]), rr.left - r.left + rr.width * 0.45, rr.bottom - r.top + 2); });
        row.addEventListener('mouseleave', function () { hideTip(sh); });
        box.appendChild(row);
      });
      sh.plot.append(box, sh.tip);
    };
    charts.push(draw);
    return sh.card;
  }

  // ---------- 指标卡（含迷你趋势线） ----------
  function kpi(o) {
    const vals = o.vals.filter(function (v) { return v != null; });
    const el = h('div', { class: 'kpi' + (o.onclick ? ' clickable' : ''), onclick: o.onclick || null },
      h('div', { class: 'top' }, h('span', { class: 'badge ' + o.badge }, CM.icon(o.icon)), o.label),
      h('div', { class: 'val' }, o.value, o.unit ? h('small', null, ' ' + o.unit) : null));
    if (o.delta) el.appendChild(h('div', { class: 'delta ' + o.delta.cls }, o.delta.text));
    else el.appendChild(h('div', { class: 'delta muted' }, o.note || ' '));
    if (vals.length >= 2) {
      const W = 200, Hh = 34, lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = hi - lo;
      const pts = vals.map(function (v, i) { return [(i / (vals.length - 1) * (W - 6) + 3).toFixed(1), (sp > 1e-9 ? Hh - 4 - (v - lo) / sp * (Hh - 8) : Hh / 2).toFixed(1)]; });
      const c = pal()[0];
      const d = 'M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join('L');
      const svg = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none"><path d="' + d + 'L' + pts[pts.length - 1][0] + ' ' + Hh + 'L' + pts[0][0] + ' ' + Hh + 'Z" fill="' + c + '" fill-opacity="0.1"/><path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
      el.appendChild(h('div', { class: 'spark', html: svg }));
    } else el.appendChild(h('div', { style: { height: '36px' } }));
    return el;
  }
  // 与约一年前比较；better: 'up' 越大越好 / 'down' 越小越好
  function delta(H, key, better, fmt) {
    const n = H.length; if (n < 2) return null;
    const cur = H[n - 1][key]; let k = Math.max(0, n - 13);
    while (k < n - 1 && (H[k][key] == null)) k++;
    const prev = H[k][key];
    if (cur == null || prev == null || k >= n - 1) return null;
    const dv = cur - prev;
    const span = n - 1 - k >= 12 ? '较一年前' : '较 ' + H[k].y + '年' + H[k].m + '月';
    if (Math.abs(dv) < 1e-9) return { text: span + ' 持平', cls: 'muted' };
    const good = better === 'up' ? dv > 0 : dv < 0;
    return { text: span + ' ' + (dv > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(dv)), cls: good ? 'good' : 'bad' };
  }

  // ---------- 各页 ----------
  function axisPeople(v) { return Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e5 || v === 0 ? 0 : 1) + '万' : String(Math.round(v)); }
  function axisPct(v) { return Math.round(v * 100) + '%'; }
  function axisYi(v) { return v === 0 ? '0' : (v / 10000).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + '亿'; }
  function xsOf(H) {
    const span = H.length;
    return H.map(function (r) { return r.live ? '当前' : (span > 30 ? String(r.y) : (r.y % 100 < 10 ? '0' : '') + r.y % 100 + '.' + r.m); });
  }
  function ts(H, title, sub, list, extra) {
    return lineChart(Object.assign({ title: title, sub: sub, labels: H, xs: xsOf(H), tips: H.map(recLabel), series: list }, extra));
  }

  // 线路与车站客流排名（概览、交通页共用）
  function lineItems(g) {
    const mnet = g.model.net, sd = g.model.stDaily;
    if (!mnet || !sd || !mnet.C.routes.length) return [];
    const byLine = new Map();
    mnet.C.routes.forEach(function (rt, i) {
      let o = byLine.get(rt.lineId); if (!o) { o = { name: rt.line ? rt.line.name : rt.label, color: rt.color, v: 0 }; byLine.set(rt.lineId, o); }
      o.v += sd.routeBoard[i] || 0;
    });
    return Array.from(byLine.values()).sort(function (a, b) { return b.v - a.v; }).map(function (o) { return { name: o.name, v: o.v, color: o.color }; });
  }
  function stationItems(g) {
    const mnet = g.model.net, sd = g.model.stDaily, P = pal();
    if (!mnet || !sd) return [];
    const C = mnet.C, st = [];
    for (let k = 0; k < C.stations.length; k++) st.push({ k: k, v: (sd.inn[k] || 0) + (sd.out[k] || 0) + (sd.xfer[k] || 0) });
    st.sort(function (a, b) { return b.v - a.v; });
    return st.slice(0, 8).filter(function (o) { return o.v > 0; }).map(function (o) {
      return { name: C.stations[o.k].name, v: o.v, color: P[0], tip: [{ name: '进站', v: U.fmtPeople(sd.inn[o.k]) }, { name: '出站', v: U.fmtPeople(sd.out[o.k]) }, { name: '换乘', v: U.fmtPeople(sd.xfer[o.k]) }] };
    });
  }
  const peopleFmt = function (v) { return U.fmtPeople(v) + ' 人次'; };

  function pageOverview(g, el) {
    const H = timeline(g), P = pal(), cur = H[H.length - 1], free = g.econ.isFree();
    const grid = h('div', { class: 'kpi-grid' });
    const last36 = function (k) { return pick(H.slice(-37), k); };
    grid.append(
      kpi({ icon: 'train', badge: 'b-teal', label: '地铁日客运量', value: U.fmtPeople(cur.riders), unit: '人次', vals: last36('riders'), delta: delta(H, 'riders', 'up', U.fmtPeople), onclick: function () { go('traffic'); } }),
      kpi({ icon: 'metro', badge: 'b-teal', label: '地铁分担率', value: U.fmtPct(cur.share, 1), vals: last36('share'), delta: delta(H, 'share', 'up', function (v) { return (v * 100).toFixed(1) + ' 个百分点'; }), onclick: function () { go('traffic'); } }),
      kpi({ icon: 'car', badge: cur.cong < 1.25 ? 'b-green' : (cur.cong < 1.6 ? 'b-orange' : 'b-red'), label: '道路拥堵指数', value: cur.cong.toFixed(2), vals: last36('cong'), delta: delta(H, 'cong', 'down', function (v) { return v.toFixed(2); }), onclick: function () { go('traffic'); } }),
      kpi({ icon: cur.sat >= 60 ? 'smile' : (cur.sat >= 40 ? 'meh' : 'frown'), badge: cur.sat >= 60 ? 'b-green' : (cur.sat >= 40 ? 'b-orange' : 'b-red'), label: '市民满意度', value: Math.round(cur.sat), unit: '/ 100', vals: last36('sat'), delta: delta(H, 'sat', 'up', function (v) { return v.toFixed(1); }) }),
      kpi({ icon: 'people', badge: 'b-blue', label: '城市人口', value: U.fmtPeople(cur.pop), vals: last36('pop'), delta: delta(H, 'pop', 'up', U.fmtPeople) }),
      free ? kpi({ icon: 'station', badge: 'b-slate', label: '车站 · 覆盖人口', value: String(cur.stations), unit: '站 · ' + U.fmtPct(cur.coverage, 0), vals: last36('coverage'), delta: delta(H, 'coverage', 'up', function (v) { return (v * 100).toFixed(1) + ' 个百分点'; }) })
        : kpi({ icon: 'coin', badge: 'b-gold', label: '可用资金', value: U.fmtMoney(cur.funds), vals: last36('funds'), delta: delta(H, 'funds', 'up', function (v) { return U.fmtMoney(v); }), onclick: function () { go('finance'); } }));
    el.appendChild(grid);
    const cg = h('div', { class: 'chart-grid' });
    cg.append(
      ts(H, '地铁日客运量', '典型工作日乘车人次', [{ name: '地铁日客运量', color: P[0], vals: pick(H, 'riders') }], { fmt: peopleFmt, axisFmt: axisPeople, area: true, int: true, icon: 'train' }),
      hbarChart({ title: '各线路日客运量', sub: '典型工作日上车人次', icon: 'route', items: lineItems(g), fmt: function (v) { return U.fmtPeople(v); }, empty: '还没有运营中的线路。' }));
    el.appendChild(cg);
  }

  function pageTraffic(g, el) {
    const H = timeline(g), P = pal();
    const cg = h('div', { class: 'chart-grid' });
    cg.append(
      ts(H, '地铁分担率与覆盖率', '分担率：地铁出行占全部出行；覆盖率：步行 15 分钟可达车站的人口', [{ name: '分担率', color: P[0], vals: pick(H, 'share') }, { name: '覆盖率', color: P[2], vals: pick(H, 'coverage') }], { fmt: function (v) { return U.fmtPct(v, 1); }, axisFmt: axisPct, icon: 'metro' }),
      ts(H, '道路拥堵指数', '1.00 为畅通；高于 1.25 拥堵，高于 1.60 严重拥堵', [{ name: '拥堵指数', color: P[1], vals: pick(H, 'cong') }], { fmt: function (v) { return v.toFixed(2); }, axisFmt: function (v) { return v.toFixed(1); }, min0: false, icon: 'traffic', refs: [{ v: 1.25, label: '拥堵' }, { v: 1.6, label: '严重' }] }),
      ts(H, '平均通勤时间', '家到工作地的门到门时间', [{ name: '平均通勤', color: P[6], vals: pick(H, 'commute') }], { fmt: function (v) { return v.toFixed(1) + ' 分钟'; }, axisFmt: function (v) { return Math.round(v) + '分'; }, min0: false, icon: 'timer' }),
      hbarChart({ title: '客流最高的车站', sub: '进站 + 出站 + 换乘，前 8 名', icon: 'station', items: stationItems(g), fmt: function (v) { return U.fmtPeople(v); }, empty: '车站客流计算中…' }));
    el.appendChild(cg);
  }

  function pageFinance(g, el) {
    const P = pal(), E = g.econ;
    const H = timeline(g);
    let rows = E.ledger.map(function (r) { return { lab: r.y + '年' + r.m + '月', x: (r.y % 100 < 10 ? '0' : '') + r.y % 100 + '.' + r.m, r: r }; });
    if (E.ledger.length > 36) {
      const by = new Map();
      for (const r of E.ledger) { let a = by.get(r.y); if (!a) { a = { y: r.y, grant: 0, fare: 0, reward: 0, construction: 0, demolition: 0, upgrade: 0, relocation: 0, ops: 0 }; by.set(r.y, a); } for (const k in a) if (k !== 'y') a[k] += r[k] || 0; }
      rows = Array.from(by.values()).map(function (a) { return { lab: a.y + '年', x: String(a.y), r: a }; });
    }
    const inc = function (r) { return (r.grant || 0) + (r.fare || 0) + (r.reward || 0); };
    const exp = function (r) { return (r.construction || 0) + (r.demolition || 0) + (r.upgrade || 0) + (r.relocation || 0) + (r.ops || 0); };
    const cg = h('div', { class: 'chart-grid' });
    cg.append(
      ts(H, '资金余额', '为负时需尽快扭亏（长期负余额会导致挑战失败）', [{ name: '资金', color: P[3], vals: pick(H, 'funds') }], { fmt: function (v) { return U.fmtMoney(v); }, axisFmt: axisYi, area: true, icon: 'coin', refs: [{ v: 0, label: '' }] }),
      lineChart({ title: '收入与支出', sub: (E.ledger.length > 36 ? '按年' : '按月') + '合计：收入 = 拨款 + 票款 + 奖励；支出 = 建设 + 运营', icon: 'wallet', labels: rows, xs: rows.map(function (o) { return o.x; }), tips: rows.map(function (o) { return o.lab; }), series: [{ name: '收入', color: P[2], vals: rows.map(function (o) { return inc(o.r); }) }, { name: '支出', color: P[1], vals: rows.map(function (o) { return exp(o.r); }) }], fmt: function (v) { return U.fmtMoney(v); }, axisFmt: axisYi, empty: '尚无完整月份的记录。' }));
    el.appendChild(cg);
  }
  // ---------- 里程碑：城市发展与地铁建设的关键节点（时间线 + 下一个目标） ----------
  let msFilter = 'all';
  function pageMilestones(g, el) {
    const MS = CM.Milestones; if (!MS) return;
    const st = MS.state(g), list = st.list.slice(), CAT = MS.CAT;
    const counts = {}; for (const r of list) counts[r.cat] = (counts[r.cat] || 0) + 1;
    const real = list.filter(function (r) { return r.id !== 'start'; });
    // 概览：数量与分类
    el.appendChild(h('div', { class: 'ms-hero' },
      h('div', { class: 'ms-medal' }, CM.icon('trophy', 30)),
      h('div', { class: 'grow' }, h('div', { class: 'ms-count' }, h('b', null, String(real.length)), ' 个里程碑'),
        h('div', { class: 'ms-sub' }, real.length ? '最近：' + real[real.length - 1].title + '（' + real[real.length - 1].y + '年' + real[real.length - 1].m + '月）' : '建成第一条地铁、人口与客流跨越关口时，都会记录在这里。')),
      h('div', { class: 'ms-cats' }, Object.keys(CAT).map(function (k) { return h('span', null, h('i', { style: { background: CAT[k].color } }), CAT[k].name, h('b', null, String(counts[k] || 0))); }))));
    // 下一个目标
    const nx = MS.next(g);
    if (nx.length) {
      const row = h('div', { class: 'ms-next' });
      for (const o of nx) {
        const f = U.clamp(o.cur / o.goal, 0, 1);
        row.appendChild(h('div', { class: 'ms-goal' }, h('div', { class: 'ms-gh' }, h('span', { class: 'ms-gi', style: { color: o.color } }, CM.icon(o.icon, 16)), h('span', null, '下一个 · ' + o.label)),
          h('div', { class: 'ms-gt' }, o.text), h('div', { class: 'ms-bar' }, h('i', { style: { width: (f * 100).toFixed(1) + '%', background: o.color } }))));
      }
      el.appendChild(h('div', { class: 'ms-sec' }, '下一个目标'));
      el.appendChild(row);
    }
    // 筛选
    const chips = h('div', { class: 'ms-chips' }, [['all', '全部']].concat(Object.keys(CAT).map(function (k) { return [k, CAT[k].name]; })).map(function (o) {
      return h('button', { class: msFilter === o[0] ? 'on' : '', 'data-silent': '1', onclick: function () { msFilter = o[0]; CM.Sound && CM.Sound.play('soft'); render(); } }, o[0] !== 'all' ? h('i', { style: { background: CAT[o[0]].color } }) : null, o[1]);
    }));
    el.appendChild(h('div', { class: 'ms-sec row between' }, h('span', null, '时间线'), chips));
    // 时间线：按年分组，最新在上
    const shown = list.filter(function (r) { return msFilter === 'all' || r.cat === msFilter; }).reverse();
    if (!shown.length) { el.appendChild(h('div', { class: 'empty-chart' }, '这一类还没有里程碑。')); return; }
    const tl = h('div', { class: 'ms-tl' });
    let year = null, grp = null, col = null;
    for (const r of shown) {
      if (r.y !== year) { year = r.y; col = h('div', { class: 'ms-items' }); grp = h('div', { class: 'ms-year' }, h('div', { class: 'ms-yl' }, String(year)), col); tl.appendChild(grp); }
      const c = CAT[r.cat] || CAT.history;
      col.appendChild(h('div', { class: 'ms-item' + (r.big ? ' big' : '') + (r.id === 'start' ? ' origin' : ''), style: { '--mc': c.color } },
        h('span', { class: 'ms-dot' }, CM.icon(r.icon || 'flag', r.big ? 18 : 15)),
        h('div', { class: 'ms-card' },
          h('div', { class: 'ms-t' }, r.title, r.tag && r.tag !== '史实' ? h('span', { class: 'tag ' + (r.tag === '模拟' ? 'sim' : (r.tag === '估算' ? 'est' : '')) }, r.tag) : (r.tag === '史实' ? h('span', { class: 'tag hist' }, '史实') : null)),
          r.desc ? h('div', { class: 'ms-d' }, r.desc) : null,
          h('div', { class: 'ms-w' }, r.m + '月' + (r.d && r.d > 1 ? r.d + '日' : ''), ' · ', c.name))));
    }
    el.appendChild(tl);
  }
  const PAGES = { overview: pageOverview, traffic: pageTraffic, finance: pageFinance, milestones: pageMilestones };

  // ---------- 外框 ----------
  function go(t) { if (t === tab) return; tab = t; CM.Sound && CM.Sound.play('soft'); render(); }
  function render() {
    const g = game(); if (!g || !ui) return;
    const root = ui.statsEl;
    const keepScroll = body && body.dataset.tab === tab ? body.scrollTop : 0;
    root.innerHTML = '';
    charts = [];
    if (!PAGES[tab] || (tab === 'finance' && g.econ.isFree())) tab = 'overview';
    const tabs = h('div', { class: 'stats-tabs' }, TABS.filter(function (t) { return t[0] !== 'finance' || !g.econ.isFree(); }).map(function (t) { return h('button', { class: t[0] === tab ? 'on' : '', 'data-silent': '1', onclick: function () { go(t[0]); } }, CM.icon(t[2]), t[1]); }));
    const head = h('div', { class: 'stats-head' }, h('span', { class: 'badge b-blue' }, CM.icon('chart')), h('h2', null, '城市统计'), tabs, h('div', { class: 'grow' }),
      h('button', { class: 'hbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: function () { Stats.close(); } }, CM.icon('close')));
    body = h('div', { class: 'stats-body' }); body.dataset.tab = tab;
    const g2 = g;
    PAGES[tab](g2, body);
    body.appendChild(h('div', { class: 'tiny muted', style: { marginTop: '14px' } }, tab === 'milestones' ? '只记录关键节点：地铁建设的「第一次」与里程关口、客流与分担率关口、人口关口、本地图的重大历史事件与地标落成。' : '按月记录，最后一点为当前值；客流为典型工作日模拟结果。悬停图表查看数值。'));
    const win = h('div', { class: 'stats-win', onclick: function (e) { e.stopPropagation(); } }, head, body);
    root.appendChild(win);
    root.onclick = function () { Stats.close(); };
    requestAnimationFrame(function () { for (const d of charts) d(); if (keepScroll) body.scrollTop = keepScroll; });
    sig = signature(g);
  }
  function signature(g) { return g.history.length + '|' + g.econ.ledger.length + '|' + g.netVersion + '|' + (g.model.stDaily ? 1 : 0) + '|' + document.documentElement.dataset.theme + '|' + (g.milestones ? g.milestones.list.length : 0); }
  function redrawCharts() { for (const d of charts) d(); }
  let rT = null;
  window.addEventListener('resize', function () { if (!isOpen) return; clearTimeout(rT); rT = setTimeout(redrawCharts, 120); });

  const Stats = {
    open: function (u, t) { ui = u; if (t) tab = t; isOpen = true; ui.statsEl.classList.remove('hidden'); render(); },
    close: function () { if (!isOpen) return; isOpen = false; if (ui) { ui.statsEl.classList.add('hidden'); CM.Sound && CM.Sound.play('close'); } },
    isOpen: function () { return isOpen; },
    redraw: function () { if (isOpen) render(); },
    tick: function () { const g = game(); if (!isOpen || !g) return; if (signature(g) !== sig) render(); },
  };
  CM.Stats = Stats;
})(window.CM);