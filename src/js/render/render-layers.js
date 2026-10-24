'use strict';
// 叠加图层：拥堵、出行方向、车站客流、重要设施、服务缺口、覆盖范围与地图定位高亮
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
  const CONG_MAXPX = CM.RH.LIMITS.CONG_MAXPX;

  // 道路拥堵图层：只显示主要道路（快速路与主干道），沿真实道路线形连续着色。折线约每 100 m 取一个样点，
  // 样点对应同名的模拟路段，取其当前时刻的饱和度；相邻同档样点合并为一段，按道路等级定粗细。
  // 0 畅通 · 1 缓行 · 2 拥堵 · 3 严重拥堵；按饱和度（小时流量 ÷ 通行能力）分档。已建成的主要道路全部着色（车少时为绿色）
  // 性能：各档连续段在时刻档（5 分钟）变化时才重建为世界坐标的 Path2D（只保留原折线顶点与分档断点），每帧按地图变换整体描边
  const CONG_COLS = ['#33a660', '#f2bf3a', '#f27a24', '#d3203a'];
  const CONG_CUT = [0.3, 0.55, 0.8];
  const CONG_TAU = 0.35;   // 拥堵颜色跟随实际车流量变化的过渡时间（秒）
  function congLvl(x) { let k = 0; while (k < 3 && x >= CONG_CUT[k]) k++; return k; }
  Renderer.CONG_COLS = CONG_COLS;
  Renderer.prototype.congIndex = function () {
    const city = this.game.city, car = city.car;
    if (this._cgIdx && this._cgIdx.city === city && this._cgIdx.ver === city.roadVersion) return this._cgIdx;
    const byName = new Map();
    for (const L of car.links) { if (L.cls < 3 || !L.name) continue; let a = byName.get(L.name); if (!a) { a = []; byName.set(L.name, a); } a.push(L); }
    const ways = [], ids = new Set(), STEP = 0.4;
    for (const w of city.roadWays) {
      const gr = city.roadGroups[w.g];
      if (gr.cls < 3 || (gr.flags & 4)) continue;   // 快速路、主干道（匝道不画）
      const p = w.p, xs = [], ys = [], vt = [];
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP));
        for (let q = k === 0 ? 0 : 1; q <= n; q++) { xs.push(ax + (bx - ax) * q / n); ys.push(ay + (by - ay) * q / n); vt.push(q === 0 || q === n ? 1 : 0); }
      }
      const near = byName.get(w.g + 1) || [], lk = new Int32Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        let best = -1, bd = 1.0;
        for (const L of near) {
          const b = L.bbox; if (xs[i] < b[0] - 1 || xs[i] > b[2] + 1 || ys[i] < b[1] - 1 || ys[i] > b[3] + 1) continue;
          const d = U.distToPoly(xs[i], ys[i], L.pts); if (d < bd) { bd = d; best = L.id; }
        }
        if (best < 0) { const L = this.pickLink(xs[i], ys[i], 0.6); if (L && L.cls >= 2) best = L.id; }
        lk[i] = best;
        if (best >= 0) ids.add(best);
      }
      ways.push({ g: w.g, cls: gr.cls, bbox: w.bbox, xs: Float32Array.from(xs), ys: Float32Array.from(ys), vt: Uint8Array.from(vt), lk: lk });
    }
    this._cgIdx = { city: city, ver: city.roadVersion, ways: ways, ids: ids };
    this._cgRuns = null; this._cgSat = null; this._cgLvl = null; this._cgTgt = null; this._cgTgtKey = null; this._cgDirty = true;
    return this._cgIdx;
  };
  // 各路段按当前时段的目标饱和度：只在时段档（5 分钟）、流量模型或路网变化时重算
  Renderer.prototype.congTargets = function (idx) {
    const model = this.game.model, clock = this.game.clock;
    const key = model.version + ':' + Math.floor(clock.minute / 5) + ':' + this.game.city.roadVersion;
    if (this._cgTgt && this._cgTgtKey === key) return this._cgTgt;
    const W = model.weights(clock.minute), tgt = new Map();
    for (const id of idx.ids) tgt.set(id, Math.max(model.arcVolAt(2 * id, W), model.arcVolAt(2 * id + 1, W)) / model.cap(2 * id));
    this._cgTgt = tgt; this._cgTgtKey = key;
    return tgt;
  };
  // 按平滑后的饱和度把各条道路分成不同拥堵档的连续段，并生成各档、各等级的 Path2D。
  // 显示值按真实时间指数逼近目标值：加速运行时车流量是一档一档跳的，直接按档重画会让整个路网红绿突变，
  // 平滑后颜色沿着路网一段段逐步过渡，路口也不会整片同时变色
  Renderer.prototype.congRuns = function () {
    const g = this.game, model = g.model, city = g.city, idx = this.congIndex();
    const key = model.version + ':' + city.roadVersion;
    const tgt = this.congTargets(idx);
    if (!this._cgSat) { this._cgSat = new Map(); this._cgLvl = new Map(); }
    const dtR = Math.max(0, Math.min(0.25, this.dt === undefined ? 0.016 : this.dt)), k = 1 - Math.exp(-dtR / CONG_TAU);
    for (const e of tgt) {
      const id = e[0], v0 = this._cgSat.get(id);
      const v = v0 === undefined ? e[1] : v0 + (e[1] - v0) * k;
      this._cgSat.set(id, v);
      const l = congLvl(v), old = this._cgLvl.get(id);
      if (old === undefined) this._cgLvl.set(id, l);
      else if (old !== l) { this._cgLvl.set(id, l); this._cgDirty = true; }
    }
    const now = performance.now();
    const stale = !this._cgRuns || this._cgRunsKey !== key;
    if (!stale && (!this._cgDirty || now - (this._cgBuildT || 0) < 100)) return this._cgRuns;   // 重新分段最多每 0.1 秒一次
    const satOf = (id) => { const v = this._cgSat.get(id); return v === undefined ? 0 : v; };
    const lvl = congLvl;
    const paths = [], halo = { 3: new Path2D(), 4: new Path2D() };
    for (let k = 0; k < 4; k++) paths.push({ 3: new Path2D(), 4: new Path2D() });
    let nRuns = 0;
    const push = function (w, a, b, k) {
      if (b <= a) return;
      const p = paths[k][w.cls], q = halo[w.cls];
      p.moveTo(w.xs[a], w.ys[a]); q.moveTo(w.xs[a], w.ys[a]);
      for (let i = a + 1; i < b; i++) if (w.vt[i]) { p.lineTo(w.xs[i], w.ys[i]); q.lineTo(w.xs[i], w.ys[i]); }
      p.lineTo(w.xs[b], w.ys[b]); q.lineTo(w.xs[b], w.ys[b]);
      nRuns++;
    };
    for (const w of idx.ways) {
      if (!city.roadsBuilt[w.g]) continue;
      const n = w.xs.length; if (n < 2) continue;
      let first = 0; for (let i = 0; i < n; i++) if (w.lk[i] >= 0) { first = lvl(satOf(w.lk[i])); break; }   // 没有对应路段的道路按畅通显示
      let cur = first, start = 0;
      for (let i = 1; i < n; i++) {
        const k = w.lk[i] >= 0 ? lvl(satOf(w.lk[i])) : cur;
        if (k !== cur) { push(w, start, i, cur); start = i; cur = k; }
      }
      push(w, start, n - 1, cur);
    }
    this._cgRuns = { paths: paths, halo: halo, n: nRuns }; this._cgRunsKey = key; this._cgDirty = false; this._cgBuildT = now;
    return this._cgRuns;
  };
  // 在世界坐标下描边各档路段；z 为对应的地图缩放（决定屏幕上的线宽）
  function strokeCong(ctx, cr, z) {
    const lw = U.clamp(z * 0.07, 1.6, 7) / z, halo = 3 / z;   // 线宽换算到世界单位
    const widthOf = { 3: 1, 4: 1.45 };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 先画衬边，再按拥堵程度从轻到重画颜色（重的压在上面）
    ctx.strokeStyle = S.TH.halo;
    for (const cls of [3, 4]) { ctx.lineWidth = lw * widthOf[cls] * 1.15 + halo; ctx.stroke(cr.halo[cls]); }
    for (let k = 0; k < 4; k++) {
      ctx.strokeStyle = CONG_COLS[k];
      for (const cls of [3, 4]) { ctx.lineWidth = lw * widthOf[cls] * (k >= 2 ? 1.15 : 1); ctx.stroke(cr.paths[k][cls]); }
    }
  }
  // 性能：大城市的主要道路很多，逐帧描边的栅格化开销会让帧率掉到 30 帧。改为把描边画进一张与世界坐标对齐的位图
  // （当前视野四周各留三成余量，像素数有上限），每帧按地图变换贴图。视野移出位图范围时立即重画；
  // 缩放变化超过两成时按新线宽重画（最多每 0.12 秒一次）；拥堵分档变化时最多每 0.2 秒重画一次
  Renderer.prototype.drawCongestion = function (ctx) {
    const cr = this.congRuns(), M = this.M, z = this.z, dpr = this.dpr, city = this.game.city, now = performance.now();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]]) { const p = this.unproject(s[0], s[1]); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(city.W, x1); y1 = Math.min(city.H, y1);
    if (x1 <= x0 || y1 <= y0) return;
    let c = this._cgBmp;
    const fresh = c && c.city === city && c.halo === S.TH.halo && c.night === S.TH.night;
    const inside = fresh && x0 >= c.x0 && y0 >= c.y0 && x1 <= c.x1 && y1 <= c.y1;
    const zoomed = fresh && Math.abs(z - c.z) > c.z * 0.2;
    if (!inside || (zoomed && now - c.t > 120) || (c.runs !== cr && now - c.t > 200)) {
      const mx = (x1 - x0) * 0.3, my = (y1 - y0) * 0.3;
      const bx0 = Math.max(0, x0 - mx), by0 = Math.max(0, y0 - my), bx1 = Math.min(city.W, x1 + mx), by1 = Math.min(city.H, y1 + my);
      const area = (bx1 - bx0) * (by1 - by0);
      const sb = Math.min(z * dpr, Math.sqrt(CONG_MAXPX / area));   // 位图每世界单位的像素数（上限约 600 万像素）
      const w = Math.ceil((bx1 - bx0) * sb), h = Math.ceil((by1 - by0) * sb);
      const cv = c && c.cv.width === w && c.cv.height === h ? c.cv : makeCanvas(w, h);
      const x = cv.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h);
      x.setTransform(sb, 0, 0, sb, -bx0 * sb, -by0 * sb);
      strokeCong(x, cr, z);
      c = this._cgBmp = { city: city, halo: S.TH.halo, night: S.TH.night, cv: cv, x0: bx0, y0: by0, x1: bx1, y1: by1, sb: sb, z: z, runs: cr, t: now };
    }
    const sb = c.sb;
    ctx.save();
    ctx.setTransform(dpr * M[0] * z / sb, dpr * M[2] * z / sb, dpr * M[1] * z / sb, dpr * M[3] * z / sb,
      dpr * (this.px + z * (M[0] * c.x0 + M[1] * c.y0)), dpr * (this.py + z * (M[2] * c.x0 + M[3] * c.y0)));
    ctx.drawImage(c.cv, 0, 0);
    ctx.restore();
  };
  // 出行方向图层：按片区（城市区域；老城区再分为越秀、东山、荔湾）汇总当前时段的出行，每个片区画出它最主要的出行方向
  // （第二方向接近最主要方向时也画出）：箭头从片区中心指向目的片区，尖端标出目的地。放置时按流量从大到小依次尝试缩短、
  // 小角度偏转，尽量不与其他箭头、片区名称重叠。新区域开放、城市发展后流向随之变化；箭头中间的蓝色部分是乘地铁的比例。
  // 结果只在模拟完成一整轮或时段变化时更新，箭头的出现、消失与粗细变化都平滑过渡（不跳闪）
  Renderer.prototype.flowAreas = function () {
    const g = this.game, city = g.city, model = g.model;
    if (this._fa && this._fa.city === city && this._fa.ver === city.version) return this._fa;
    const W = city.W, H = city.H, N = W * H;
    const names = [], idOf = new Map(), area = new Int16Array(N).fill(-1);
    const old = city.regions.findIndex(function (r) { return r.id === 'oldcity'; });
    const oldLabels = (city.districtLabels || []).filter(function (d) { return d[0] === '越秀' || d[0] === '东山' || d[0] === '荔湾'; });
    const short = function (n) { return n.replace(/（.*）/, '').replace(/·.*$/, ''); };
    for (let c = 0; c < N; c++) {
      const k = city.region[c], rg = city.regions[k];
      if (rg.scenic || !city.regionOpen[k] || city.landFrac[c] < 0.5) continue;
      let key = 'r' + k, name = short(rg.name);
      if (k === old && oldLabels.length) {
        const x = c % W + 0.5, y = ((c / W) | 0) + 0.5; let best = 0, bd = 1e9;
        oldLabels.forEach(function (d, q) { const dd = U.dist(x, y, d[1], d[2]); if (dd < bd) { bd = dd; best = q; } });
        key = 'o' + best; name = oldLabels[best][0];
      }
      let id = idOf.get(key); if (id === undefined) { id = names.length; idOf.set(key, id); names.push(name); }
      area[c] = id;
    }
    const n = names.length, sx = new Float64Array(n), sy = new Float64Array(n), sw = new Float64Array(n);
    for (let c = 0; c < N; c++) { const d = area[c]; if (d < 0) continue; const w = city.pop[c] + city.jobs[c] + 1; sx[d] += (c % W + 0.5) * w; sy[d] += (((c / W) | 0) + 0.5) * w; sw[d] += w; }
    const B = model.B, BW = model.BW, blk = new Int16Array(B).fill(-1), Z = CFG.ZONE * 2;
    for (let b = 0; b < B; b++) {
      const bi = b % BW, bj = (b / BW) | 0, cnt = new Map();
      for (let j = bj * Z; j < Math.min(H, bj * Z + Z); j++) for (let i = bi * Z; i < Math.min(W, bi * Z + Z); i++) { const c = j * W + i, d = area[c]; if (d >= 0) cnt.set(d, (cnt.get(d) || 0) + city.pop[c] + city.jobs[c] + 1); }
      let best = -1, bn = 0; cnt.forEach(function (v, d) { if (v > bn) { bn = v; best = d; } }); blk[b] = best;
    }
    this._fa = { city: city, ver: city.version, names: names, x: Array.from(sx, function (v, k) { return sw[k] ? v / sw[k] : 0; }), y: Array.from(sy, function (v, k) { return sw[k] ? v / sw[k] : 0; }), blk: blk };
    return this._fa;
  };
  Renderer.prototype.flowList = function () {
    const g = this.game, model = g.model, fa = this.flowAreas();
    const p = model.weights(g.clock.minute).p0, mode = this.layerOpt.flow;
    const key = model.cycles + ':' + model.dayType + ':' + p + ':' + mode + ':' + fa.ver + ':' + g.netVersion;
    if (this._fl && this._flKey === key) return this._fl;
    const P = model.live.per[p], B = model.B, n = fa.names.length;
    const tot = new Float64Array(n * n), met = new Float64Array(n * n), node = new Float64Array(n);
    for (let a = 0; a < B; a++) {
      const da = fa.blk[a]; if (da < 0) continue;
      for (let b = 0; b < B; b++) {
        const db = fa.blk[b]; if (db < 0) continue;
        const k = a * B + b, t = P.desTot[k]; if (!(t > 0)) continue;
        const m = P.desMetro[k], f = mode === 'metro' ? m : (mode === 'car' ? t - m : t);
        node[da] += f;
        if (da !== db) { tot[da * n + db] += f; met[da * n + db] += m; }
      }
    }
    const list = [];
    const add = function (a, b, f, rank) { list.push({ key: a + '>' + b, a: a, b: b, f: f, rank: rank, share: mode === 'metro' ? 1 : (mode === 'car' ? 0 : met[a * n + b] / f) }); };
    for (let a = 0; a < n; a++) {
      let b1 = -1, f1 = 0, b2 = -1, f2 = 0;
      for (let b = 0; b < n; b++) { const f = tot[a * n + b]; if (f > f1) { b2 = b1; f2 = f1; b1 = b; f1 = f; } else if (f > f2) { b2 = b; f2 = f; } }
      if (b1 >= 0) add(a, b1, f1, 0);
      if (b2 >= 0 && f2 >= f1 * 0.6) add(a, b2, f2, 1);
    }
    list.sort(function (x, y) { return y.f - x.f; });
    // 两个片区互为主要方向时合并为一条双向箭头（两端都是片区圆点，不必另标目的地）
    const byKey = new Map(), top = [];
    for (const e of list) byKey.set(e.key, e);
    for (const e of list) {
      if (e.used) continue;
      e.used = true;
      const r = byKey.get(e.b + '>' + e.a);
      if (r && !r.used) {
        r.used = true;
        const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
        top.push({ key: a + '<>' + b, a: a, b: b, f: Math.max(e.f, r.f), both: true, share: (e.share * e.f + r.share * r.f) / (e.f + r.f) });
      } else top.push(e);
    }
    const mx = top.length ? top[0].f : 1;
    let nmx = 1; for (const v of node) nmx = Math.max(nmx, v);
    this._fl = { top: top.filter(function (e) { return e.f >= mx * 0.015; }), mx: mx, node: node, nodeMax: nmx }; this._flKey = key;
    return this._fl;
  };
  // 箭头几何（屏幕坐标）：从起点片区的圆边出发，朝目的片区方向（可偏转 ang），长度约为两地距离的一半（乘 lf），并略偏向右侧，
  // 使相向的两条箭头并排而不重叠。距离太近（缩得太小）时返回 null
  const flowGeo = function (pa, pb, ra, rb, w, ang, lf) {
    const dx = pb.x - pa.x, dy = pb.y - pa.y, dist = Math.hypot(dx, dy);
    if (dist < ra + rb + 26) return null;
    const t = Math.atan2(dy, dx) + ang, ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
    const off = w / 2 + 2, s0 = ra + 3, ah = 5 + w * 0.7;
    const L = Math.min(dist - rb - ah - 4, U.clamp(dist * 0.5, 42, 150)) * lf;
    if (L < s0 + 14) return null;
    const sx = pa.x + ux * s0 + nx * off, sy = pa.y + uy * s0 + ny * off, ex = pa.x + ux * L + nx * off, ey = pa.y + uy * L + ny * off;
    return { sx: sx, sy: sy, ex: ex, ey: ey, tx: ex + ux * ah, ty: ey + uy * ah, ux: ux, uy: uy, nx: nx, ny: ny, ah: ah };
  };
  // 双向箭头：连接两个片区圆点，两端各有箭头（ax,ay 为起点端尖端）
  const flowGeo2 = function (pa, pb, ra, rb, w) {
    const dx = pb.x - pa.x, dy = pb.y - pa.y, dist = Math.hypot(dx, dy), ah = 5 + w * 0.7;
    if (dist < ra + rb + ah * 2 + 14) return null;
    const ux = dx / dist, uy = dy / dist;
    const ax = pa.x + ux * (ra + 3), ay = pa.y + uy * (ra + 3), tx = pb.x - ux * (rb + 3), ty = pb.y - uy * (rb + 3);
    return { both: true, ax: ax, ay: ay, tx: tx, ty: ty, sx: ax + ux * ah, sy: ay + uy * ah, ex: tx - ux * ah, ey: ty - uy * ah, ux: ux, uy: uy, nx: -uy, ny: ux, ah: ah };
  };
  // 碰撞检测用的箭头线段：去掉靠近片区圆点的根部，从同一片区出发、方向不同的箭头不算重叠
  const flowSpan = function (G) {
    const t = 12, x1 = G.both ? G.ax : G.sx, y1 = G.both ? G.ay : G.sy;
    return [x1 + G.ux * t, y1 + G.uy * t, G.tx - (G.both ? G.ux * t : 0), G.ty - (G.both ? G.uy * t : 0)];
  };
  const segDist = function (ax, ay, bx, by, cx, cy, dx, dy) {
    const ps = function (px, py, x1, y1, x2, y2) { const vx = x2 - x1, vy = y2 - y1, l2 = vx * vx + vy * vy; const t = l2 ? U.clamp(((px - x1) * vx + (py - y1) * vy) / l2, 0, 1) : 0; return Math.hypot(px - x1 - vx * t, py - y1 - vy * t); };
    const cr = function (x1, y1, x2, y2, x3, y3) { return (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1); };
    const d1 = cr(ax, ay, bx, by, cx, cy), d2 = cr(ax, ay, bx, by, dx, dy), d3 = cr(cx, cy, dx, dy, ax, ay), d4 = cr(cx, cy, dx, dy, bx, by);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
    return Math.min(ps(ax, ay, cx, cy, dx, dy), ps(bx, by, cx, cy, dx, dy), ps(cx, cy, ax, ay, bx, by), ps(dx, dy, ax, ay, bx, by));
  };
  const flowLabelBox = function (G, tw) {
    const k = 5 + (tw / 2) * Math.abs(G.ux) + 8 * Math.abs(G.uy), cx = G.tx + G.ux * k, cy = G.ty + G.uy * k;
    return { cx: cx, cy: cy, x0: cx - tw / 2 - 2, y0: cy - 8, x1: cx + tw / 2 + 2, y1: cy + 8 };
  };
  // 布局：只在流向列表、缩放档位或视角变化时重算（与平移无关），结果是每条箭头选定的偏转、长度与是否标注目的地
  Renderer.prototype.flowLayout = function (ctx, fa, fl, show) {
    const M = this.M, z = this.z;
    const key = this._flKey + '|' + Math.round(Math.log2(z) * 5) + '|' + M.map(function (v) { return v.toFixed(2); }).join(',') + '|' + this.w + 'x' + this.h;
    if (this._flLay && this._flLayKey === key) return this._flLay;
    const q = function (d) { return { x: (M[0] * fa.x[d] + M[1] * fa.y[d]) * z, y: (M[2] * fa.x[d] + M[3] * fa.y[d]) * z }; };
    const rad = function (d) { return 4 + 6 * Math.sqrt(fl.node[d] / fl.nodeMax); };
    const caps = [], rects = [];
    const capRect = function (x1, y1, x2, y2, r, b) { for (let k = 0; k <= 8; k++) { const px = x1 + (x2 - x1) * k / 8, py = y1 + (y2 - y1) * k / 8; if (px > b.x0 - r && px < b.x1 + r && py > b.y0 - r && py < b.y1 + r) return true; } return false; };
    const hitRect = function (b) { let n = 0; for (const r of rects) if (b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0) n++; for (const c of caps) if (capRect(c.x1, c.y1, c.x2, c.y2, c.r, b)) n++; return n; };
    const hitCap = function (x1, y1, x2, y2, r, own) {
      let n = 0;
      for (const c of caps) if (c.own !== own && segDist(x1, y1, x2, y2, c.x1, c.y1, c.x2, c.y2) < r + c.r) n++;
      for (const b of rects) if (b.own !== own && capRect(x1, y1, x2, y2, r, b)) n++;
      return n;
    };
    // 片区圆点与名称先占位
    ctx.font = '600 12px ' + FONT;
    const nodes = new Set(); show.forEach(function (s) { nodes.add(s.e.a); if (s.e.both) nodes.add(s.e.b); });
    nodes.forEach(function (d) { const p = q(d), r = rad(d), tw = ctx.measureText(fa.names[d]).width; caps.push({ x1: p.x, y1: p.y, x2: p.x, y2: p.y, r: r + 2, own: d }); rects.push({ x0: p.x - tw / 2 - 3, y0: p.y + r + 3, x1: p.x + tw / 2 + 3, y1: p.y + r + 19, own: d }); });
    const out = new Map();
    // 双向箭头位置固定（连接两个圆点），先占位
    show.forEach(function (s) {
      if (!s.e.both) return;
      const G = flowGeo2(q(s.e.a), q(s.e.b), rad(s.e.a), rad(s.e.b), 2.5 + 9 * Math.sqrt(s.tw)); if (!G) return;
      const sp = flowSpan(G); caps.push({ x1: sp[0], y1: sp[1], x2: sp[2], y2: sp[3], r: 2.5 + 4.5 * Math.sqrt(s.tw) + 2, own: -1 });
      out.set(s.e.key, { ang: 0, lf: 1, label: false });
    });
    // 单向箭头：按流量从大到小依次放置，依次尝试原方向、缩短、小角度偏转
    const CAND = [[0, 1], [0, 0.72], [0.2, 1], [-0.2, 1], [0.2, 0.72], [-0.2, 0.72], [0, 0.5], [0.2, 0.5], [-0.2, 0.5], [0.4, 0.72], [-0.4, 0.72], [0.4, 0.5], [-0.4, 0.5]];
    ctx.font = '600 11px ' + FONT;
    const items = Array.from(show.values()).filter(function (s) { return !s.e.both; }).sort(function (x, y) { return y.tw - x.tw; });
    for (const s of items) {
      const e = s.e, pa = q(e.a), pb = q(e.b), w = 2.5 + 9 * Math.sqrt(s.tw), tw = ctx.measureText(fa.names[e.b]).width;
      let best = null;
      for (const cd of CAND) {
        const G = flowGeo(pa, pb, rad(e.a), rad(e.b), w, cd[0], cd[1]); if (!G) continue;
        const sp = flowSpan(G), ha = hitCap(sp[0], sp[1], sp[2], sp[3], w / 2 + 2, e.a), lb = flowLabelBox(G, tw), hl = hitRect(lb);
        const sc = ha * 10 + (hl ? 1 : 0);
        if (!best || sc < best.sc) best = { sc: sc, ang: cd[0], lf: cd[1], G: G, sp: sp, lb: lb, label: hl === 0 };
        if (sc === 0) break;
      }
      if (!best) continue;
      const sp = best.sp;
      caps.push({ x1: sp[0], y1: sp[1], x2: sp[2], y2: sp[3], r: w / 2 + 2, own: -1 });
      if (best.label) rects.push({ x0: best.lb.x0, y0: best.lb.y0, x1: best.lb.x1, y1: best.lb.y1, own: -1 });
      out.set(e.key, { ang: best.ang, lf: best.lf, label: best.label });
    }
    this._flLay = out; this._flLayKey = key;
    return out;
  };
  Renderer.prototype.drawDesire = function (ctx) {
    const fa = this.flowAreas(), fl = this.flowList(), mode = this.layerOpt.flow, dt = Math.min(0.1, this.dt || 0.016);
    // 平滑过渡：每条流向的透明度与粗细逐帧趋近目标值
    const show = this._flShow || (this._flShow = new Map());
    if (this._flShowArea !== fa) { show.clear(); this._flShowArea = fa; this._flLayKey = null; }
    const want = new Set();
    for (const e of fl.top) {
      want.add(e.key);
      let s = show.get(e.key);
      if (!s) { s = { a: 0, w: e.f / fl.mx, share: e.share }; show.set(e.key, s); }
      s.e = e; s.tw = e.f / fl.mx; s.ts = e.share;
    }
    show.forEach(function (s, k) {
      const on = want.has(k);
      s.a = U.clamp(s.a + (on ? dt : -dt) / 0.45, 0, 1);
      if (on) { s.w += (s.tw - s.w) * Math.min(1, dt * 4); s.share += (s.ts - s.share) * Math.min(1, dt * 4); }
      if (!on && s.a <= 0) show.delete(k);
    });
    const lay = this.flowLayout(ctx, fa, fl, show);
    const rad = function (d) { return 4 + 6 * Math.sqrt(fl.node[d] / fl.nodeMax); };
    const pos = (d) => this.P(fa.x[d], fa.y[d], 0);
    const metroCol = [33, 102, 204], carCol = mode === 'car' ? [222, 112, 46] : [128, 134, 148];
    const items = Array.from(show.values()).sort(function (x, y) { return x.w - y.w; });
    const nodeA = new Map(), labels = [];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of items) {
      const e = s.e, c = lay.get(e.key); if (!c) continue;
      const w = 2.5 + 9 * Math.sqrt(Math.max(0, s.w));
      const G = e.both ? flowGeo2(pos(e.a), pos(e.b), rad(e.a), rad(e.b), w) : flowGeo(pos(e.a), pos(e.b), rad(e.a), rad(e.b), w, c.ang, c.lf); if (!G) continue;
      nodeA.set(e.a, Math.max(nodeA.get(e.a) || 0, s.a));
      if (e.both) nodeA.set(e.b, Math.max(nodeA.get(e.b) || 0, s.a));
      const share = mode === 'metro' ? 1 : U.clamp(s.share, 0, 1);
      ctx.globalAlpha = s.a;
      ctx.beginPath(); ctx.moveTo(G.sx, G.sy); ctx.lineTo(G.ex, G.ey);
      ctx.strokeStyle = S.TH.halo; ctx.lineWidth = w + 4; ctx.stroke();
      ctx.strokeStyle = U.rgb(share >= 0.999 ? metroCol : carCol, 0.94); ctx.lineWidth = w; ctx.stroke();
      if (share > 0.02 && share < 0.999) { ctx.strokeStyle = U.rgb(metroCol, 0.95); ctx.lineWidth = Math.max(1.5, w * share); ctx.stroke(); }   // 乘地铁部分
      const hw = G.ah * 0.62, fill = U.rgb(share > 0.5 ? metroCol : carCol, 1);
      const head = function (tx, ty, ux, uy) {
        const bx = tx - ux * (G.ah + 2), by = ty - uy * (G.ah + 2);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.closePath();
        ctx.strokeStyle = S.TH.halo; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = fill; ctx.fill();
      };
      head(G.tx, G.ty, G.ux, G.uy);
      if (G.both) head(G.ax, G.ay, -G.ux, -G.uy);
      if (c.label) labels.push({ G: G, t: fa.names[e.b], a: s.a });
    }
    // 目的地名称（箭头尖端）
    ctx.font = '600 11px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const L of labels) {
      const b = flowLabelBox(L.G, ctx.measureText(L.t).width);
      ctx.globalAlpha = L.a; ctx.lineWidth = 3; ctx.strokeStyle = S.TH.halo; ctx.strokeText(L.t, b.cx, b.cy);
      ctx.fillStyle = S.TH.night ? '#b9c4cf' : '#465264'; ctx.fillText(L.t, b.cx, b.cy);
    }
    // 片区圆点与名称
    ctx.font = '700 12px ' + FONT;
    nodeA.forEach((a, d) => {
      const p = pos(d), r = rad(d);
      ctx.globalAlpha = a;
      ctx.fillStyle = S.TH.stFill; ctx.strokeStyle = S.TH.stInter; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 3.5; ctx.strokeStyle = S.TH.halo; ctx.strokeText(fa.names[d], p.x, p.y + r + 11); ctx.fillStyle = S.TH.ink; ctx.fillText(fa.names[d], p.x, p.y + r + 11);
    });
    ctx.globalAlpha = 1;
  };
  // 车站客流图层：用典型工作日的全天数据（夜间停运时同样可看）。圆的大小 = 车站日客流，颜色 = 高峰小时负荷；
  // 线路下方的半透明色带 = 区间日断面客流（双向合计）；客流较大的车站标出数值
  // 统计口径（layerOpt.stDt）：周平均（5 个工作日 + 2 个周末日）、工作日或周末；高峰负荷为所选日类型中最大的高峰小时值
  Renderer.prototype.stationFlowData = function () {
    const model = this.game.model, net = model.net, dt = this.layerOpt.stDt || 'avg';
    const sd = model.dailyStale ? null : (dt === 'wd' ? model.stDailyWk : (dt === 'we' ? model.stDailyWe : model.stDaily));
    if (!net || !sd || !net.N) return null;
    const kind = this.layerOpt.station, key = model.cycles + ':' + model.version + ':' + net.N + ':' + net.R + ':' + kind + ':' + dt;
    if (this._sf && this._sfKey === key) return this._sf;
    const C = net.C, N = net.N, val = new Float32Array(N), ratio = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = sd.inn[i] || 0, b = sd.out[i] || 0, x = sd.xfer[i] || 0;
      val[i] = kind === 'in' ? a : (kind === 'out' ? b : (kind === 'xfer' ? x : a + b + x));
      ratio[i] = (sd.peak[i] || 0) / CFG.metro.stationCap[C.stations[i].size];
    }
    const W = CFG.trips.weekWeights, dts = dt === 'avg' ? [['wd', W.wd], ['we', W.we]] : [[dt, 1]];
    const segLoad = new Map(), segLF = new Map();
    for (let r = 0; r < net.R; r++) {
      const rt = C.routes[r], re = net.rideEdge[r];
      for (let k = 0; k < rt.segRefs.length; k++) {
        let d = 0, lf = 0;
        for (const x of dts) for (let p = 0; p < 4; p++) {
          const P = model.ctxs[x[0]].per[p];
          if (!P.load || P.load.length !== net.nE) continue;
          d += ((P.load[re[2 * k]] || 0) + (P.load[re[2 * k + 1]] || 0)) * model.pHours[p] * (p === 3 ? 0.9 : 1) * x[1];
          const capH = Math.max(1, (P.freq[r] || 0) * rt.cap);
          lf = Math.max(lf, (P.load[re[2 * k]] || 0) / capH, (P.load[re[2 * k + 1]] || 0) / capH);
        }
        const id = rt.segRefs[k].id; segLoad.set(id, Math.max(segLoad.get(id) || 0, d)); segLF.set(id, Math.max(segLF.get(id) || 0, lf));
      }
    }
    let vmax = 1; for (let i = 0; i < N; i++) vmax = Math.max(vmax, val[i]);
    let smax = 1; segLoad.forEach(function (v) { smax = Math.max(smax, v); });
    this._sf = { val: val, ratio: ratio, segLoad: segLoad, segLF: segLF, vmax: vmax, smax: smax }; this._sfKey = key;
    return this._sf;
  };
  Renderer.prototype.drawStationFlows = function (ctx) {
    const g = this.game, model = g.model, net = model.net;
    if (!net || !this.stPx || !this.drawnC) return;
    const sf = this.stationFlowData(); if (!sf) return;
    const C = net.C, DC = this.drawnC, zk = U.clamp(this.z / 26, 0.45, 1.15);   // 圆的大小随缩放变化，缩小时不互相压住
    const loadView = this.layerOpt.stView === 'load';
    // 区间断面客流色带（高峰负荷视图：按高峰小时满载率着色）
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    sf.segLoad.forEach((v, id) => {
      const arr = this.segPx && this.segPx.get(id); if (!arr || v <= 0) return;
      const cs = C.segs.get(id), L = cs && C.net.lines[cs.seg.line]; if (!L) return;
      if (loadView) {
        const lf = sf.segLF.get(id) || 0, col = lf > 1 ? [217, 58, 58] : (lf > 0.6 ? [232, 163, 58] : [47, 163, 107]);
        ctx.strokeStyle = U.rgb(col, 0.55); ctx.lineWidth = this.lineWidthPx() + (4 + 10 * Math.min(1.5, lf)) * zk;
      } else { ctx.strokeStyle = U.rgb(U.hex2rgb(L.color), 0.32); ctx.lineWidth = this.lineWidthPx() + (3 + 22 * Math.sqrt(v / sf.smax)) * zk; }
      this.strokeArr(ctx, arr);
    });
    // 车站：按客流从小到大画，大站在上
    const list = [];
    for (let i = 0; i < C.stations.length; i++) {
      const k = DC.sIndex.get(C.stations[i].id); if (k === undefined) continue;
      const sp = this.stPx[k]; if (!sp || !(sf.val[i] > 0)) continue;
      list.push({ i: i, sp: sp, v: sf.val[i], r: (4 + 20 * Math.sqrt(sf.val[i] / sf.vmax)) * zk });
    }
    list.sort(function (a, b) { return a.v - b.v; });
    for (const it of list) {
      const rt = sf.ratio[it.i], col = rt > 1 ? [217, 58, 58] : (rt > 0.6 ? [240, 160, 32] : [31, 143, 191]);
      ctx.fillStyle = U.rgb(col, 0.78); ctx.strokeStyle = S.TH.halo; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(it.sp.cx, it.sp.cy, it.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // 标注：站名 + 日客流，放在圆的下方；大站优先，互不重叠（本图层不显示普通站名）
    const placed = list.map(function (it) { return [it.sp.cx - it.r * 0.7, it.sp.cy - it.r * 0.7, it.sp.cx + it.r * 0.7, it.sp.cy + it.r * 0.7]; });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let shown = 0;
    for (let q = list.length - 1; q >= 0 && shown < 30; q--) {
      const it = list[q], name = C.stations[it.i].name, val = loadView ? '高峰负荷 ' + U.fmtPct(sf.ratio[it.i], 0) : U.fmtPeople(it.v) + ' 人次';
      ctx.font = '600 12px ' + FONT; const w1 = ctx.measureText(name).width;
      ctx.font = '11px ' + FONT; const w2 = ctx.measureText(val).width;
      const w = Math.max(w1, w2) + 6, x = this.snapPx(it.sp.cx), y = this.snapPx(it.sp.cy + it.r + 4);
      const b = [x - w / 2, y, x + w / 2, y + 28];
      if (placed.some(function (o, k) { return k !== q && b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]; })) continue;
      placed.push(b); shown++;
      ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = S.TH.halo;
      ctx.font = '600 12px ' + FONT; ctx.strokeText(name, x, y + 7); ctx.fillStyle = S.TH.ink; ctx.fillText(name, x, y + 7);
      ctx.font = '11px ' + FONT; ctx.strokeText(val, x, y + 21); ctx.fillStyle = S.TH.roadInk; ctx.fillText(val, x, y + 21);
    }
  };
  // 重要设施（v1.9）：设施出行需求与地铁服务缺口图层中的设施圆点
  // 圆的大小 = 所选日类型的日到访量（枢纽为到达与离开合计），外环颜色 = 乘地铁比例（红 → 绿）；服务缺口图层只突出无地铁接驳的设施
  Renderer.prototype.facMarkers = function () {
    const g = this.game, model = g.model, fn = model.fn;
    if (!fn || !model.facDaily) return null;
    const dt = this.layer === 'gap' ? (this.layerOpt.gapDt === 'we' ? 'we' : 'wd') : (this.layerOpt.facDt === 'we' ? 'we' : 'wd');
    const fd = model.facData(dt); if (!fd || fd.F !== fn.F) return null;
    const acc = model.net ? model.net.acc : null, facP = this.layerOpt.facP, PK = CFG.trips.keys;
    const out = [];
    let vmax = 1;
    fn.list.forEach(function (f, k) {
      let v = f.T.hub ? fd.inn[k] + fd.out[k] : fd.inn[k];
      const m = f.T.hub ? fd.innM[k] + fd.outM[k] : fd.innM[k];
      if (this.layer === 'fac' && facP !== 'all') { const qi = PK.indexOf(facP); v = qi >= 0 ? fd.purp[k * 6 + qi] * (f.T.hub && facP === 'hb' ? 2 : 1) : 0; if (!(v > 0)) return; }
      const cov = acc && acc.NZ === fn.NZ ? acc.zCov[model.Z + k] : 0;
      out.push({ f: f, k: k, v: v, share: v > 0 ? m / Math.max(v, 1) : 0, cov: cov });
      if (v > vmax) vmax = v;
    }, this);
    return { list: out, vmax: vmax };
  };
  Renderer.prototype.drawFacilities = function (ctx) {
    this._facPx = [];
    const fm = this.facMarkers(); if (!fm) return;
    const gap = this.layer === 'gap', zk = U.clamp(this.z / 26, 0.5, 1.15), tmp = {};
    const list = fm.list.slice().sort(function (a, b) { return a.v - b.v; });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const it of list) {
      if (gap && (it.cov >= 0.3 || it.v < 1500)) continue;
      const p = this.P(it.f.x, it.f.y, 0, tmp);
      if (p.x < -40 || p.y < -40 || p.x > this.w + 40 || p.y > this.h + 40) continue;
      const r = (4 + 16 * Math.sqrt(it.v / fm.vmax)) * zk;
      const ring = gap ? [122, 31, 31] : U.ramp([[0, [214, 52, 52]], [0.25, [236, 160, 50]], [0.6, [40, 160, 90]]], U.clamp(it.share, 0, 0.6) / 0.6);
      ctx.fillStyle = gap ? 'rgba(122,31,31,0.18)' : U.rgb(U.hex2rgb(CFG.trips.color[Object.keys(it.f.p)[0]] || '#888888'), 0.55);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = U.rgb(ring, 0.95); ctx.stroke();
      ctx.lineWidth = 1.2; ctx.strokeStyle = S.TH.halo; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke();
      this._facPx.push({ id: it.f.id, x: p.x, y: p.y, r: Math.max(8, r + 2) });
    }
    // 标注：到访量较大的设施（不互相重叠）
    const placed = [];
    let shown = 0;
    for (let q = list.length - 1; q >= 0 && shown < 24; q--) {
      const it = list[q];
      if (gap && (it.cov >= 0.3 || it.v < 1500)) continue;
      const p = this.P(it.f.x, it.f.y, 0, tmp), r = (4 + 16 * Math.sqrt(it.v / fm.vmax)) * zk;
      const name = it.f.name.replace(/（.*）/, ''), val = gap ? '无地铁接驳 · ' + U.fmtPeople(it.v) + ' 人次' : U.fmtPeople(it.v) + ' 人次 · 地铁 ' + U.fmtPct(it.share, 0);
      ctx.font = '600 12px ' + FONT; const w = Math.max(ctx.measureText(name).width, ctx.measureText(val).width * 0.92) + 8;
      const b = [p.x - w / 2, p.y + r + 2, p.x + w / 2, p.y + r + 30];
      if (b[2] < 0 || b[0] > this.w || b[3] < 0 || b[1] > this.h) continue;
      if (placed.some(function (o) { return b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]; })) continue;
      placed.push(b); shown++;
      ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = S.TH.halo;
      const tx = this.snapPx(p.x), ty = this.snapPx(p.y + r + 9), ty2 = this.snapPx(p.y + r + 23);
      ctx.strokeText(name, tx, ty); ctx.fillStyle = S.TH.ink; ctx.fillText(name, tx, ty);
      ctx.font = '11px ' + FONT; ctx.strokeText(val, tx, ty2); ctx.fillStyle = S.TH.roadInk; ctx.fillText(val, tx, ty2);
    }
  };
  // 点击选中设施：设施图层中的圆点；其他情况下点在设施场地（地标）或其中心附近
  Renderer.prototype.pickFacility = function (sx, sy, wx, wy) {
    const g = this.game, model = g && g.model;
    if (!model || !model.fn) return null;
    if ((this.layer === 'fac' || this.layer === 'gap') && this._facPx) {
      let best = null, bd = 1e9;
      for (const it of this._facPx) { const d = Math.hypot(sx - it.x, sy - it.y); if (d <= it.r && d < bd) { bd = d; best = it.id; } }
      if (best) return best;
    }
    let best = null, bd = 1e9;
    for (const f of model.fn.list) {
      let hit = false, d = U.dist(wx, wy, f.x, f.y);
      if (f.lmK >= 0) hit = g.city.inLandmarkSite(f.lmK, wx, wy) || d < 0.35;
      else hit = d < Math.min(0.6, Math.max(0.3, f.r * 0.5));
      if (hit && d < bd) { bd = d; best = f.id; }
    }
    return best;
  };
  // 地铁服务缺口：已有地铁但高峰超载的车站与区间（按所选日类型）
  Renderer.prototype.drawGapOverload = function (ctx) {
    const model = this.game.model, net = model.net;
    if (!net || !net.R || !this.stPx || !this.drawnC) return;
    const dt = this.layerOpt.gapDt === 'we' ? 'we' : 'wd', sd = dt === 'we' ? model.stDailyWe : model.stDailyWk;
    const C = net.C, DC = this.drawnC, zk = U.clamp(this.z / 26, 0.5, 1.15);
    ctx.lineCap = 'round';
    for (let r = 0; r < net.R; r++) {
      const rt = C.routes[r], re = net.rideEdge[r];
      for (let k = 0; k < rt.segRefs.length; k++) {
        let lf = 0;
        for (let p = 0; p < 4; p++) { const P = model.ctxs[dt].per[p]; if (!P.load || P.load.length !== net.nE) continue; const cap = Math.max(1, P.freq[r] * rt.cap); lf = Math.max(lf, P.load[re[2 * k]] / cap, P.load[re[2 * k + 1]] / cap); }
        if (lf <= 1) continue;
        const arr = this.segPx && this.segPx.get(rt.segRefs[k].id); if (!arr) continue;
        ctx.strokeStyle = 'rgba(239,138,58,0.75)'; ctx.lineWidth = this.lineWidthPx() + 8 * zk; this.strokeArr(ctx, arr);
      }
    }
    if (!sd || model.dailyStale) return;
    for (let i = 0; i < C.stations.length; i++) {
      const ratio = (sd.peak[i] || 0) / CFG.metro.stationCap[C.stations[i].size]; if (ratio <= 1) continue;
      const k = DC.sIndex.get(C.stations[i].id); if (k === undefined) continue;
      const sp = this.stPx[k]; if (!sp) continue;
      ctx.fillStyle = 'rgba(239,138,58,0.55)'; ctx.strokeStyle = 'rgba(190,90,20,0.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sp.cx, sp.cy, (9 + 6 * Math.min(1, ratio - 1)) * zk, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  };
  // 地铁覆盖图层附加：地面铁路的阻隔（无通道处）、按车站划分时的分界线、选中车站的步行范围
  Renderer.prototype.coverGeom = function () {
    const g = this.game, city = g.city, model = g.model, acc = model.net ? model.net.acc : null;
    const key = city.roadVersion + ':' + city.version + ':' + g.netVersion + ':' + (acc ? 1 : 0) + ':' + this.layerOpt.cover;
    if (this._cg2 && this._cg2.key === key && this._cg2.acc === acc) return this._cg2;
    const W = city.W, H = city.H, VW = city.VW, rail = [], bound = [];
    if (city.eRail) for (let e = 0; e < city.eRail.length; e++) {
      if (city.eRail[e] !== 2 || city.eCls[e] >= 3 || city.eCls[e] < 1) continue;
      const uv = city.edgeVerts(e); rail.push([uv[0] % VW, (uv[0] / VW) | 0, uv[1] % VW, (uv[1] / VW) | 0]);
    }
    if (acc && this.layerOpt.cover === 'station') {
      const cs = acc.cellStation, cw = acc.cellWalk, mx = CFG.walk.maxAccessM;
      const st = function (c) { return cw[c] <= mx ? cs[c] : -1; };
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const c = j * W + i, a = st(c); if (a < 0) continue;
        if (i + 1 < W) { const b = st(c + 1); if (b >= 0 && b !== a) bound.push([i + 1, j, i + 1, j + 1]); }
        if (j + 1 < H) { const b = st(c + W); if (b >= 0 && b !== a) bound.push([i, j + 1, i + 1, j + 1]); }
      }
    }
    this._cg2 = { key: key, acc: acc, rail: rail, bound: bound };
    return this._cg2;
  };
  Renderer.prototype.drawCoverExtras = function (ctx, ui) {
    const cg = this.coverGeom(), tmp = {}, tmp2 = {};
    const seg = (list) => { ctx.beginPath(); for (const s of list) { this.P(s[0], s[1], 0, tmp); this.P(s[2], s[3], 0, tmp2); ctx.moveTo(tmp.x, tmp.y); ctx.lineTo(tmp2.x, tmp2.y); } };
    if (cg.bound.length) { seg(cg.bound); ctx.strokeStyle = S.TH.night ? 'rgba(220,230,240,0.45)' : 'rgba(40,60,50,0.45)'; ctx.lineWidth = 1; ctx.stroke(); }
    if (cg.rail.length && this.z >= 10) { seg(cg.rail); ctx.strokeStyle = 'rgba(192,57,43,0.85)'; ctx.lineWidth = 2.2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); }
    // 选中车站：步行 15 分钟范围的外轮廓
    const sel = ui && ui.selection, model = this.game.model, acc = model.net ? model.net.acc : null;
    if (!sel || sel.kind !== 'station' || !acc) return;
    const k = model.net.C.sIndex.get(sel.id); if (k === undefined) return;
    const tr = acc.trees[k]; if (!tr) return;
    const city = this.game.city, W = city.W, H = city.H, VW = city.VW, mx = CFG.walk.maxAccessM, extra = CFG.walk.cellExtraM;
    const dv = new Map(); for (let q = 0; q < tr.verts.length; q++) dv.set(tr.verts[q], tr.dist[q]);
    const inR = function (i, j) {
      if (i < 0 || j < 0 || i >= W || j >= H) return false;
      const v0 = j * VW + i; let m = Infinity;
      for (const v of [v0, v0 + 1, v0 + VW, v0 + VW + 1]) { const d = dv.get(v); if (d !== undefined && d < m) m = d; }
      return m + extra <= mx;
    };
    const st = model.net.C.stations[k], ci = Math.floor(st.x), cj = Math.floor(st.y), edges = [];
    for (let j = cj - 7; j <= cj + 7; j++) for (let i = ci - 7; i <= ci + 7; i++) {
      if (!inR(i, j)) continue;
      if (!inR(i - 1, j)) edges.push([i, j, i, j + 1]); if (!inR(i + 1, j)) edges.push([i + 1, j, i + 1, j + 1]);
      if (!inR(i, j - 1)) edges.push([i, j, i + 1, j]); if (!inR(i, j + 1)) edges.push([i, j + 1, i + 1, j + 1]);
    }
    seg(edges); ctx.strokeStyle = S.TH.halo; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = '#14a252'; ctx.lineWidth = 2.5; ctx.stroke();
  };

  // ---------------- 地图定位高亮：片区（矩形）、区域（范围与边界）、道路（线形）、地点（圆），脉动显示数秒 ----------------
  Renderer.prototype.setHighlight = function (hl) {
    this.hl = hl ? Object.assign({ t0: this.time, dur: 7 }, hl) : null;
    if (this.hl) for (const it of this.hl.kind === 'multi' ? this.hl.items : [this.hl]) if (it.kind === 'region') this.regionMask(it.region);
  };
  // 区域范围：W×H 掩膜（填充）与边界线段（世界坐标），按区域缓存
  Renderer.prototype.regionMask = function (k) {
    const city = this.game.city, W = city.W, H = city.H;
    this._rm = this._rm || {};
    const key = k + ':' + city.version;
    if (this._rm[key]) return this._rm[key];
    const cv = makeCanvas(W, H), c2 = cv.getContext('2d'), img = c2.createImageData(W, H), d = img.data, edges = [];
    const inR = function (i, j) { return i >= 0 && j >= 0 && i < W && j < H && city.region[j * W + i] === k && city.landFrac[j * W + i] >= 0.3; };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!inR(i, j)) continue;
      const o = (j * W + i) * 4; d[o] = 47; d[o + 1] = 111; d[o + 2] = 168; d[o + 3] = 255;
      if (!inR(i - 1, j)) edges.push([i, j, i, j + 1]); if (!inR(i + 1, j)) edges.push([i + 1, j, i + 1, j + 1]);
      if (!inR(i, j - 1)) edges.push([i, j, i + 1, j]); if (!inR(i, j + 1)) edges.push([i, j + 1, i + 1, j + 1]);
    }
    c2.putImageData(img, 0, 0);
    this._rm[key] = { cv: cv, edges: edges };
    return this._rm[key];
  };
  // 高亮：kind 为 rect / circle / region / road，或 multi（items 为多个高亮，各自带名称标签）；dur 为持续秒数
  Renderer.prototype.drawHighlight = function (ctx) {
    const hl = this.hl, age = this.time - hl.t0;
    if (age > hl.dur) { this.hl = null; return; }
    const fade = Math.min(1, age / 0.3) * Math.min(1, (hl.dur - age) / 0.8), pulse = 0.5 + 0.5 * Math.sin(age * 4.5);
    ctx.save();
    for (const it of hl.kind === 'multi' ? hl.items : [hl]) this.drawHighlightOne(ctx, it, age, fade, pulse);
    ctx.restore();
  };
  Renderer.prototype.drawHighlightOne = function (ctx, hl, age, fade, pulse) {
    const col = S.TH.night ? [106, 166, 230] : [30, 110, 200], tmp = {}, dpr = this.dpr, M = this.M, z = this.z;
    ctx.globalAlpha = fade; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = (pts, close) => { ctx.beginPath(); pts.forEach((p, i) => { this.P(p[0], p[1], 0, tmp); if (i) ctx.lineTo(tmp.x, tmp.y); else ctx.moveTo(tmp.x, tmp.y); }); if (close) ctx.closePath(); };
    const outline = (w) => { ctx.strokeStyle = S.TH.halo; ctx.lineWidth = w + 4; ctx.stroke(); ctx.strokeStyle = U.rgb(col, 0.95); ctx.lineWidth = w; ctx.stroke(); };
    if (hl.kind === 'rect' || hl.kind === 'circle') {
      const pts = [];
      if (hl.kind === 'rect') pts.push([hl.x0, hl.y0], [hl.x1, hl.y0], [hl.x1, hl.y1], [hl.x0, hl.y1]);
      else for (let a = 0; a < 48; a++) pts.push([hl.x + Math.cos(a / 48 * Math.PI * 2) * hl.r, hl.y + Math.sin(a / 48 * Math.PI * 2) * hl.r]);
      path(pts, true); ctx.fillStyle = U.rgb(col, 0.12 + 0.1 * pulse); ctx.fill();
      ctx.setLineDash([10, 6]); ctx.lineDashOffset = -age * 20; outline(3); ctx.setLineDash([]);
    } else if (hl.kind === 'region') {
      const rm = this.regionMask(hl.region);
      ctx.save(); ctx.setTransform(dpr * M[0] * z, dpr * M[2] * z, dpr * M[1] * z, dpr * M[3] * z, dpr * this.px, dpr * this.py);
      ctx.globalAlpha = fade * (0.16 + 0.1 * pulse); ctx.imageSmoothingEnabled = false; ctx.drawImage(rm.cv, 0, 0, rm.cv.width, rm.cv.height); ctx.restore();
      ctx.beginPath();
      for (const e of rm.edges) { this.P(e[0], e[1], 0, tmp); ctx.moveTo(tmp.x, tmp.y); this.P(e[2], e[3], 0, tmp); ctx.lineTo(tmp.x, tmp.y); }
      outline(2.5);
    } else if (hl.kind === 'road') {
      ctx.beginPath();
      for (const p of hl.ways) for (let q = 0; q < p.length; q += 2) { this.P(p[q], p[q + 1], 0, tmp); if (q) ctx.lineTo(tmp.x, tmp.y); else ctx.moveTo(tmp.x, tmp.y); }
      ctx.strokeStyle = U.rgb(col, 0.25 + 0.2 * pulse); ctx.lineWidth = 14; ctx.stroke();
      outline(4);
    }
    // 名称标签
    if (hl.label) {
      const p = this.P(hl.lx, hl.ly, 0), qx = this.snapPx(p.x), qy = this.snapPx(p.y);
      ctx.font = '700 13px ' + FONT; const w = ctx.measureText(hl.label).width + 22, x = qx - w / 2, y = qy - 44;
      ctx.fillStyle = U.rgb(col, 0.96); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, 26, 13) : ctx.rect(x, y, w, 26); ctx.fill();
      ctx.beginPath(); ctx.moveTo(qx - 6, y + 26); ctx.lineTo(qx + 6, y + 26); ctx.lineTo(qx, y + 33); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(hl.label, qx, this.snapPx(y + 13.5));
    }
  };
})(window.CM);
