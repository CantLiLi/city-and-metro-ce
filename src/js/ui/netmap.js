'use strict';
// 线路图：地理线网准确保留站线与地形关系；简洁示意突出线路、支线、环线与换乘关系。
// 地下 / 地面 / 高架用不同线型区分；站内换乘与站外（步行）换乘分别标示；站名避让线路、车站与其他站名
(function (CM) {
  const U = CM.U, M = CM.Metro, h = U.h;
  let ui = null, root = null, view = null, focus = null, useDraft = false, openedGameId = null;
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

  // 两种布局都从真实网络取站点、区间及换乘；简洁图另行排布八方向线路。
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
    const N = st.length;
    const edges = [];
    pairs.forEach(function (e) { const A = net.stations[e.a], B = net.stations[e.b]; edges.push({ a: ix.get(e.a), b: ix.get(e.b), lines: e.lines, geo: U.dist(A.x, A.y, B.x, B.y) }); });
    const xEdges = [];
    for (const t of xfers) if (ix.has(t.a) && ix.has(t.b)) xEdges.push({ a: ix.get(t.a), b: ix.get(t.b), xfer: true, len: 0.75 });
    if (!N) return { st: st, edges: edges, xEdges: xEdges, nb: [] };
    const lens = edges.map(function (e) { return e.geo; }).sort(function (a, b) { return a - b; });
    const L = Math.max(0.5, lens[Math.floor(lens.length / 2)]);
    const nb = st.map(function () { return []; });
    for (const e of edges) { nb[e.a].push(e.b); nb[e.b].push(e.a); }
    return { st: st, edges: edges, xEdges: xEdges, nb: nb, L: L };
  }

  const cross = function (ax, ay, bx, by) { return ax * by - ay * bx; };
  function cleanPoints(points) {
    const out = [];
    for (const p of points) {
      if (out.length && Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) < 1e-9) continue;
      while (out.length > 1) { const a = out[out.length - 2], b = out[out.length - 1], ux = b[0] - a[0], uy = b[1] - a[1], vx = p[0] - b[0], vy = p[1] - b[1]; if (Math.abs(cross(ux, uy, vx, vy)) > 1e-9 || ux * vx + uy * vy < 0) break; out.pop(); }
      out.push(p.slice());
    }
    return out;
  }
  function simplifyPoints(points, tolerance, closed) {
    let src = points;
    if (closed && src.length > 1 && U.dist(src[0][0], src[0][1], src[src.length - 1][0], src[src.length - 1][1]) < 1e-6) src = src.slice(0, -1);
    const reduce = function (p) {
      if (p.length < 3) return p;
      const keep = new Set([0, p.length - 1]), stack = [[0, p.length - 1]];
      while (stack.length) {
        const range = stack.pop(), a = p[range[0]], b = p[range[1]], dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
        let furthest = -1, max = tolerance * tolerance;
        for (let i = range[0] + 1; i < range[1]; i++) { const q = p[i], t = len ? U.clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len, 0, 1) : 0, d = Math.pow(q[0] - a[0] - dx * t, 2) + Math.pow(q[1] - a[1] - dy * t, 2); if (d > max) { max = d; furthest = i; } }
        if (furthest >= 0) { keep.add(furthest); stack.push([range[0], furthest], [furthest, range[1]]); }
      }
      return p.filter(function (v, i) { return keep.has(i); });
    };
    if (!closed) return reduce(src);
    if (src.length < 5) return src;
    const mid = Math.floor(src.length / 2), out = reduce(src.slice(0, mid + 1)).slice(0, -1).concat(reduce(src.slice(mid).concat([src[0]])).slice(0, -1));
    return out.length >= 3 ? out : src;
  }
  function roundRoute(points, radius, closed) {
    const p = cleanPoints(points), samples = [], f = function (p) { return p[0].toFixed(3) + ' ' + p[1].toFixed(3); };
    if (p.length < 2) return { d: p.length ? 'M' + f(p[0]) : '', samples: p };
    const corner = function (i) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length], da = U.dist(a[0], a[1], b[0], b[1]), dc = U.dist(c[0], c[1], b[0], b[1]), r = Math.min(typeof radius === 'function' ? radius(b, i) : radius, da * 0.4, dc * 0.4);
      return { b: b, round: r, before: [b[0] + (a[0] - b[0]) * r / (da || 1), b[1] + (a[1] - b[1]) * r / (da || 1)], after: [b[0] + (c[0] - b[0]) * r / (dc || 1), b[1] + (c[1] - b[1]) * r / (dc || 1)] };
    };
    const first = closed ? corner(0).after : p[0]; let d = 'M' + f(first); samples.push(first);
    for (let k = 1; k < p.length + (closed ? 1 : 0); k++) {
      if (!closed && k === p.length - 1) { d += 'L' + f(p[k]); samples.push(p[k]); continue; }
      const c = corner(k % p.length); d += 'L' + f(c.before); samples.push(c.before);
      if (c.round > 0) { d += 'Q' + f(c.b) + ' ' + f(c.after); for (let j = 1; j <= 8; j++) { const t = j / 8, u = 1 - t; samples.push([u * u * c.before[0] + 2 * u * t * c.b[0] + t * t * c.after[0], u * u * c.before[1] + 2 * u * t * c.b[1] + t * t * c.after[1]]); } }
    }
    return { d: d + (closed ? 'Z' : ''), samples: samples };
  }
  function octilinearOptions(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], sx = Math.sign(dx), sy = Math.sign(dy), m = Math.min(Math.abs(dx), Math.abs(dy)), out = [];
    if (Math.min(Math.abs(dx), Math.abs(dy), Math.abs(Math.abs(dx) - Math.abs(dy))) < 1e-6) out.push([a, b]);
    out.push([a, [a[0] + sx * m, a[1] + sy * m], b], [a, [b[0] - sx * m, b[1] - sy * m], b]);
    if (Math.abs(dx) > Math.abs(dy)) { const l = (Math.abs(dx) - Math.abs(dy)) / 2; out.push([a, [a[0] + sx * l, a[1]], [b[0] - sx * l, b[1]], b]); }
    else { const l = (Math.abs(dy) - Math.abs(dx)) / 2; out.push([a, [a[0], a[1] + sy * l], [b[0], b[1] - sy * l], b]); }
    for (const t of [0.35, 0.5, 0.65]) { const x = a[0] + dx * t, y = a[1] + dy * t; out.push([a, [x, a[1]], [x, b[1]], b], [a, [a[0], y], [b[0], y], b]); }
    const seen = new Set();
    return out.map(cleanPoints).filter(function (p) { const key = p.map(function (v) { return v[0].toFixed(6) + ',' + v[1].toFixed(6); }).join(';'); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function diagramRoute(track, net, base) {
    const s = track.seg, a = base(net.stations[s.a].x, net.stations[s.a].y), b = base(net.stations[s.b].x, net.stations[s.b].y);
    const tangent = function (sid, other) {
      const p = base(net.stations[sid].x, net.stations[sid].y), end = base(net.stations[other].x, net.stations[other].y), len = U.dist(p[0], p[1], end[0], end[1]) || 1;
      let dx = (end[0] - p[0]) / len, dy = (end[1] - p[1]) / len, best = null, dot = 0.4;
      for (const id in net.segments) { const e = net.segments[id]; if (e.line !== s.line || e.id === s.id || (e.a !== sid && e.b !== sid)) continue; const o = net.stations[e.a === sid ? e.b : e.a], q = base(o.x, o.y), l = U.dist(p[0], p[1], q[0], q[1]) || 1, ox = (q[0] - p[0]) / l, oy = (q[1] - p[1]) / l, d = dx * ox + dy * oy; if (d < dot) { dot = d; best = [ox, oy]; } }
      if (best) { dx -= best[0]; dy -= best[1]; }
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; return [Math.cos(angle), Math.sin(angle)];
    };
    const ta = tangent(s.a, s.b), tb = tangent(s.b, s.a), arm = Math.min(20, U.dist(a[0], a[1], b[0], b[1]) / 5);
    const aa = [a[0] + ta[0] * arm, a[1] + ta[1] * arm], bb = [b[0] + tb[0] * arm, b[1] + tb[1] * arm];
    let best = null;
    const inspect = function (raw, radius, fallback) {
      const clean = cleanPoints(raw), rounded = roundRoute(clean, radius, false);
      let obstacles = 0;
      for (const node of base.nodes) {
        if (node.id === s.a || node.id === s.b) continue;
        for (let i = 1; i < rounded.samples.length; i++) {
          const p = rounded.samples[i - 1], q = rounded.samples[i], dx = q[0] - p[0], dy = q[1] - p[1], len = dx * dx + dy * dy;
          const t = len ? U.clamp(((node.p[0] - p[0]) * dx + (node.p[1] - p[1]) * dy) / len, 0, 1) : 0;
          if (U.dist(node.p[0], node.p[1], p[0] + t * dx, p[1] + t * dy) < 16) { obstacles++; break; }
        }
      }
      let length = 0; for (let i = 1; i < clean.length; i++) length += U.dist(clean[i - 1][0], clean[i - 1][1], clean[i][0], clean[i][1]);
      const score = obstacles * 1e6 + length + clean.length * 22 + (18 - radius) * 0.5 + (fallback ? 4 : 0);
      if (!best || score < best.score) best = { raw: clean, radius: radius, samples: rounded.samples, obstacles: obstacles, score: score };
    };
    for (const raw of octilinearOptions(a, b)) inspect(raw, 18, false);
    if (!best.obstacles && best.raw.length === 2) return best;
    for (const raw of octilinearOptions(aa, bb)) inspect([a].concat(raw, [b]), 14, false);
    if (best.obstacles) for (const offset of [20, -20, 36, -36, 64, -64, 96, -96, 160, -160, 256, -256]) {
      const x = (a[0] + b[0]) / 2 + offset, y = (a[1] + b[1]) / 2 + offset;
      inspect([a, [a[0], y], [b[0], y], b], 18, false);
      inspect([a, [x, a[1]], [x, b[1]], b], 18, false);
    }
    if (best.obstacles) for (const tolerance of [24, 10, 3, 0.5, 0]) {
      const skeleton = tolerance ? simplifyPoints(track.screen, tolerance, false) : track.screen, raw = [skeleton[0]];
      for (let i = 1; i < skeleton.length; i++) { const options = octilinearOptions(skeleton[i - 1], skeleton[i]); const choice = options[Math.abs(skeleton[i][0] - skeleton[i - 1][0]) > Math.abs(skeleton[i][1] - skeleton[i - 1][1]) ? 0 : 1] || options[0]; raw.push.apply(raw, choice.slice(1)); }
      for (const radius of [14, 5, 0]) inspect(raw, radius, true);
      if (!best.obstacles) break;
    }
    // 地图拉直后不让区间穿过无关站标，避免制造不存在的换乘。
    for (let pass = 0; pass < 6 && best.obstacles; pass++) {
      const raw = best.raw;
      for (let i = 1; i < raw.length; i++) {
        const p = raw[i - 1], q = raw[i], len = U.dist(p[0], p[1], q[0], q[1]); if (len < 1) continue;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
        for (const node of base.nodes) {
          if (node.id === s.a || node.id === s.b) continue;
          const along = (node.p[0] - p[0]) * ux + (node.p[1] - p[1]) * uy, normal = -(node.p[0] - p[0]) * uy + (node.p[1] - p[1]) * ux;
          if (along < 0 || along > len || Math.abs(normal) >= 16) continue;
          const t0 = Math.max(0, along - 32), t1 = Math.min(len, along + 32), a = [p[0] + ux * t0, p[1] + uy * t0], b = [p[0] + ux * t1, p[1] + uy * t1];
          for (const side of [20, -20, 32, -32, 64, -64]) inspect(raw.slice(0, i).concat([a, [a[0] - uy * side, a[1] + ux * side], [b[0] - uy * side, b[1] + ux * side], b], raw.slice(i)), 14, true);
        }
      }
      if (raw === best.raw) break;
    }
    return best;
  }

  function projection(net, lay, spacing) {
    const unit = UNIT * spacing;
    const identity = function (size) { return { knots: [[0, 0], [size, size]], map: function (x) { return x; } }; };
    const ax = identity(CM.CFG.W);
    const ay = identity(CM.CFG.H);
    const base = function (x, y) { return [ax.map(x) * unit / lay.L + base.ox, ay.map(y) * unit / lay.L + base.oy]; };
    base.ox = 0; base.oy = 0; base.scale = unit / lay.L; base.ax = ax; base.ay = ay;
    // 两种模式的站点使用同一比例，不能逐轴或局部拉伸站距；简洁图只简化线路走向。
    base.path = function (pts, closed) {
      if (!pts.length) return [];
      const out = [base(pts[0][0], pts[0][1])];
      for (let i = 1; i < pts.length + (closed ? 1 : 0); i++) {
        const a = pts[i - 1], b = pts[i % pts.length], cuts = [1];
        cuts.sort(function (a, b) { return a - b; });
        let last = -1;
        for (const t of cuts) { if (t - last < 1e-8) continue; out.push(base(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)); last = t; }
      }
      return out;
    };
    return base;
  }

  // 地理线网中，地形、实际轨道和车站共用等比例投影；不移动岸线或省略小水面。
  let showTerrain = true, geographic = true;
  function terrainSVG(net, lay, base, boxes) {
    if (!geographic) return '';
    const Geo = CM.Geo, city = game() && game().city;
    if (!Geo || !Geo.water || !lay.L) return '';
    const f = function (v) { return v.toFixed(2); };
    const points = function (p, closed) {
      const src = []; for (let k = 0; k + 1 < p.length; k += 2) src.push([p[k], p[k + 1]]);
      const out = base.path(src, closed);
      return out.length ? pathPoints(out) : '';
    };
    const polygon = function (feat) { return feat.rings.map(function (r) { const d = points(r.p, true); return d ? d + 'Z' : ''; }).join(''); };
    const inMap = function (b) { return b && b[2] >= 0 && b[0] <= CM.CFG.W && b[3] >= 0 && b[1] <= CM.CFG.H; };
    const named = [];
    const features = function (feats, cls) {
      let out = '';
      for (const feat of feats) {
        if (!inMap(feat.bbox)) continue;
        const d = polygon(feat, cls);
        if (d) out += '<path class="' + cls + '" fill-rule="evenodd" d="' + d + '"/>';
        if (cls === 'nm-water' && feat.name && feat.rings.length) {
          const p = feat.rings[0].p, k = Math.floor(p.length / 4) * 2;
          if (k + 1 < p.length) named.push({ name: feat.name, q: base(p[k], p[k + 1]), size: (feat.bbox[2] - feat.bbox[0]) * (feat.bbox[3] - feat.bbox[1]) });
        }
      }
      return out;
    };
    const greenFeats = Geo.reserves.concat(Geo.woods, Geo.parks);
    const green = features(greenFeats, 'nm-green');
    let water = features(Geo.water, 'nm-water'), rivers = '';
    // 历史上尚未填出的土地仍是水面，沿用城市系统当前年份的几何。
    if (city && city.reclaimFeats) water += features(city.reclaimFeats(true), 'nm-water');
    for (const river of Geo.waterLines) {
      if (!inMap(river.bbox)) continue;
      // 地理模式直接绘制原河道及其等比例宽度。
      const d = points(river.p); if (!d) continue;
      rivers += '<path d="' + d + '" stroke-width="' + f(Math.max(river.w, 0.05) * base.scale) + '"/>';
      const k = Math.floor(river.p.length / 4) * 2;
      if (river.name && k + 1 < river.p.length) named.push({ name: river.name, q: base(river.p[k], river.p[k + 1]), size: river.p.length });
    }
    let labels = ''; const seen = new Set();
    named.sort(function (a, b) { return b.size - a.size; });
    for (const item of named) {
      const q = item.q;
      if (seen.has(item.name) || seen.size >= 6 || q[0] < 0 || q[0] > lay.vw || q[1] < 0 || q[1] > lay.vh) continue;
      const tw = item.name.length * 13 + 6, box = [q[0] - tw / 2, q[1] - 9, q[0] + tw / 2, q[1] + 9];
      if (boxes.some(function (b) { return Math.min(box[2], b[2]) > Math.max(box[0], b[0]) && Math.min(box[3], b[3]) > Math.max(box[1], b[1]); })) continue;
      seen.add(item.name); boxes.push(box);
      labels += '<text x="' + f(q[0]) + '" y="' + f(q[1] + 4.5) + '" text-anchor="middle" class="nm-wlabel">' + U.esc(item.name) + '</text>';
    }
    const a = base(0, 0), b = base(CM.CFG.W, CM.CFG.H);
    const clip = '<rect x="' + f(a[0]) + '" y="' + f(a[1]) + '" width="' + f(b[0] - a[0]) + '" height="' + f(b[1] - a[1]) + '"/>';
    return '<defs><clipPath id="nmGeoClip">' + clip + '</clipPath></defs>' +
      '<g class="nm-terrain" clip-path="url(#nmGeoClip)" stroke-linejoin="round" stroke-linecap="round">' + green + water + '<g class="nm-river" fill="none">' + rivers + '</g>' + labels + '</g>';
  }

  // ---------------- 绘制 ----------------
  const UNIT = 96;
  const LABEL_SIZE = 20;
  const TYPE_NAME = { underground: '地下', surface: '地面', elevated: '高架' };
  const pathPoints = function (pts) { const digits = geographic ? 2 : 3; return 'M' + pts.map(function (p) { return p[0].toFixed(digits) + ' ' + p[1].toFixed(digits); }).join('L'); };
  function geoSeg(entry, base, net, width) {
    const s = entry.seg, L = net.lines[s.line];
    const d = entry.route ? roundRoute(entry.route.raw, entry.route.radius, false).d : pathPoints(entry.screen);
    let out = '<g data-line="' + s.line + '" data-segment="' + s.id + '"><title>' + U.esc(L.name + ' · ' + TYPE_NAME[s.type] + '区间') + '</title><path d="' + d + '" stroke="' + L.color + '" stroke-width="' + width + '"/>';
    if (s.type === 'elevated') out += '<path d="' + d + '" class="nm-elev"/>';
    else if (s.type === 'surface') out += '<path d="' + d + '" class="nm-surf"/>';
    return out + '</g>';
  }
  // 将并排行道的站台包在一个圆角外框内，避免连接底形与圆形站标叠出双重轮廓。
  function stationOutline(x, y, radius, anchors) {
    const f = function (p) { return p[0].toFixed(3) + ' ' + p[1].toFixed(3); };
    if (!anchors || !anchors.some(function (p) { return U.dist(x, y, p[0], p[1]) > 0.5; })) return '';
    const points = [[x, y]].concat(anchors).slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    const turn = function (a, b, c) { return cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]); };
    const half = function (src) {
      const out = [];
      for (const p of src) {
        while (out.length > 1 && turn(out[out.length - 2], out[out.length - 1], p) <= 1e-6) out.pop();
        out.push(p);
      }
      return out.slice(0, -1);
    };
    const hull = half(points).concat(half(points.slice().reverse()));
    const normal = hull.map(function (p, i) { const q = hull[(i + 1) % hull.length], len = U.dist(p[0], p[1], q[0], q[1]); return [(q[1] - p[1]) / len, (p[0] - q[0]) / len]; });
    const edge = function (i, n) { return [hull[i][0] + n[0] * radius, hull[i][1] + n[1] * radius]; };
    let d = 'M' + f(edge(0, normal[normal.length - 1]));
    for (let i = 0; i < hull.length; i++) {
      const prev = normal[(i + hull.length - 1) % hull.length], next = normal[i];
      let angle = Math.atan2(cross(prev[0], prev[1], next[0], next[1]), prev[0] * next[0] + prev[1] * next[1]);
      if (angle < 0) angle += Math.PI * 2;
      // 半圆分成四分之一圆，避免端点舍入让 SVG 自动调整半径、造成外框轻微变形。
      const steps = Math.max(1, Math.ceil(angle / (Math.PI / 2))), start = Math.atan2(prev[1], prev[0]);
      for (let k = 1; k <= steps; k++) { const a = start + angle * k / steps; d += 'A' + radius + ' ' + radius + ' 0 0 1 ' + f(edge(i, k === steps ? next : [Math.cos(a), Math.sin(a)])); }
      d += 'L' + f(edge((i + 1) % hull.length, next));
    }
    return d + 'Z';
  }
  // 车站标志与地图一致：普通站为白底圆、线路色描边；换乘站为白底圆或连接并排行道的单一圆角外框 +
  // 深色外环 + 按各线路颜色分段的内环 + ⇄ 换乘箭头（上箭头向右、下箭头向左）
  function stationMark(s, x, y, lines, net, inter, tip, anchors) {
    const attrs = 'data-st="' + s.id + '" data-lines="' + lines.join(' ') + '"', f = function (v) { return v.toFixed(1); };
    if (!inter) return '<circle ' + attrs + ' cx="' + f(x) + '" cy="' + f(y) + '" r="6.5" class="nm-st" stroke="' + net.lines[lines[0]].color + '"><title>' + U.esc(tip) + '</title></circle>';
    const r = 11, ow = 3.3, rr = r - ow / 2 - 1.5, n = lines.length, gap = n > 1 ? 0.22 : 0;
    let out = '<g ' + attrs + ' class="nm-x"><title>' + U.esc(tip) + '</title>';
    // 一个外框连接所有行道；内部色环和箭头仍以真实站点的等比例投影为中心。
    const outline = stationOutline(x, y, r, anchors);
    out += outline ? '<path d="' + outline + '" class="nm-xo"/>' : '<circle cx="' + f(x) + '" cy="' + f(y) + '" r="' + r + '" class="nm-xo"/>';
    if (n === 1) out += '<circle cx="' + f(x) + '" cy="' + f(y) + '" r="' + f(rr) + '" class="nm-xa" stroke="' + net.lines[lines[0]].color + '"/>';
    else for (let k = 0; k < n; k++) {
      const a0 = -Math.PI / 2 + k * Math.PI * 2 / n + gap / 2, a1 = -Math.PI / 2 + (k + 1) * Math.PI * 2 / n - gap / 2;
      out += '<path class="nm-xa" stroke="' + net.lines[lines[k]].color + '" d="M' + f(x + rr * Math.cos(a0)) + ' ' + f(y + rr * Math.sin(a0)) + 'A' + f(rr) + ' ' + f(rr) + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + f(x + rr * Math.cos(a1)) + ' ' + f(y + rr * Math.sin(a1)) + '"/>';
    }
    const gs = r * 0.36, a = gs * 0.42, hd = gs * 0.5;
    out += '<path class="nm-xg" d="M' + f(x - gs) + ' ' + f(y - a) + 'L' + f(x + gs) + ' ' + f(y - a) + 'L' + f(x + gs - hd) + ' ' + f(y - a - hd) + 'M' + f(x + gs) + ' ' + f(y + a) + 'L' + f(x - gs) + ' ' + f(y + a) + 'L' + f(x - gs + hd) + ' ' + f(y + a + hd) + '"/>';
    return out + '</g>';
  }
  // 站名采用实际字体量宽；空间网格让密集线网的避让只查询邻近占位。
  function labelIndex() {
    const cells = new Map(), boxes = [], cell = 64;
    const keys = function (b, visit) {
      for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) visit(x + ':' + y);
    };
    return {
      boxes: boxes,
      add: function (b, weight) {
        const o = { b: b, weight: weight || 1 }; boxes.push(b);
        keys(b, function (key) { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(o); });
      },
      overlap: function (b) {
        let score = 0; const seen = new Set();
        keys(b, function (key) { for (const o of cells.get(key) || []) {
          if (seen.has(o)) continue; seen.add(o);
          const w = Math.min(b[2], o.b[2]) - Math.max(b[0], o.b[0]), hh = Math.min(b[3], o.b[3]) - Math.max(b[1], o.b[1]);
          if (w > 0 && hh > 0) score += w * hh * o.weight;
        } });
        return score;
      }
    };
  }
  function stationText(name, measure) {
    const chars = Array.from(String(name)), width = measure.measureText(name).width;
    if (width <= 112) return [String(name)];
    const count = Math.ceil(width / 112), target = width / count, rows = [];
    let row = '';
    for (const c of chars) {
      if (row && measure.measureText(row + c).width > target + measure.measureText(c).width * 0.4 && rows.length < count - 1) { rows.push(row); row = ''; }
      row += c;
    }
    if (row) rows.push(row);
    return rows;
  }
  // 以简洁图的直线走廊分配行道，包含不同区间之间的局部重合，而非只比较整段真实几何。
  function parallelRoutes(tracks, net, base) {
    const channels = new Map(), bundles = [], ends = new Map(), stationLines = new Map(), stationAnchors = new Map();
    const EPS = 1e-6, GAP = 14;
    const addEnd = function (sid, track, start) {
      let lines = ends.get(sid); if (!lines) { lines = new Map(); ends.set(sid, lines); }
      let list = lines.get(track.seg.line); if (!list) { list = []; lines.set(track.seg.line, list); }
      list.push({ track: track, start: start });
    };
    for (const track of tracks) {
      const raw = track.route.raw, legs = [];
      for (let i = 1; i < raw.length; i++) {
        const a = raw[i - 1], b = raw[i], length = U.dist(a[0], a[1], b[0], b[1]);
        if (length < EPS) continue;
        const dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
        const reverse = dx < -EPS || Math.abs(dx) < EPS && dy < 0, ux = reverse ? -dx : dx, uy = reverse ? -dy : dy;
        const nx = -uy, ny = ux, at = nx * a[0] + ny * a[1];
        const key = Math.round(ux * 1e6) + ':' + Math.round(uy * 1e6) + ':' + Math.round(at * 1e5);
        const t0 = ux * a[0] + uy * a[1], t1 = ux * b[0] + uy * b[1];
        const leg = { a: a, b: b, dx: dx, dy: dy, nx: nx, ny: ny, lo: Math.min(t0, t1), hi: Math.max(t0, t1), line: track.seg.line, offset: 0 };
        if (!channels.has(key)) channels.set(key, []); channels.get(key).push(leg); legs.push(leg);
      }
      track.legs = legs;
      addEnd(track.seg.a, track, true); addEnd(track.seg.b, track, false);
    }
    for (const legs of channels.values()) {
      legs.sort(function (a, b) { return a.lo - b.lo || a.hi - b.hi; });
      let group = [], hi = -Infinity;
      const assign = function () {
        const lines = M.sortIds(Array.from(new Set(group.map(function (leg) { return leg.line; }))));
        if (lines.length < 2) return;
        const bundle = { lines: lines, legs: group, links: [], sign: 0 }; bundles.push(bundle);
        for (const leg of group) leg.bundle = bundle;
      };
      for (const leg of legs) {
        // 仅在一个点相交或接触不能视作共用走廊。
        if (leg.lo >= hi - EPS && group.length) { assign(); group = []; hi = -Infinity; }
        group.push(leg); hi = Math.max(hi, leg.hi);
      }
      if (group.length) assign();
    }
    // 共用走廊转弯时保持内外顺序；不能在上行 / 下行切换后把并排线路编成交叉。
    const connect = function (a, b, relation) {
      const x = a && a.bundle, y = b && b.bundle;
      if (!x || !y || x === y || x.lines.filter(function (lid) { return y.lines.indexOf(lid) >= 0; }).length < 2) return;
      x.links.push({ bundle: y, relation: relation }); y.links.push({ bundle: x, relation: relation });
    };
    const side = function (leg) { return Math.sign(cross(leg.dx, leg.dy, leg.nx, leg.ny)); };
    for (const track of tracks) for (let i = 1; i < track.legs.length; i++) connect(track.legs[i - 1], track.legs[i], side(track.legs[i - 1]) * side(track.legs[i]));
    for (const lines of ends.values()) for (const list of lines.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], al = a.track.legs[a.start ? 0 : a.track.legs.length - 1], bl = b.track.legs[b.start ? 0 : b.track.legs.length - 1];
      if (al && bl) connect(al, bl, -side(al) * (a.start ? 1 : -1) * side(bl) * (b.start ? 1 : -1));
    }
    for (const first of bundles) {
      if (first.sign) continue;
      first.sign = first.legs[0].nx < -EPS ? -1 : 1;
      const queue = [first];
      for (let i = 0; i < queue.length; i++) for (const link of queue[i].links) if (!link.bundle.sign) { link.bundle.sign = queue[i].sign * link.relation; queue.push(link.bundle); }
    }
    for (const bundle of bundles) {
      const offsets = new Map(bundle.lines.map(function (lid, i) { return [lid, (i - (bundle.lines.length - 1) / 2) * GAP * bundle.sign]; }));
      for (const leg of bundle.legs) leg.offset = offsets.get(leg.line);
    }
    const intersection = function (p, u, q, v) {
      const det = cross(u[0], u[1], v[0], v[1]); if (Math.abs(det) < EPS) return null;
      const t = cross(q[0] - p[0], q[1] - p[1], v[0], v[1]) / det;
      return [p[0] + u[0] * t, p[1] + u[1] * t];
    };
    const shifted = function (p, leg) { return [p[0] + leg.nx * leg.offset, p[1] + leg.ny * leg.offset]; };
    for (const track of tracks) {
      const legs = track.legs, raw = [];
      if (!legs.length) continue;
      raw.push(shifted(legs[0].a, legs[0]));
      for (let i = 1; i < legs.length; i++) {
        const a = legs[i - 1], b = legs[i], p = shifted(a.b, a), q = shifted(b.a, b);
        const join = intersection(p, [a.dx, a.dy], q, [b.dx, b.dy]);
        const cap = Math.max(GAP * 2, Math.max(Math.abs(a.offset), Math.abs(b.offset)) * 3);
        if (join && U.dist(join[0], join[1], a.b[0], a.b[1]) <= cap) raw.push(join);
        else { raw.push(p); if (U.dist(p[0], p[1], q[0], q[1]) > EPS) raw.push(q); }
      }
      raw.push(shifted(legs[legs.length - 1].b, legs[legs.length - 1]));
      track.route.raw = cleanPoints(raw);
    }
    for (const [sid, lines] of ends) {
      const s = net.stations[sid], center = base(s.x, s.y), anchors = [];
      const byLine = new Map(); stationLines.set(sid, byLine);
      for (const [lid, list] of lines) {
        const points = list.map(function (e) { const p = e.track.route.raw; return e.start ? p[0] : p[p.length - 1]; });
        let anchor = center.slice();
        if (lines.size > 1) {
          anchor = [points.reduce(function (v, p) { return v + p[0]; }, 0) / points.length, points.reduce(function (v, p) { return v + p[1]; }, 0) / points.length];
          if (list.length === 2) {
            const dirs = list.map(function (e) { const p = e.track.route.raw, a = e.start ? p[0] : p[p.length - 1], b = e.start ? p[1] : p[p.length - 2]; return [b[0] - a[0], b[1] - a[1]]; });
            const join = intersection(points[0], dirs[0], points[1], dirs[1]);
            if (join && U.dist(join[0], join[1], center[0], center[1]) <= GAP * (lines.size + 1)) anchor = join;
          }
        }
        byLine.set(lid, anchor); anchors.push(anchor);
      }
      stationAnchors.set(sid, anchors);
    }
    const attach = function (points, anchor) {
      const p = points[0], q = points[1], length = U.dist(p[0], p[1], q[0], q[1]);
      if (U.dist(p[0], p[1], anchor[0], anchor[1]) < EPS) { points[0] = anchor.slice(); return points; }
      const ux = (q[0] - p[0]) / (length || 1), uy = (q[1] - p[1]) / (length || 1);
      const along = (anchor[0] - p[0]) * ux + (anchor[1] - p[1]) * uy;
      const side = Math.abs(cross(ux, uy, anchor[0] - p[0], anchor[1] - p[1]));
      const t = Math.max(0, along) + side;
      const join = t < length * 0.8 ? [p[0] + ux * t, p[1] + uy * t] : p;
      return cleanPoints([anchor.slice(), join].concat(points.slice(1)));
    };
    for (const track of tracks) {
      let raw = track.route.raw;
      if (raw.length < 2) continue;
      raw = attach(raw, stationLines.get(track.seg.a).get(track.seg.line));
      raw = attach(raw.slice().reverse(), stationLines.get(track.seg.b).get(track.seg.line)).reverse();
      track.route.raw = raw; track.route.samples = roundRoute(raw, track.route.radius, false).samples; track.screen = track.route.samples;
    }
    return stationAnchors;
  }
  function build(g, spacing, attempt) {
    spacing = spacing || 1; attempt = attempt || 0;
    const net = useDraft && g.draft ? g.draft.net : g.net;
    const xfers = walkTransfers(g, net);
    const lay = layout(net, xfers);
    const N = lay.st.length;
    if (!N) return h('div', { class: 'nm-empty' }, CM.icon('network', 40), h('div', null, useDraft ? '草案中还没有轨道。' : '还没有运营线路。'), h('div', { class: 'tiny muted' }, '用「绘线」工具连接两座以上的车站，确认建设后会显示在这里。'));
    const base = projection(net, lay, spacing);
    if (!geographic) base.nodes = lay.st.map(function (sid) { const s = net.stations[sid]; return { id: sid, p: base(s.x, s.y) }; });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const bound = function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); };
    for (const sid of lay.st) { const s = net.stations[sid]; bound(base(s.x, s.y)); }
    const tracks = [], sharedRoutes = new Map();
    for (const id of M.sortIds(Object.keys(net.segments))) {
      const s = net.segments[id];
      if (!net.lines[s.line] || !net.stations[s.a] || !net.stations[s.b]) continue;
      const geom = M.segGeom(net, s, g.city), screen = base.path(geom.pts);
      const track = { seg: s, geom: geom, screen: screen };
      if (!geographic) {
        const points = geom.pts.map(function (p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }), forward = points.join(';'), reverse = points.slice().reverse().join(';'), key = forward < reverse ? forward : reverse, previous = sharedRoutes.get(key);
        if (previous) {
          const same = previous.forward === forward, route = previous.route;
          track.route = Object.assign({}, route, { raw: route.raw.map(function (p) { return p.slice(); }), samples: route.samples.map(function (p) { return p.slice(); }) });
          if (!same) { track.route.raw.reverse(); track.route.samples.reverse(); }
        } else { track.route = diagramRoute(track, net, base); sharedRoutes.set(key, { forward: forward, route: track.route }); }
        track.screen = track.route.samples;
      }
      tracks.push(track);
    }
    const stationAnchors = !geographic ? parallelRoutes(tracks, net, base) : new Map();
    for (const track of tracks) track.screen.forEach(bound);
    for (const anchors of stationAnchors.values()) anchors.forEach(bound);
    const pad = 64, W = x1 - x0 + 2 * pad, H = y1 - y0 + 2 * pad;
    base.ox = pad - x0; base.oy = pad - y0;
    for (const track of tracks) {
      for (const p of track.screen) { p[0] += base.ox; p[1] += base.oy; }
      if (track.route) for (const p of track.route.raw) { p[0] += base.ox; p[1] += base.oy; }
    }
    for (const anchors of stationAnchors.values()) for (const p of anchors) { p[0] += base.ox; p[1] += base.oy; }
    const positions = lay.st.map(function (sid) { const s = net.stations[sid]; return base(s.x, s.y); });
    const px = function (i) { return positions[i][0]; }, py = function (i) { return positions[i][1]; };
    const linesOf = lay.st.map(function () { return []; });
    for (const e of lay.edges) for (const l of e.lines) { if (linesOf[e.a].indexOf(l.lid) < 0) linesOf[e.a].push(l.lid); if (linesOf[e.b].indexOf(l.lid) < 0) linesOf[e.b].push(l.lid); }
    const walkSet = new Set(); for (const e of lay.xEdges) { walkSet.add(e.a); walkSet.add(e.b); }
    // 占位：车站、线路（每 9 px 一个小方块）
    const index = labelIndex(), boxes = index.boxes;
    const overlap = index.overlap;
    const extent = [0, 0, W, H];
    const expand = function (b) { extent[0] = Math.min(extent[0], b[0] - 20); extent[1] = Math.min(extent[1], b[1] - 20); extent[2] = Math.max(extent[2], b[2] + 20); extent[3] = Math.max(extent[3], b[3] + 20); };
    for (let i = 0; i < N; i++) {
      const r = linesOf[i].length > 1 || walkSet.has(i) ? 14 : 10, anchors = stationAnchors.get(lay.st[i]) || [];
      const xs = [px(i)].concat(anchors.map(function (p) { return p[0]; })), ys = [py(i)].concat(anchors.map(function (p) { return p[1]; }));
      const box = [Math.min.apply(null, xs) - r, Math.min.apply(null, ys) - r, Math.max.apply(null, xs) + r, Math.max.apply(null, ys) + r];
      index.add(box, 8); expand(box);
    }
    const occupy = function (pts) {
      let length = 0, next = 9;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (d > 0 && next < length + d) { const t = (next - length) / d, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t; index.add([x - 6, y - 6, x + 6, y + 6]); next += 9; }
        length += d;
      }
    };
    for (const track of tracks) occupy(track.screen);
    for (const e of lay.xEdges) occupy([[px(e.a), py(e.a)], [px(e.b), py(e.b)]]);
    const origin = base(0, 0);
    const axes = ' data-projection="' + (geographic ? 'geographic' : 'octilinear') + '" data-axis-x="' + JSON.stringify(base.ax.knots.map(function (k) { return [k[0], base(k[0], 0)[0]]; })) + '" data-axis-y="' + JSON.stringify(base.ay.knots.map(function (k) { return [k[0], base(0, k[0])[1]]; })) + '"';
    let svg = '<svg class="nm-svg" data-mode="' + (geographic ? 'geographic' : 'schematic') + '" data-spacing="' + spacing + '"' + axes + ' data-scale="' + base.scale + '" data-origin-x="' + origin[0] + '" data-origin-y="' + origin[1] + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W.toFixed(0) + ' ' + H.toFixed(0) + '">';
    // 站外换乘连线（虚线）
    svg += '<g class="nm-walk">';
    for (const e of lay.xEdges) svg += '<path data-lines="' + Array.from(new Set(linesOf[e.a].concat(linesOf[e.b]))).join(' ') + '" d="M' + px(e.a).toFixed(1) + ' ' + py(e.a).toFixed(1) + 'L' + px(e.b).toFixed(1) + ' ' + py(e.b).toFixed(1) + '"/>';
    svg += '</g>';
    // 简洁图共用走廊并排，地理图沿用真实中心线及同心色带，不平移实际位置。
    let casing = '', routes = '';
    if (!geographic) {
      for (const track of tracks) {
        const width = track.seg.type === 'elevated' ? 9.5 : 8, d = roundRoute(track.route.raw, track.route.radius, false).d;
        casing += '<path data-lines="' + track.seg.line + '" d="' + d + '" stroke-width="' + (width + 3) + '"/>';
        routes += geoSeg(track, base, net, width);
      }
    } else {
      const groups = new Map();
      for (const track of tracks) {
        const pts = track.geom.pts.map(function (p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); });
        const forward = pts.join(';'), reverse = pts.slice().reverse().join(';'), key = forward < reverse ? forward : reverse;
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(track);
      }
      for (const group of groups.values()) {
        const widths = group.map(function (track, i) { return (track.seg.type === 'elevated' ? 9.5 : 8) + (group.length - 1 - i) * 4; });
        const entry = group[0], d = entry.route ? roundRoute(entry.route.raw, entry.route.radius, false).d : pathPoints(entry.screen);
        casing += '<path data-lines="' + group.map(function (track) { return track.seg.line; }).join(' ') + '" d="' + d + '" stroke-width="' + (Math.max.apply(null, widths) + 3) + '"/>';
        group.forEach(function (track, i) { routes += geoSeg(track, base, net, widths[i]); });
      }
    }
    svg += '<g class="nm-casing" fill="none" stroke-linecap="round" stroke-linejoin="round">' + casing + '</g><g class="nm-lines" stroke-linecap="round" stroke-linejoin="round" fill="none">' + routes + '</g>';
    const measure = document.createElement('canvas').getContext('2d'), font = getComputedStyle(document.body).fontFamily;
    // 终点编号也参与避让，不盖住相邻车站和线路；长编号按文字宽度扩展。
    svg += '<g class="nm-badges">';
    for (const lid in net.lines) {
      const tp = M.lineTopo(net, lid);
      if (!tp.leaves) continue;
      for (const sid of tp.leaves) {
        const i = lay.st.indexOf(sid); if (i < 0) continue;
        const jj = lay.st.indexOf(tp.adj.get(sid)[0].other); if (jj < 0) continue;
        const dx = px(i) - px(jj), dy = py(i) - py(jj), l = Math.hypot(dx, dy) || 1;
        const L = net.lines[lid], txt = String(L.num || L.name.replace(/[^0-9]/g, '') || '•');
        measure.font = '800 14px ' + font;
        const w = Math.max(28, Math.ceil(measure.measureText(txt).width) + 12), dirs = [[dx / l, dy / l], [-dy / l, dx / l], [dy / l, -dx / l], [0, -1], [0, 1], [1, 0], [-1, 0]];
        let best = null;
        for (const dist of [30, 48, 70, 96]) {
          for (const d of dirs) {
            const bx = px(i) + d[0] * (dist + w * Math.abs(d[0]) / 2), by = py(i) + d[1] * dist;
            const b = [bx - w / 2 - 2, by - 14, bx + w / 2 + 2, by + 14], ov = overlap(b);
            if (!best || ov < best.ov) best = { x: bx, y: by, b: b, ov: ov };
            if (!ov) break;
          }
          if (!best.ov) break;
        }
        index.add(best.b, 8); expand(best.b);
        svg += '<g data-line="' + lid + '"><rect x="' + (best.x - w / 2).toFixed(1) + '" y="' + (best.y - 12).toFixed(1) + '" width="' + w + '" height="24" rx="7" fill="' + L.color + '"/><text x="' + best.x.toFixed(1) + '" y="' + (best.y + 5).toFixed(1) + '" text-anchor="middle" class="nm-badge-t">' + U.esc(txt) + '</text></g>';
      }
    }
    svg += '</g>';
    // 站名就近交错、长名分行；位置不足时扩展整张图，不用大量引线把名字拉走。
    const order = []; for (let i = 0; i < N; i++) order.push(i);
    order.sort(function (a, b) { return (linesOf[b].length + (walkSet.has(b) ? 1 : 0)) - (linesOf[a].length + (walkSet.has(a) ? 1 : 0)); });
    let lab = '', dots = '', needsRoom = false;
    const DIRS = [[0, -1], [0, 1], [1, 0], [-1, 0], [0.707, -0.707], [-0.707, -0.707], [0.707, 0.707], [-0.707, 0.707]];
    for (const i of order) {
      const s = net.stations[lay.st[i]], xfer = linesOf[i].length > 1, walk = walkSet.has(i), x = px(i), y = py(i);
      measure.font = (xfer || walk ? '700 ' : '500 ') + LABEL_SIZE + 'px ' + font;
      const rows = stationText(s.name, measure), lineHeight = LABEL_SIZE + 5;
      const tw = Math.ceil(Math.max.apply(null, rows.map(function (t) { return measure.measureText(t).width; }))) + 12, th = rows.length * lineHeight + 4, r = xfer || walk ? 18 : 14;
      const cands = [];
      if (lay.nb[i].length) { const a = lay.nb[i][0], vx = px(a) - x, vy = py(a) - y, l = Math.hypot(vx, vy) || 1; cands.push([-vy / l, vx / l], [vy / l, -vx / l]); }
      for (const d of DIRS) cands.push(d);
      let best = null;
      for (const dist of [r, r + 8, r + 18, r + 30, r + 44, r + 64, r + 90]) {
        for (const c of cands) {
          const cx = x + c[0] * dist, cy = y + c[1] * dist;
          const anchor = c[0] > 0.35 ? 'start' : (c[0] < -0.35 ? 'end' : 'middle');
          const bx0 = anchor === 'start' ? cx : (anchor === 'end' ? cx - tw : cx - tw / 2);
          const by0 = c[1] > 0.35 ? cy : (c[1] < -0.35 ? cy - th : cy - th / 2);
          const b = [bx0, by0, bx0 + tw, by0 + th], ov = overlap(b);
          if (!best || ov < best.ov) best = { b: b, ov: ov, dist: dist };
          if (!ov) break;
        }
        if (!best.ov) break;
      }
      index.add(best.b, 8); expand(best.b);
      if (best.ov || best.dist > r + 18) needsRoom = true;
      const tx = (best.b[0] + 6).toFixed(1), ty = best.b[1] + LABEL_SIZE + 2;
      lab += '<text data-st="' + s.id + '" x="' + tx + '" y="' + ty.toFixed(1) + '" class="nm-label' + (xfer || walk ? ' x' : '') + '" data-lines="' + linesOf[i].join(' ') + '">' + rows.map(function (text, k) { return '<tspan x="' + tx + '" y="' + (ty + k * lineHeight).toFixed(1) + '">' + U.esc(text) + '</tspan>'; }).join('') + '</text>';
      const tip = s.name + (xfer ? '（站内换乘：' + linesOf[i].map(function (l) { return net.lines[l].name; }).join('、') + '）' : '') + (walk ? '（可步行换乘）' : '') + ' · ' + TYPE_NAME[s.type] + '站 · 点击在地图上定位';
      dots += stationMark(s, x, y, linesOf[i], net, xfer || walk, tip, stationAnchors.get(s.id));
    }
    if (needsRoom && attempt < 3) return build(g, spacing * 1.3, attempt + 1);
    svg += '<g class="nm-dots">' + dots + '</g><g class="nm-labels">' + lab + '</g></svg>';
    // 留足全部站名与终点编号的边距；改变画幅而不移动任何地形、轨道或站标。
    const fullW = Math.ceil(extent[2] - extent[0]), fullH = Math.ceil(extent[3] - extent[1]);
    svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="' + extent[0] + ' ' + extent[1] + ' ' + fullW + ' ' + fullH + '"');
    // 地形画在最下层；在车站与站名都放好之后再放水系名称（避让它们）
    if (geographic && showTerrain) {
      lay.vw = W; lay.vh = H;
      const t = terrainSVG(net, lay, base, boxes);
      const at = svg.indexOf('>') + 1; svg = svg.slice(0, at) + t + svg.slice(at);
    }
    const wrap = h('div', { class: 'nm-canvas', html: svg });
    wrap.querySelectorAll('.nm-lines > g').forEach(function (node, i) { node.dataset.order = i; });
    view = { x: extent[0], y: extent[1], w: fullW, h: fullH, W: fullW, H: fullH, fullX: extent[0], fullY: extent[1], cx: positions.reduce(function (sum, p) { return sum + p[0]; }, 0) / N, cy: positions.reduce(function (sum, p) { return sum + p[1]; }, 0) / N };
    return wrap;
  }

  function applyFocus() {
    if (!root) return;
    const svg = root.querySelector('.nm-svg'); if (!svg) return;
    svg.classList.toggle('focusing', !!focus);
    const lineLayer = svg.querySelector('.nm-lines');
    if (lineLayer) {
      const groups = Array.from(lineLayer.children).sort(function (a, b) { return Number(a.dataset.order) - Number(b.dataset.order); });
      for (const group of groups) lineLayer.appendChild(group);
      if (focus) for (const group of groups) if (group.dataset.line === focus) lineLayer.appendChild(group);
    }
    svg.querySelectorAll('[data-line]').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-line') === focus); });
    svg.querySelectorAll('[data-lines]').forEach(function (el) { el.classList.toggle('on', !!focus && el.getAttribute('data-lines').split(' ').indexOf(focus) >= 0); });
    root.querySelectorAll('.nm-chip').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-id') === focus); });
  }
  function setView() {
    const svg = root && root.querySelector('.nm-svg'); if (!svg || !view) return;
    svg.setAttribute('viewBox', view.x.toFixed(1) + ' ' + view.y.toFixed(1) + ' ' + view.w.toFixed(1) + ' ' + view.h.toFixed(1));
  }
  // 平滑缩放：滚轮与按钮只改变目标视野，逐帧缓动过去（与地图的缩放手感一致），光标下的位置保持不动
  let tgt = null, raf = 0, lastT = 0;
  function tween(t) {
    raf = 0; if (!tgt || !view) { tgt = null; return; }
    const dt = Math.min(0.05, Math.max(0.001, ((t || performance.now()) - (lastT || t || 0)) / 1000)); lastT = t;
    const k = 1 - Math.exp(-dt * 14);
    view.x += (tgt.x - view.x) * k; view.y += (tgt.y - view.y) * k; view.w += (tgt.w - view.w) * k; view.h += (tgt.h - view.h) * k;
    const eps = view.w * 0.0015;
    if (Math.abs(tgt.w - view.w) < eps && Math.abs(tgt.h - view.h) < eps && Math.abs(tgt.x - view.x) < eps && Math.abs(tgt.y - view.y) < eps) { Object.assign(view, tgt); tgt = null; }
    setView();
    if (tgt) raf = requestAnimationFrame(tween); else lastT = 0;
  }
  function animateTo(v) { tgt = v; if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tween); } }
  function zoomAt(f, clientX, clientY) {
    const svg = root && root.querySelector('.nm-svg'); if (!svg || !view) return;
    const r = svg.getBoundingClientRect(), base = tgt || view;
    if (clientX == null) { clientX = r.left + r.width / 2; clientY = r.top + r.height / 2; }
    const s = Math.max(base.w / r.width, base.h / r.height);
    const ox = (r.width - base.w / s) / 2, oy = (r.height - base.h / s) / 2;
    const mx = base.x + (clientX - r.left - ox) * s, my = base.y + (clientY - r.top - oy) * s;
    const nw = U.clamp(base.w * f, Math.min(view.W, view.readW || view.W) * 0.08, Math.max(view.W, view.readW || view.W) * 2), k = nw / base.w;
    animateTo({ x: mx - (mx - base.x) * k, y: my - (my - base.y) * k, w: nw, h: base.h * k });
  }
  function fitView() { if (view) animateTo({ x: view.fullX, y: view.fullY, w: view.W, h: view.H }); }
  function readableView(canvas) {
    if (!view || !canvas.clientWidth || !canvas.clientHeight) return;
    const w = canvas.clientWidth, hh = canvas.clientHeight, fit = Math.min(w / view.W, hh / view.H);
    const scale = U.clamp(fit, (innerWidth <= 760 ? 13 : 14) / LABEL_SIZE, 1);
    if (Math.abs(scale - fit) < 0.001) { view.readW = view.w; return; }
    view.w = w / scale; view.h = hh / scale;
    const center = function (c, size, start, full) { return size < full ? U.clamp(c - size / 2, start, start + full - size) : start + (full - size) / 2; };
    view.x = center(view.cx, view.w, view.fullX, view.W); view.y = center(view.cy, view.h, view.fullY, view.H);
    view.readW = view.w;
    setView();
  }
  function bindPanZoom(canvas) {
    const svg = canvas.querySelector('.nm-svg'); if (!svg) return;
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(Math.exp(U.clamp(d, -240, 240) * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
    let drag = null, pinch = null;
    const pts = new Map();   // 触屏：两指缩放
    const two = function () { const p = Array.from(pts.values()); return { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
    canvas.addEventListener('pointerdown', function (e) {
      if (tgt) { tgt = null; }
      if (e.pointerType === 'touch') { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { pinch = two(); drag = null; return; } }
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; canvas.setPointerCapture(e.pointerId);
    });
    const lift = function (e) { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    canvas.addEventListener('pointercancel', function (e) { lift(e); drag = null; });
    canvas.addEventListener('pointermove', function (e) {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const t = two(), r = svg.getBoundingClientRect(), s = Math.max(view.w / r.width, view.h / r.height);
        view.x -= (t.x - pinch.x) * s; view.y -= (t.y - pinch.y) * s; setView();
        zoomAt(pinch.d / t.d, t.x, t.y);
        pinch = t; return;
      }
      if (!drag) return;
      const r = svg.getBoundingClientRect(), s = Math.max(view.w / r.width, view.h / r.height);
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { view.x = drag.vx - (e.clientX - drag.x) * s; view.y = drag.vy - (e.clientY - drag.y) * s; setView(); canvas.classList.add('grabbing'); }
    });
    canvas.addEventListener('pointerup', function (e) {
      const wasPinch = !!pinch || pts.size > 1; lift(e);
      if (wasPinch) { drag = null; return; }
      const d = drag; drag = null; canvas.classList.remove('grabbing');
      if (!d || d.moved) return;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const el = t && t.closest ? t.closest('[data-st]') : null;
      if (el) locate(el.getAttribute('data-st'));
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
      h('span', { html: '<svg width="26" height="26" viewBox="-13 -13 26 26">' + LG_X + '</svg>' }), '换乘站',
      h('span', { html: '<svg width="58" height="26" viewBox="-13 -13 58 26"><path d="M0 0H32" class="nm-walk-p"/>' + LG_X + '<g transform="translate(32 0)">' + LG_X + '</g></svg>' }), '站外步行换乘');
  }
  // 图例里的换乘站标志（两条线路）
  const LG_X = stationMark({ id: '' }, 0, 0, ['a', 'b'], { lines: { a: { color: '#f3d03e' }, b: { color: '#00629b' } } }, true, '换乘站').replace(/ data-st="[^"]*" data-lines="[^"]*"/, '');

  // ---------------- 导出 PNG：完整网络（不受当前缩放与聚焦影响）+ 标题、日期与线路图例 ----------------
  function exportCSS(font) {
    return 'text{font-family:' + font + '}.nm-elev{fill:none;stroke:#fff;stroke-width:2.2}.nm-surf{fill:none;stroke:rgba(255,255,255,.95);stroke-width:3;stroke-dasharray:2 5;stroke-linecap:butt}' +
      '.nm-walk path{fill:none;stroke:#25334a;stroke-width:2;stroke-dasharray:2 4;stroke-linecap:round;opacity:.55}.nm-st{fill:#fff;stroke-width:3.2}.nm-casing{stroke:#fff}' +
      '.nm-xo{fill:#fff;stroke:#25334a;stroke-width:3.3}.nm-xa{fill:none;stroke-width:2.3}.nm-xg{fill:none;stroke:#25334a;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}' +
      '.nm-label{font-size:' + LABEL_SIZE + 'px;font-weight:500;fill:#1f2a3a;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round}.nm-label.x{font-weight:700}.nm-badge-t{font-size:14px;font-weight:800;fill:#fff}' +
      '.nm-water{fill:#dcecf8;stroke:none}.nm-river path{stroke:#dcecf8}.nm-river .nm-river-area{fill:#dcecf8;stroke:none}.nm-green{fill:#e6f2e2;opacity:.65}.nm-terrain.simple .nm-green{opacity:.4}.nm-wlabel{font-size:12.5px;font-style:italic;letter-spacing:2px;fill:#6f9cc4}';
  }
  function exportPNG() {
    const g = game(), svg = root && root.querySelector('.nm-svg');
    if (!g || !svg || !view) return;
    const net = useDraft && g.draft ? g.draft.net : g.net, D = CM.DATA, isGeo = geographic;
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const W = view.W, H = view.H;
    const clone = svg.cloneNode(true);
    clone.setAttribute('viewBox', view.fullX + ' ' + view.fullY + ' ' + W + ' ' + H);
    clone.setAttribute('width', W.toFixed(0)); clone.setAttribute('height', H.toFixed(0));
    clone.classList.remove('focusing');
    clone.querySelectorAll('.on').forEach(function (el) { el.classList.remove('on'); });
    const layer = clone.querySelector('.nm-lines');
    if (layer) Array.from(layer.children).sort(function (a, b) { return Number(a.dataset.order) - Number(b.dataset.order); }).forEach(function (node) { layer.appendChild(node); });
    const st = document.createElementNS('http://www.w3.org/2000/svg', 'style'); st.textContent = exportCSS(font);
    clone.insertBefore(st, clone.firstChild);
    const img = new Image();
    img.onload = function () {
      const sc = Math.min(2, 7000 / Math.max(W, H)), M0 = 48 * sc;
      const lines = M.sortIds(Object.keys(net.lines)).map(function (lid) { return { L: net.lines[lid], tp: M.lineTopo(net, lid) }; }).filter(function (o) { return o.tp.topo !== 'empty'; });
      const cw = Math.max(W * sc + 2 * M0, 960 * sc), cols = Math.max(1, Math.floor((cw - 2 * M0) / (220 * sc)));
      const headH = 108 * sc, footH = (Math.ceil(lines.length / cols) * 34 + 92) * sc;
      const ch = headH + H * sc + footH;
      const cv = document.createElement('canvas'); cv.width = Math.round(cw); cv.height = Math.round(ch);
      const c = cv.getContext('2d');
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, cw, ch);
      c.fillStyle = '#1f2a3a'; c.textBaseline = 'alphabetic';
      c.font = '800 ' + (30 * sc) + 'px ' + font; c.fillText((D.city || '') + (isGeo ? '地铁地理线网图' : '地铁线路示意图'), M0, 56 * sc);
      c.font = (15 * sc) + 'px ' + font; c.fillStyle = '#5d6b80';
      let nSt = 0; for (const id in net.stations) if (M.stationLines(net, id).length) nSt++;
      c.fillText('游戏时间 ' + g.clock.y + ' 年 ' + g.clock.m + ' 月' + (useDraft ? '（含建设草案）' : '') + ' · ' + lines.length + ' 条线路 · ' + nSt + ' 座车站 · 《城市与地铁社区版》', M0, 84 * sc);
      c.drawImage(img, (cw - W * sc) / 2, headH, W * sc, H * sc);
      // 线路图例
      let y = headH + H * sc + 18 * sc;
      c.strokeStyle = '#e3e8ef'; c.lineWidth = 1 * sc; c.beginPath(); c.moveTo(M0, y); c.lineTo(cw - M0, y); c.stroke();
      y += 30 * sc;
      lines.forEach(function (o, k) {
        const x = M0 + (k % cols) * 220 * sc, yy = y + Math.floor(k / cols) * 34 * sc;
        c.fillStyle = o.L.color; c.beginPath(); c.roundRect ? c.roundRect(x, yy - 14 * sc, 30 * sc, 20 * sc, 6 * sc) : c.rect(x, yy - 14 * sc, 30 * sc, 20 * sc); c.fill();
        c.fillStyle = '#fff'; c.font = '800 ' + (12 * sc) + 'px ' + font; c.textAlign = 'center'; c.fillText(String(o.L.num || ''), x + 15 * sc, yy + 1 * sc);
        c.textAlign = 'left'; c.fillStyle = '#1f2a3a'; c.font = '600 ' + (14 * sc) + 'px ' + font; c.fillText(o.L.name, x + 40 * sc, yy);
        const nw = c.measureText(o.L.name).width;
        c.fillStyle = '#7a8799'; c.font = (12 * sc) + 'px ' + font; c.fillText(o.tp.stations.length + ' 站', x + 48 * sc + nw, yy);
      });
      c.fillStyle = '#9aa5b5'; c.font = (12 * sc) + 'px ' + font; c.textAlign = 'right';
      c.fillText('线型：实线为地下，带白色中线为高架，带白色枕木纹为地面；⇄ 圆环为换乘站，虚线相连为站外步行换乘', cw - M0, ch - 38 * sc);
      c.fillText(isGeo ? '按游戏地图中的实际站点、轨道与地形等比例绘制；共线区间以同心色带区分，站外虚线只表示换乘联系。' : '站点按实际位置统一等比例缩放；同向线路并排，线形为简化示意，不显示地形。', cw - M0, ch - 20 * sc);
      c.textAlign = 'left';
      cv.toBlob(function (blob) {
        if (!blob) { ui.toast('导出失败：浏览器无法生成图片', 'bad'); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (isGeo ? '地铁地理线网图-' : '地铁线路示意图-') + (D.city || '城市') + '-' + g.clock.y + '年' + g.clock.m + '月.png';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        ui.toast('已导出线路示意图（' + cv.width + '×' + cv.height + ' PNG）', 'good');
      }, 'image/png');
    };
    img.onerror = function () { ui.toast('导出失败：无法绘制示意图', 'bad'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  }

  let fresh = true;
  function render(keepView) {
    const g = game(); if (!g || !root) return;
    const savedView = keepView && view ? Object.assign({}, view) : null;
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
    const nLines = chips.childNodes.length, nStations = Object.keys(net.stations).filter(function (sid) { return M.stationLines(net, sid).length; }).length;
    const head = h('div', { class: 'stats-head' }, h('span', { class: 'badge b-blue' }, CM.icon('network')),
      h('div', { class: 'nm-heading' }, h('h2', null, (CM.DATA.city || '') + '地铁线网'), h('div', { class: 'tiny muted' }, g.clock.y + ' 年 ' + g.clock.m + ' 月 · ' + nLines + ' 条线路 · ' + nStations + ' 座车站')),
      h('div', { class: 'seg-ctl sm nm-mode', 'aria-label': '线路图布局' }, [[true, '地理线网'], [false, '简洁示意']].map(function (o) { return h('button', { class: geographic === o[0] ? 'on' : '', 'aria-pressed': geographic === o[0] ? 'true' : 'false', 'data-silent': '1', onclick: function () { if (geographic !== o[0]) { geographic = o[0]; CM.Sound && CM.Sound.play('soft'); render(); } } }, o[1]); })),
      hasDraft ? h('div', { class: 'seg-ctl sm' }, [[false, '正式网络'], [true, '含草案']].map(function (o) { return h('button', { class: useDraft === o[0] ? 'on' : '', 'data-silent': '1', onclick: function () { if (useDraft !== o[0]) { useDraft = o[0]; focus = null; render(); } } }, o[1]); })) : null,
      h('div', { class: 'grow' }),
      h('span', { class: 'tiny muted nm-hint' }, '滚轮缩放 · 拖动平移 · 点击车站定位'),
      h('div', { class: 'nm-tools' },
        h('button', { class: 'hbtn', 'data-tip': '放大', onclick: function () { zoomAt(0.7); } }, CM.icon('plus')),
        h('button', { class: 'hbtn', 'data-tip': '缩小', onclick: function () { zoomAt(1 / 0.7); } }, CM.icon('minus')),
        h('button', { class: 'hbtn', 'data-tip': '显示全部', onclick: fitView }, CM.icon('expand')),
        h('button', { class: 'hbtn' + (geographic && showTerrain ? ' on' : ''), disabled: !geographic, 'aria-label': '查看地形', 'data-tip': geographic ? (showTerrain ? '隐藏地形（江河、湖海与山林）' : '显示地形（江河、湖海与山林）') : '简洁示意不显示地形', 'data-silent': '1', onclick: function () { if (!geographic) return; showTerrain = !showTerrain; CM.Sound && CM.Sound.play('toggle'); render(true); } }, CM.icon('mountain'))),
      h('button', { class: 'btn sm', 'data-tip': '导出完整线路示意图（含标题与线路图例）', onclick: exportPNG }, CM.icon('export'), '导出 PNG'),
      h('button', { class: 'hbtn', 'data-tip': '关闭', 'data-key': 'Esc', onclick: function () { NetMap.close(); } }, CM.icon('close')));
    tgt = null;
    const canvas = build(g);
    if (!canvas.classList.contains('nm-canvas')) head.querySelectorAll('.nm-tools button, .btn').forEach(function (b) { b.disabled = true; });
    const bar = h('div', { class: 'nm-bar' }, chips.childNodes.length ? chips : null, legend(), h('span', { class: 'tiny muted' }, geographic ? '站线与地形等比例 · 可拖动浏览，或显示全图' : '站点位置等比例 · 线路走向示意 · 无地形'));
    const body = h('div', { class: 'nm-body' }, bar, canvas);
    // 只有打开时播放入场动画；打开后切换正式 / 含草案或网络变化时就地重绘，不闪动
    const win = h('div', { class: 'stats-win nm-win' + (fresh ? '' : ' static'), onclick: function (e) { e.stopPropagation(); } }, head, body);
    fresh = false;
    root.appendChild(win);
    if (savedView && view && savedView.W === view.W && savedView.H === view.H) { Object.assign(view, savedView); setView(); }
    else if (canvas.classList.contains('nm-canvas')) readableView(canvas);
    root.onclick = function () { NetMap.close(); };
    if (canvas.classList.contains('nm-canvas')) bindPanZoom(canvas);
    if (focus && !net.lines[focus]) focus = null;
    applyFocus();
  }

  const NetMap = {
    open: function (u) {
      ui = u;
      const g = game();
      if (g && g.id !== openedGameId) { openedGameId = g.id; focus = null; useDraft = false; }
      if (!root) { root = h('div', { id: 'netmap', class: 'hidden' }); document.getElementById('app').appendChild(root); }
      root.classList.remove('hidden');
      fresh = true;
      render();
    },
    close: function () { tgt = null; if (root) { root.classList.add('hidden'); root.innerHTML = ''; } },
    exportPNG: function () { exportPNG(); },
    isOpen: function () { return !!root && !root.classList.contains('hidden'); },
    refresh: function () { if (NetMap.isOpen()) render(); },
  };
  CM.NetMap = NetMap;
})(window.CM);
