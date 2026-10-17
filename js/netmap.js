'use strict';
// 线路示意图：不按地理比例，突出线路、支线、环线与换乘关系。
// 地下 / 地面 / 高架用不同线型区分；站内换乘与站外（步行）换乘分别标示；站名避让线路、车站与其他站名
(function (CM) {
  const U = CM.U, M = CM.Metro, h = U.h;
  let ui = null, root = null, view = null, focus = null, useDraft = false;
  function game() { return CM.game; }

  // 站外换乘：两座不同线路的运营车站之间可步行换乘（来自交通模型，只在正式网络上有）
  function walkTransfers(g, net) {
    const out = [], mnet = g.model && g.model.net;
    if (!mnet || !mnet.acc) return out;
    const C = mnet.C, seen = new Set();
    for (const t of mnet.acc.transfers) {
      const a = C.stations[t.a].id, b = C.stations[t.b].id, key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key) || !net.stations[a] || !net.stations[b]) continue;
      const la = M.stationLines(net, a), lb = M.stationLines(net, b);
      if (!la.length || !lb.length || la.some(function (l) { return lb.indexOf(l) >= 0; })) continue;
      seen.add(key); out.push({ a: a, b: b, m: t.m });
    }
    return out;
  }

  // ---------------- 布局：从地理位置出发，迭代使区间趋向 0°/45°/90°、间距均匀 ----------------
  function layout(net, xfers) {
    const pairs = new Map();
    for (const id in net.segments) {
      const s = net.segments[id];
      if (!net.stations[s.a] || !net.stations[s.b] || !net.lines[s.line]) continue;
      const k = s.a < s.b ? s.a + '|' + s.b : s.b + '|' + s.a;
      let e = pairs.get(k);
      if (!e) { e = { a: s.a, b: s.b, lines: [] }; pairs.set(k, e); }
      if (!e.lines.some(function (x) { return x.lid === s.line; })) e.lines.push({ lid: s.line, type: s.type });
    }
    const st = [], ix = new Map();
    const add = function (sid) { if (!ix.has(sid)) { ix.set(sid, st.length); st.push(sid); } };
    pairs.forEach(function (e) { add(e.a); add(e.b); });
    const N = st.length, X = new Float64Array(N), Y = new Float64Array(N), GX = new Float64Array(N), GY = new Float64Array(N);
    const edges = [];
    pairs.forEach(function (e) { const A = net.stations[e.a], B = net.stations[e.b]; edges.push({ a: ix.get(e.a), b: ix.get(e.b), lines: e.lines, geo: U.dist(A.x, A.y, B.x, B.y) }); });
    const xEdges = [];
    for (const t of xfers) if (ix.has(t.a) && ix.has(t.b)) xEdges.push({ a: ix.get(t.a), b: ix.get(t.b), xfer: true, len: 0.75 });
    if (!N) return { st: st, X: X, Y: Y, edges: edges, xEdges: xEdges, nb: [] };
    const lens = edges.map(function (e) { return e.geo; }).sort(function (a, b) { return a - b; });
    const L = Math.max(0.5, lens[Math.floor(lens.length / 2)]);
    for (let i = 0; i < N; i++) { const s = net.stations[st[i]]; GX[i] = X[i] = s.x / L; GY[i] = Y[i] = s.y / L; }
    const nb = st.map(function () { return []; });
    for (const e of edges) { nb[e.a].push(e.b); nb[e.b].push(e.a); e.len = 1 + 0.35 * U.clamp(e.geo / L - 1, 0, 2); }
    const all = edges.concat(xEdges);
    const Q = Math.PI / 4, iters = N > 260 ? 240 : 380;
    const relax = function (k) {
      for (const e of all) {
        const dx = X[e.b] - X[e.a], dy = Y[e.b] - Y[e.a];
        const th = Math.round(Math.atan2(dy, dx) / Q) * Q;
        const cx = (Math.cos(th) * e.len - dx) * k * 0.5, cy = (Math.sin(th) * e.len - dy) * k * 0.5;
        X[e.a] -= cx; Y[e.a] -= cy; X[e.b] += cx; Y[e.b] += cy;
      }
    };
    for (let it = 0; it < iters; it++) {
      relax(0.3 * (1 - it / (iters * 1.15)));
      for (let i = 0; i < N; i++) {
        if (nb[i].length !== 2) continue;
        const a = nb[i][0], b = nb[i][1];
        X[i] += ((X[a] + X[b]) / 2 - X[i]) * 0.06; Y[i] += ((Y[a] + Y[b]) / 2 - Y[i]) * 0.06;
      }
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const dx = X[j] - X[i], dy = Y[j] - Y[i], d = Math.hypot(dx, dy);
        if (d >= 0.9 || d < 1e-9) continue;
        const p = (0.9 - d) / d * 0.25;
        X[i] -= dx * p; Y[i] -= dy * p; X[j] += dx * p; Y[j] += dy * p;
      }
      if (it < iters * 0.6) for (let i = 0; i < N; i++) { X[i] += (GX[i] - X[i]) * 0.006; Y[i] += (GY[i] - Y[i]) * 0.006; }
    }
    for (let it = 0; it < 80; it++) relax(0.5);
    return { st: st, X: X, Y: Y, edges: edges, xEdges: xEdges, nb: nb };
  }

  // ---------------- 绘制 ----------------
  const UNIT = 80;
  const TYPE_NAME = { underground: '地下', surface: '地面', elevated: '高架' };
  function seg(x1, y1, x2, y2, col, type, lid) {
    const d = 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1);
    let s = '<g data-line="' + lid + '"><path d="' + d + '" stroke="' + col + '" stroke-width="' + (type === 'elevated' ? 7.5 : 6) + '"/>';
    if (type === 'elevated') s += '<path d="' + d + '" class="nm-elev"/>';          // 高架：中间白线（双线）
    else if (type === 'surface') s += '<path d="' + d + '" class="nm-surf"/>';      // 地面：白色枕木纹
    return s + '</g>';
  }
  function build(g) {
    const net = useDraft && g.draft ? g.draft.net : g.net;
    const xfers = walkTransfers(g, net);
    const lay = layout(net, xfers);
    const N = lay.st.length;
    if (!N) return h('div', { class: 'nm-empty' }, CM.icon('network', 40), h('div', null, useDraft ? '草案中还没有轨道。' : '还没有运营线路。'), h('div', { class: 'tiny muted' }, '用「绘线」工具连接两座以上的车站，确认建设后会显示在这里。'));
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < N; i++) { x0 = Math.min(x0, lay.X[i]); x1 = Math.max(x1, lay.X[i]); y0 = Math.min(y0, lay.Y[i]); y1 = Math.max(y1, lay.Y[i]); }
    const pad = 1.8, W = (x1 - x0 + 2 * pad) * UNIT, H = (y1 - y0 + 2 * pad) * UNIT;
    const px = function (i) { return (lay.X[i] - x0 + pad) * UNIT; }, py = function (i) { return (lay.Y[i] - y0 + pad) * UNIT; };
    const linesOf = lay.st.map(function () { return []; });
    for (const e of lay.edges) for (const l of e.lines) { if (linesOf[e.a].indexOf(l.lid) < 0) linesOf[e.a].push(l.lid); if (linesOf[e.b].indexOf(l.lid) < 0) linesOf[e.b].push(l.lid); }
    const walkSet = new Set(); for (const e of lay.xEdges) { walkSet.add(e.a); walkSet.add(e.b); }
    // 占位：车站、线路（每 9 px 一个小方块）
    const boxes = [];
    const overlap = function (b) { let s = 0; for (const o of boxes) { const w = Math.min(b[2], o[2]) - Math.max(b[0], o[0]), hh = Math.min(b[3], o[3]) - Math.max(b[1], o[1]); if (w > 0 && hh > 0) s += w * hh; } return s; };
    for (let i = 0; i < N; i++) { const r = linesOf[i].length > 1 || walkSet.has(i) ? 11 : 8; boxes.push([px(i) - r, py(i) - r, px(i) + r, py(i) + r]); }
    const allEdges = lay.edges.concat(lay.xEdges);
    for (const e of allEdges) { const ax = px(e.a), ay = py(e.a), bx = px(e.b), by = py(e.b), n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 9)); for (let q = 1; q < n; q++) { const x = ax + (bx - ax) * q / n, y = ay + (by - ay) * q / n; boxes.push([x - 5, y - 5, x + 5, y + 5]); } }
    let svg = '<svg class="nm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W.toFixed(0) + ' ' + H.toFixed(0) + '">';
    // 站外换乘连线（虚线）
    svg += '<g class="nm-walk">';
    for (const e of lay.xEdges) svg += '<path d="M' + px(e.a).toFixed(1) + ' ' + py(e.a).toFixed(1) + 'L' + px(e.b).toFixed(1) + ' ' + py(e.b).toFixed(1) + '"/>';
    svg += '</g>';
    // 线路（同一对车站有多条线路时平行偏移）
    svg += '<g class="nm-lines" stroke-linecap="round" fill="none">';
    for (const e of lay.edges) {
      const ax = px(e.a), ay = py(e.a), bx = px(e.b), by = py(e.b);
      const l = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / l, ny = (bx - ax) / l;
      e.lines.forEach(function (ln, q) {
        const o = (q - (e.lines.length - 1) / 2) * 8, L = net.lines[ln.lid];
        svg += seg(ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, L.color, ln.type, ln.lid);
      });
    }
    svg += '</g>';
    // 终点线路编号
    svg += '<g class="nm-badges">';
    for (const lid in net.lines) {
      const tp = M.lineTopo(net, lid);
      if (!tp.leaves) continue;
      for (const sid of tp.leaves) {
        const i = lay.st.indexOf(sid); if (i < 0) continue;
        const jj = lay.st.indexOf(tp.adj.get(sid)[0].other); if (jj < 0) continue;
        const dx = px(i) - px(jj), dy = py(i) - py(jj), l = Math.hypot(dx, dy) || 1;
        const L = net.lines[lid], bx = px(i) + dx / l * 26, by = py(i) + dy / l * 26, txt = String(L.num || L.name.replace(/[^0-9]/g, '') || '•');
        boxes.push([bx - 13, by - 11, bx + 13, by + 11]);
        svg += '<g data-line="' + lid + '"><rect x="' + (bx - 12).toFixed(1) + '" y="' + (by - 10).toFixed(1) + '" width="24" height="20" rx="6" fill="' + L.color + '"/><text x="' + bx.toFixed(1) + '" y="' + (by + 4.5).toFixed(1) + '" text-anchor="middle" class="nm-badge-t">' + U.esc(txt) + '</text></g>';
      }
    }
    svg += '</g>';
    // 车站与站名：先放换乘站，候选位置为 8 个方向 × 2 个距离，取无重叠（否则重叠最少）的位置
    const order = []; for (let i = 0; i < N; i++) order.push(i);
    order.sort(function (a, b) { return (linesOf[b].length + (walkSet.has(b) ? 1 : 0)) - (linesOf[a].length + (walkSet.has(a) ? 1 : 0)); });
    let lab = '', dots = '';
    const DIRS = [[1, 0], [-1, 0], [0, -1], [0, 1], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]];
    for (const i of order) {
      const s = net.stations[lay.st[i]], xfer = linesOf[i].length > 1, walk = walkSet.has(i), x = px(i), y = py(i);
      const tw = s.name.length * 12.5 + 4, th = 15, r = xfer || walk ? 15 : 11;
      // 优先放在与第一条相邻区段垂直的两侧
      const cands = [];
      if (lay.nb[i].length) { const a = lay.nb[i][0], vx = px(a) - x, vy = py(a) - y, l = Math.hypot(vx, vy) || 1; cands.push([-vy / l, vx / l], [vy / l, -vx / l]); }
      for (const d of DIRS) cands.push(d);
      let best = null;
      for (const dist of [r, r + 16]) {
        for (const c of cands) {
          const cx = x + c[0] * dist, cy = y + c[1] * dist;
          const anchor = c[0] > 0.35 ? 'start' : (c[0] < -0.35 ? 'end' : 'middle');
          const bx0 = anchor === 'start' ? cx : (anchor === 'end' ? cx - tw : cx - tw / 2);
          const by0 = c[1] > 0.35 ? cy : (c[1] < -0.35 ? cy - th : cy - th / 2);
          const b = [bx0, by0, bx0 + tw, by0 + th], ov = overlap(b);
          if (!best || ov < best.ov) best = { b: b, anchor: anchor, ov: ov };
          if (ov === 0) break;
        }
        if (best.ov === 0) break;
      }
      boxes.push(best.b);
      const tx = best.anchor === 'start' ? best.b[0] : (best.anchor === 'end' ? best.b[2] : (best.b[0] + best.b[2]) / 2);
      lab += '<text data-st="' + s.id + '" x="' + tx.toFixed(1) + '" y="' + (best.b[1] + 12).toFixed(1) + '" text-anchor="' + best.anchor + '" class="nm-label' + (xfer || walk ? ' x' : '') + '" data-lines="' + linesOf[i].join(' ') + '">' + U.esc(s.name) + '</text>';
      const tip = s.name + (xfer ? '（站内换乘：' + linesOf[i].map(function (l) { return net.lines[l].name; }).join('、') + '）' : '') + (walk ? '（可步行换乘）' : '') + ' · ' + TYPE_NAME[s.type] + '站 · 点击在地图上定位';
      if (xfer) dots += '<circle data-st="' + s.id + '" data-lines="' + linesOf[i].join(' ') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="9" class="nm-st x"><title>' + U.esc(tip) + '</title></circle>';
      else if (walk) dots += '<circle data-st="' + s.id + '" data-lines="' + linesOf[i].join(' ') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="7.5" class="nm-st w"><title>' + U.esc(tip) + '</title></circle>';
      else dots += '<circle data-st="' + s.id + '" data-lines="' + linesOf[i].join(' ') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5.5" class="nm-st" stroke="' + net.lines[linesOf[i][0]].color + '"><title>' + U.esc(tip) + '</title></circle>';
    }
    svg += '<g class="nm-dots">' + dots + '</g><g class="nm-labels">' + lab + '</g></svg>';
    const wrap = h('div', { class: 'nm-canvas', html: svg });
    view = { x: 0, y: 0, w: W, h: H, W: W, H: H };
    return wrap;
  }

  function applyFocus() {
    if (!root) return;
    const svg = root.querySelector('.nm-svg'); if (!svg) return;
    svg.classList.toggle('focusing', !!focus);
    svg.querySelectorAll('[data-line]').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-line') === focus); });
    svg.querySelectorAll('[data-lines]').forEach(function (el) { el.classList.toggle('on', !!focus && el.getAttribute('data-lines').split(' ').indexOf(focus) >= 0); });
    root.querySelectorAll('.nm-chip').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-id') === focus); });
  }
  function setView() {
    const svg = root && root.querySelector('.nm-svg'); if (!svg || !view) return;
    svg.setAttribute('viewBox', view.x.toFixed(1) + ' ' + view.y.toFixed(1) + ' ' + view.w.toFixed(1) + ' ' + view.h.toFixed(1));
  }
  function bindPanZoom(canvas) {
    const svg = canvas.querySelector('.nm-svg'); if (!svg) return;
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), f = Math.exp(e.deltaY * 0.0015);
      const s = Math.max(view.w / r.width, view.h / r.height);
      const ox = (r.width - view.w / s) / 2, oy = (r.height - view.h / s) / 2;
      const mx = view.x + (e.clientX - r.left - ox) * s, my = view.y + (e.clientY - r.top - oy) * s;
      const nw = U.clamp(view.w * f, view.W * 0.12, view.W * 2), k = nw / view.w;
      view.x = mx - (mx - view.x) * k; view.y = my - (my - view.y) * k; view.w = nw; view.h *= k;
      setView();
    }, { passive: false });
    let drag = null;
    canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const r = svg.getBoundingClientRect(), s = Math.max(view.w / r.width, view.h / r.height);
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { view.x = drag.vx - (e.clientX - drag.x) * s; view.y = drag.vy - (e.clientY - drag.y) * s; setView(); canvas.classList.add('grabbing'); }
    });
    canvas.addEventListener('pointerup', function (e) {
      const d = drag; drag = null; canvas.classList.remove('grabbing');
      if (!d || d.moved) return;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const sid = t && t.getAttribute && t.getAttribute('data-st');
      if (sid) locate(sid);
    });
  }
  function locate(sid) {
    const g = game(); if (!g) return;
    const net = useDraft && g.draft ? g.draft.net : g.net, s = net.stations[sid];
    if (!s) return;
    NetMap.close();
    ui.select({ kind: 'station', id: sid });
    ui.flyTo(s.x, s.y, Math.max(ui.R.cam.zoom, 24));
  }
  // 图例：线型与换乘标示
  function legend() {
    const sw = function (type) { return '<svg width="34" height="10" viewBox="0 0 34 10"><path d="M3 5H31" stroke="var(--accent)" stroke-width="' + (type === 'elevated' ? 7 : 5.5) + '" stroke-linecap="round"/>' + (type === 'elevated' ? '<path d="M3 5H31" class="nm-elev"/>' : (type === 'surface' ? '<path d="M3 5H31" class="nm-surf"/>' : '')) + '</svg>'; };
    return h('div', { class: 'nm-legend' },
      h('span', { html: sw('underground') }), '地下', h('span', { html: sw('elevated') }), '高架', h('span', { html: sw('surface') }), '地面',
      h('span', { class: 'nm-lg-gap' }),
      h('span', { html: '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" class="nm-st x"/></svg>' }), '站内换乘',
      h('span', { html: '<svg width="40" height="20" viewBox="0 0 40 20"><path d="M8 10H32" class="nm-walk-p"/><circle cx="8" cy="10" r="5.5" class="nm-st w"/><circle cx="32" cy="10" r="5.5" class="nm-st w"/></svg>' }), '站外步行换乘');
  }

  function render() {
    const g = game(); if (!g || !root) return;
    const hasDraft = !!(g.draft && g.draftEval() && g.draftEval().changed);
    if (!hasDraft) useDraft = false;
    const net = useDraft && g.draft ? g.draft.net : g.net;
    root.innerHTML = '';
    const chips = h('div', { class: 'nm-chips' });
    for (const lid of M.sortIds(Object.keys(net.lines))) {
      const L = net.lines[lid], tp = M.lineTopo(net, lid);
      if (tp.topo === 'empty') continue;
      chips.appendChild(h('button', { class: 'nm-chip', 'data-id': lid, 'data-silent': '1', onclick: function () { focus = focus === lid ? null : lid; applyFocus(); } }, h('span', { class: 'swatch', style: { background: L.color } }), L.name, h('span', { class: 'tiny muted' }, M.TOPO_NAME[tp.topo] + ' · ' + tp.stations.length + ' 站')));
    }
    const head = h('div', { class: 'stats-head' }, h('span', { class: 'badge b-blue' }, CM.icon('network')), h('h2', null, '线路示意图'),
      hasDraft ? h('div', { class: 'seg-ctl sm' }, [[false, '正式网络'], [true, '含草案']].map(function (o) { return h('button', { class: useDraft === o[0] ? 'on' : '', 'data-silent': '1', onclick: function () { if (useDraft !== o[0]) { useDraft = o[0]; focus = null; render(); } } }, o[1]); })) : null,
      h('div', { class: 'grow' }),
      h('span', { class: 'tiny muted nm-hint' }, '滚轮缩放 · 拖动平移 · 点击车站定位'),
      h('button', { class: 'hbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: function () { NetMap.close(); } }, CM.icon('close')));
    const canvas = build(g);
    const bar = h('div', { class: 'nm-bar' }, chips.childNodes.length ? chips : null, legend());
    const body = h('div', { class: 'nm-body' }, bar, canvas);
    const win = h('div', { class: 'stats-win nm-win', onclick: function (e) { e.stopPropagation(); } }, head, body);
    root.appendChild(win);
    root.onclick = function () { NetMap.close(); };
    if (canvas.classList.contains('nm-canvas')) bindPanZoom(canvas);
    if (focus && !net.lines[focus]) focus = null;
    applyFocus();
  }

  const NetMap = {
    open: function (u) {
      ui = u;
      if (!root) { root = h('div', { id: 'netmap', class: 'hidden' }); document.getElementById('app').appendChild(root); }
      root.classList.remove('hidden');
      render();
    },
    close: function () { if (root) { root.classList.add('hidden'); root.innerHTML = ''; } },
    isOpen: function () { return !!root && !root.classList.contains('hidden'); },
    refresh: function () { if (NetMap.isOpen()) render(); },
  };
  CM.NetMap = NetMap;
})(window.CM);
