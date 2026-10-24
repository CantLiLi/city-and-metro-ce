'use strict';
// 等距建筑：分块几何、棱柱与棱锥等绘图辅助、城市风貌配色、树木与山峰、地标精细模型
(function (CM) {
  const LU = CM.LU, D = CM.DATA, U = CM.U, CFG = CM.CFG;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;
  const ISO = [0.70710678, -0.70710678, 0.35355339, 0.35355339], HSF = 0.82, EX = 2.0 / CFG.CELL_M, MAX_H = 5.0, CHUNK_PX = 512;

  // ---------------- 等距建筑分块 ----------------
  Renderer.prototype.isoChunkGeom = function (lvl, ci, cj) {
    const C = CHUNK_PX / lvl / 1.41421356 | 0 || 1;
    return C;
  };
  Renderer.prototype.renderIsoChunk = function (lvl, ci, cj, C) {
    const gen = this.isoChunkGen(lvl, ci, cj, C);
    for (;;) { const r = gen.next(); if (r.done) return r.value; }
  };
  Renderer.prototype.isoChunkGen = function* (lvl, ci, cj, C) {
    const city = this.game.city, W = city.W, H = city.H;
    const i0 = ci * C, j0 = cj * C;
    const Q = this.modelQo();
    const s = lvl, coarse = s < Q.coarseLvl;
    const treeN = Q.treeN;
    let waterOnly = true;
    for (let j = j0; j < Math.min(H, j0 + C) && waterOnly; j++) for (let i = i0; i < Math.min(W, i0 + C); i++) {
      const L = city.lu[j * W + i]; if (L !== LU.WATER && L !== LU.LANDMARK) { waterOnly = false; break; }
    }
    if (waterOnly) return { cv: makeCanvas(1, 1), ax: 0, ay: 0, px: 1, empty: true };
    let hasHill = false;
    for (let j = j0; j < Math.min(H, j0 + C) && !hasHill; j++) for (let i = i0; i < Math.min(W, i0 + C); i++) if (city.lu[j * W + i] === LU.HILL) { hasHill = true; break; }
    const pad = hasHill ? 2.8 * s : 4;   // 山峰会越出所在格
    const minX = (i0 - (j0 + C)) * ISO[0] * s - pad, maxX = ((i0 + C) - j0) * ISO[0] * s + pad;
    const minY = (i0 + j0) * ISO[2] * s - MAX_H * HSF * s - pad, maxY = (i0 + j0 + 2 * C) * ISO[2] * s + pad;
    const cv = makeCanvas(maxX - minX, maxY - minY), ctx = cv.getContext('2d');
    const ox = -minX, oy = -minY;
    const pj = function (x, y, h) { return [(x - y) * ISO[0] * s + ox, (x + y) * ISO[2] * s + oy - h * HSF * s]; };
    let drew = 0;
    const progress = { cv: cv };
    for (let sum = i0 + j0; sum <= i0 + j0 + 2 * C - 2; sum++) {
      if (sum > i0 + j0) yield progress;
      for (let i = Math.max(i0, sum - (j0 + C - 1)); i <= Math.min(i0 + C - 1, sum - j0); i++) {
        const j = sum - i;
        if (i >= W || j >= H || i < 0 || j < 0) continue;
        const c = j * W + i, L = city.lu[c];
        if (L === LU.WATER || L === LU.LANDMARK) continue;
        if (L === LU.HILL) { drew += this.isoPeak(ctx, pj, c, i, j, s); continue; }
        if (L === LU.PARK || (city.wood[c] > 0.5 && !city.street[c])) { drew += this.isoTrees(ctx, pj, c, i, j, coarse ? 1 : treeN, s); continue; }
        if (L === LU.RURAL && !city.street[c] && city.pop[c] < 12) { if (U.hash2(c, 1, 77) < 0.2) drew += this.isoTrees(ctx, pj, c, i, j, 1, s); }
        if (this.isLmCenter(c)) continue;
        const bl = this.cellBuildings(c, coarse);
        if (!bl) continue;
        for (let k = 0; k < bl.length; k++) { this.isoBox(ctx, pj, i, j, bl[k], c, k, s); drew++; }
      }
    }
    if (!drew) cv.width = cv.height = 1;
    return { cv: cv, ax: (i0 - j0) * ISO[0] * s + ox, ay: (i0 + j0) * ISO[2] * s + oy, px: cv.width * cv.height, empty: drew === 0 };
  };
  // 已建成地标中心所在的格不再放普通建筑（由地标模型占用）
  Renderer.prototype.isLmCenter = function (c) {
    const city = this.game.city;
    if (!this._lmc || this._lmcCity !== city) { this._lmcCity = city; this._lmc = new Map(); D.landmarks.forEach((lm, k) => this._lmc.set(city.cellAt(lm.x, lm.y), k)); }
    const k = this._lmc.get(c);
    return k !== undefined && city.landmarkOn[k] === 1;
  };
  // 地标精灵：每个地标按缩放级别单独缓存（大型场地不受分块裁切），在其中心所在分块之后绘制
  Renderer.prototype.landmarkSprite = function (k, lvl) {
    const key = 'L' + lvl + ':' + k;
    let e = this.iso.get(key);
    if (e && !e.stale) { e.used = this.frame; return e; }
    const lm = D.landmarks[k], s = lvl;
    const R = Math.hypot(lm.w, lm.d) / 2 / CFG.CELL_M + 0.15;
    const tall = lm.kind === 'tvtower' || lm.kind === 'skyscraper' || lm.kind === 'lattice';
    const hMax = (lm.h || (lm.kind === 'pagoda' ? 70 : (lm.kind === 'church' ? 62 : 55))) * EX * (tall ? 1.05 : 1.6) + 0.05;
    const xs = [lm.x - R, lm.x + R], ys = [lm.y - R, lm.y + R];
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const x of xs) for (const y of ys) { const px = (x - y) * ISO[0] * s, py = (x + y) * ISO[2] * s; minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    minY -= hMax * HSF * s;
    const padd = 6, cv = makeCanvas(maxX - minX + 2 * padd, maxY - minY + 2 * padd), ctx = cv.getContext('2d');
    const ox = -minX + padd, oy = -minY + padd;
    const pj = function (x, y, h) { return [(x - y) * ISO[0] * s + ox, (x + y) * ISO[2] * s + oy - h * HSF * s]; };
    try { this.isoLandmark(ctx, pj, lm, s); } catch (err) { console.error(err); }
    e = { cv: cv, ax: (lm.x - lm.y) * ISO[0] * s + ox, ay: (lm.x + lm.y) * ISO[2] * s + oy, px: cv.width * cv.height, used: this.frame, born: this.time, stale: false };
    const old = this.iso.get(key);
    if (old) { this.cachePx -= old.px; if (old.cv !== cv) old.cv.width = old.cv.height = 1; }
    this.iso.set(key, e); this.cachePx += e.px;
    return e;
  };
  // ---------- 等距几何辅助：任意凸多边形棱柱、棱锥、椭圆 ----------
  function polyRect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  function fillPts(ctx, pts, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fill(); }
  // 棱柱：底面多边形（世界坐标，任意方向），高度 h0→h1（世界单位）；可见侧面按远近排序并按朝向着色
  function prism(ctx, pj, pts, h0, h1, wall, top, opt) {
    opt = opt || {};
    const n = pts.length;
    let area = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const sgn = area > 0 ? 1 : -1;
    const faces = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const nx = sgn * ey, ny = -sgn * ex, nl = Math.hypot(nx, ny) || 1;
      const vx = nx / nl, vy = ny / nl;
      if (vx + vy <= 0.001) continue;
      faces.push({ a: a, b: b, d: a[0] + a[1] + b[0] + b[1], f: 0.72 + 0.17 * Math.max(0, vx) - 0.04 * Math.max(0, vy) });
    }
    faces.sort(function (p, q) { return p.d - q.d; });
    for (const fc of faces) {
      const q = [pj(fc.a[0], fc.a[1], h0), pj(fc.b[0], fc.b[1], h0), pj(fc.b[0], fc.b[1], h1), pj(fc.a[0], fc.a[1], h1)];
      fillPts(ctx, q, U.rgb(U.shade(wall, fc.f)));
      if (opt.lines) { opt.lines(fc, q); }
    }
    if (top) fillPts(ctx, pts.map(function (p) { return pj(p[0], p[1], h1); }), U.rgb(top));
    return faces;
  }
  // 棱锥 / 坡顶：多边形底边 h0 收向顶点 (cx,cy,h1)
  function pyramidN(ctx, pj, pts, cx, cy, h0, h1, col) {
    const n = pts.length, tip = pj(cx, cy, h1);
    const faces = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy;
      faces.push({ a: a, b: b, d: mx + my, f: 0.78 + 0.16 * (mx > 0 ? 1 : 0) + 0.08 * (my > 0 ? -1 : 0) });
    }
    faces.sort(function (p, q) { return p.d - q.d; });
    for (const fc of faces) fillPts(ctx, [pj(fc.a[0], fc.a[1], h0), pj(fc.b[0], fc.b[1], h0), tip], U.rgb(U.shade(col, fc.f)));
  }

  // ---------------- 城市风貌（v2.0）：建筑年代与地区风格 ----------------
  // 普通建筑程序生成：按「建成年代」（只用于外观，见 bldVintage）分为传统低层、战前砖石、混凝土板楼、面砖塔楼与玻璃幕墙；
  // 传统低层按地区区分（内地灰砖坡顶、香港唐楼、台北街屋、东京木造坡顶）。商业区按年代出现招牌与霓虹。外观按 5 年一档更新。
  // 配色保持原有浅色、克制的「云雾淡彩」风格：年代与地区只体现在形体（坡顶、窗带、竖条）和极轻的色调差异上
  const STYLE_PAL = {
    old: { cn: [[226, 229, 233], [219, 223, 229], [231, 232, 234]], hk: [[236, 234, 228], [228, 235, 233], [236, 231, 230], [229, 231, 238]], jp: [[234, 231, 225], [227, 226, 222], [237, 234, 228]], tw: [[229, 232, 236], [222, 227, 233], [232, 232, 231]] },
    roof: { cn: [184, 194, 208], hk: null, jp: [176, 187, 202], tw: null },
    masonry: [[233, 229, 220], [227, 224, 216], [236, 233, 226]],
    slab: [[232, 235, 239], [226, 231, 237], [236, 238, 240], [222, 228, 236]],
    tile: [[236, 240, 245], [228, 235, 243], [240, 242, 245]],
  };
  const NEON_YEAR = { cn: 1992, hk: 1960, jp: 1955, tw: 1975 };
  const NEON_COL = ['#ff4fa3', '#36e0ff', '#ffd23f', '#7cff6b', '#ff6a3d', '#b98cff'];
  const REGION_KEY = { '中国内地': 'cn', '中国香港': 'hk', '中国台湾': 'tw', '日本': 'jp' };
  function nightCol(c) { return [c[0] * 0.24 + 8, c[1] * 0.26 + 12, c[2] * 0.28 + 24]; }   // 与原夜景楼宇同一深度
  Renderer.prototype.regionKey = function () { const m = CM.curMap ? CM.curMap() : null; return (m && REGION_KEY[m.region]) || 'cn'; };
  // 建筑年代（只用于外观，不影响模拟）：开局前已是城区的街区分散在开局前约 6–50 年；之后城市化的街区按城市化年份；
  // 较高的建筑只会出现在允许该高度的年代之后；建成 30 年以上的建筑逐步翻新（外观换新、高度不变）。
  Renderer.prototype.bldVintage = function (c, k, h) {
    const city = this.game.city, y0 = CFG.START.y, Y = this.styleYear || y0, uy = city.urbanYear[c];
    let v = uy > y0 ? uy + 3 * U.hash2(c, k, 17) : y0 - 6 - 44 * U.hash2(c, k, 17);
    const minY = h > 100 ? 2003 : h > 60 ? 1992 : h > 32 ? 1972 : -1e9;
    if (v < minY) v = minY + 8 * U.hash2(c, k, 18);
    const age = Y - v;
    if (age > 30 && U.hash2(c, k, 19) < (age - 30) / 50) v = Y - 25 * U.hash2(c, k, 20);
    return Math.min(v, Y);
  };
  Renderer.prototype.bldStyle = function (c, k, h) {
    const v = this.bldVintage(c, k, h);
    if (v < 1960) return h <= 24 ? 'old' : 'masonry';
    if (v < 1990) return 'slab';
    if (v < 2005) return 'tile';
    return 'glass';
  };
  // 平面图（2D）中的建筑颜色：与 2.5D 同一风格，坡屋顶建筑显示屋面颜色
  Renderer.prototype.bldTopColor = function (c, k, b) {
    const st = this.bldStyle(c, k, b[4]), rk = this._rk || (this._rk = this.regionKey());
    if (st === 'glass') { const pal = S.PAL[b[5]] || S.PAL[0]; return pal[Math.floor(U.hash2(c, k, 4) * pal.length)]; }
    let col;
    if (st === 'old' && b[4] <= 20 && STYLE_PAL.roof[rk]) col = U.mixc(STYLE_PAL.roof[rk], [226, 231, 237], 0.35);
    else { const P = st === 'old' ? (STYLE_PAL.old[rk] || STYLE_PAL.old.cn) : STYLE_PAL[st]; col = P[Math.floor(U.hash2(c, k, 4) * P.length)]; }
    return S.TH.night ? nightCol(col) : col;
  };
  // 坡屋顶：屋脊沿较长的一边；先画背坡，再画山墙与前坡
  function pitchedRoof(ctx, pj, A, B, C, D, h, wall, col) {
    const w = B[0] - A[0], d = D[1] - A[1], rh = Math.min(h * 0.55, Math.min(w, d) * 0.5);
    const At = pj(A[0], A[1], h), Bt = pj(B[0], B[1], h), Ct = pj(C[0], C[1], h), Dt = pj(D[0], D[1], h);
    if (w >= d) {
      const ym = (A[1] + D[1]) / 2, R0 = pj(A[0], ym, h + rh), R1 = pj(B[0], ym, h + rh);
      fillPts(ctx, [At, Bt, R1, R0], U.rgb(U.shade(col, 0.78)));
      fillPts(ctx, [Bt, Ct, R1], U.rgb(U.shade(wall, 0.95)));
      fillPts(ctx, [Dt, Ct, R1, R0], U.rgb(col));
    } else {
      const xm = (A[0] + B[0]) / 2, R0 = pj(xm, A[1], h + rh), R1 = pj(xm, D[1], h + rh);
      fillPts(ctx, [At, Dt, R1, R0], U.rgb(U.shade(col, 0.78)));
      fillPts(ctx, [Dt, Ct, R1], U.rgb(U.shade(wall, 0.84)));
      fillPts(ctx, [Bt, Ct, R1, R0], U.rgb(U.shade(col, 1.08)));
    }
  }
  // 立面上的一条水平线（两个可见立面）
  function faceBand(ctx, pj, B, C, D, hh) {
    const p0 = pj(D[0], D[1], hh), p1 = pj(C[0], C[1], hh), p2 = pj(B[0], B[1], hh);
    ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
  }
  // 建筑体量：两个立面 + 顶面（或坡屋顶）；按年代风格加窗带、玻璃竖条、檐口；高楼带高光；夜间少量暖色窗光与商业霓虹
  Renderer.prototype.isoBox = function (ctx, pj, i, j, b, c, k, s) {
    const h = b[4] * EX, mh = b[4];
    const A = [i + b[0], j + b[1]], B = [i + b[2], j + b[1]], C = [i + b[2], j + b[3]], Dd = [i + b[0], j + b[3]];
    const Bb = pj(B[0], B[1], 0), Cb = pj(C[0], C[1], 0), Db = pj(Dd[0], Dd[1], 0);
    const At = pj(A[0], A[1], h), Bt = pj(B[0], B[1], h), Ct = pj(C[0], C[1], h), Dt = pj(Dd[0], Dd[1], h);
    const st = this.bldStyle(c, k, mh), rk = this._rk || (this._rk = this.regionKey());
    let base;
    if (st === 'glass') { const pal = S.PAL[b[5]] || S.PAL[0]; base = pal[Math.floor(U.hash2(c, k, 4) * pal.length)]; }
    else { const P = st === 'old' ? (STYLE_PAL.old[rk] || STYLE_PAL.old.cn) : STYLE_PAL[st]; base = P[Math.floor(U.hash2(c, k, 4) * P.length)]; if (S.TH.night) base = nightCol(base); }
    const tall = b[4] > 40;
    if (s >= 16 && this.shadows) {
      const so = Math.min(1.0, h * 0.45);
      const Cs = pj(C[0] + so, C[1] - so * 0.2, 0), Bs = pj(B[0] + so, B[1] - so * 0.2, 0);
      fillPts(ctx, [Bb, Bs, Cs, Cb], S.TH.isoShadow);
    }
    if (st === 'glass' && tall && s >= 16) {
      const gS = ctx.createLinearGradient(0, Dt[1], 0, Db[1]);
      gS.addColorStop(0, U.rgb(U.shade(base, S.TH.night ? 0.9 : 0.97))); gS.addColorStop(1, U.rgb(U.shade(base, S.TH.night ? 0.62 : 0.8)));
      const gE = ctx.createLinearGradient(0, Bt[1], 0, Bb[1]);
      gE.addColorStop(0, U.rgb(U.shade(base, S.TH.night ? 1.05 : 1.08))); gE.addColorStop(1, U.rgb(U.shade(base, S.TH.night ? 0.75 : 0.9)));
      fillPts(ctx, [Db, Cb, Ct, Dt], gS); fillPts(ctx, [Bb, Cb, Ct, Bt], gE);
      ctx.strokeStyle = S.TH.night ? 'rgba(170,200,240,0.25)' : 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Ct[0], Ct[1] + 1); ctx.lineTo(Cb[0], Cb[1]); ctx.stroke();
    } else {
      fillPts(ctx, [Db, Cb, Ct, Dt], U.rgb(U.shade(base, 0.82)));
      fillPts(ctx, [Bb, Cb, Ct, Bt], U.rgb(U.shade(base, 0.93)));
    }
    const roof = st === 'old' && mh <= 20 && STYLE_PAL.roof[rk];
    if (roof) pitchedRoof(ctx, pj, A, B, C, Dd, h, base, S.TH.night ? nightCol(roof) : roof);
    else fillPts(ctx, [At, Bt, Ct, Dt], U.rgb(U.shade(base, S.TH.night ? 1.12 : 1.07)));
    // 立面细节（近景）：板楼与砖石楼的水平窗带、面砖塔楼的玻璃竖条、砖石楼檐口、街屋屋顶加建
    if (s >= 32 && mh >= 9) {
      if (st === 'slab' || st === 'masonry') {
        const rows = Math.min(6, Math.floor(mh / 9));
        ctx.strokeStyle = S.TH.night ? 'rgba(255,214,140,0.22)' : 'rgba(110,132,165,0.16)'; ctx.lineWidth = 1;
        ctx.beginPath(); for (let r = 1; r <= rows; r++) faceBand(ctx, pj, B, C, Dd, h * r / (rows + 1)); ctx.stroke();
        if (st === 'masonry') { ctx.strokeStyle = U.rgb(U.shade(base, 0.86)); ctx.lineWidth = 1.5; ctx.beginPath(); faceBand(ctx, pj, B, C, Dd, h * 0.94); ctx.stroke(); }
      } else if (st === 'tile') {
        const glass = S.TH.night ? [52, 82, 120] : [184, 206, 230];
        for (const f of [[Dd, C], [B, C]]) {
          const a = f[0], e = f[1], p = function (t, hh) { return pj(a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t, hh); };
          fillPts(ctx, [p(0.4, h * 0.06), p(0.6, h * 0.06), p(0.6, h * 0.96), p(0.4, h * 0.96)], U.rgb(glass));
        }
      } else if (st === 'old' && !roof && rk === 'tw' && U.hash2(c, k, 31) < 0.6) {
        // 台北街屋顶楼的铁皮加盖
        const sh = h * 0.18, m = function (u, v) { return [A[0] + (B[0] - A[0]) * u, A[1] + (Dd[1] - A[1]) * v]; };
        const q0 = m(0.2, 0.2), q1 = m(0.8, 0.2), q2 = m(0.8, 0.8), q3 = m(0.2, 0.8);
        fillPts(ctx, [pj(q3[0], q3[1], h), pj(q2[0], q2[1], h), pj(q2[0], q2[1], h + sh), pj(q3[0], q3[1], h + sh)], S.TH.night ? '#24344a' : '#c9d5e3');
        fillPts(ctx, [pj(q1[0], q1[1], h), pj(q2[0], q2[1], h), pj(q2[0], q2[1], h + sh), pj(q1[0], q1[1], h + sh)], S.TH.night ? '#1d2b3d' : '#bccadb');
        fillPts(ctx, [pj(q0[0], q0[1], h + sh), pj(q1[0], q1[1], h + sh), pj(q2[0], q2[1], h + sh), pj(q3[0], q3[1], h + sh)], S.TH.night ? '#2c3e56' : '#d6dfea');
      }
    }
    // 商业招牌：按地区年代出现。夜间为霓虹（老式楼宇为竖向招牌），白天高楼屋顶有广告牌
    if (b[5] === LU.COM && mh >= 15 && s >= 16 && (this.styleYear || 0) >= NEON_YEAR[rk] && U.hash2(c, k, 33) < 0.7) {
      const col = NEON_COL[Math.floor(U.hash2(c, k, 34) * NEON_COL.length)];
      const p = function (t, hh) { return pj(Dd[0] + (C[0] - Dd[0]) * t, Dd[1] + (C[1] - Dd[1]) * t, hh); };
      if (S.TH.night) {
        ctx.globalAlpha = 0.92;
        if (st === 'old' || st === 'masonry' || st === 'slab') fillPts(ctx, [p(0.12, h * 0.3), p(0.2, h * 0.3), p(0.2, h * 0.9), p(0.12, h * 0.9)], col);
        else fillPts(ctx, [p(0.2, h * 0.86), p(0.8, h * 0.86), p(0.8, h * 0.92), p(0.2, h * 0.92)], col);
        ctx.globalAlpha = 1;
      } else if (s >= 32 && mh >= 30 && st !== 'old') {
        const bh = Math.min(0.12, h * 0.12);
        ctx.globalAlpha = 0.35; fillPts(ctx, [p(0.25, h), p(0.75, h), p(0.75, h + bh), p(0.25, h + bh)], col); ctx.globalAlpha = 1;
      }
    }
    // 夜景：少量亮窗（传统低层更少）
    if (S.TH.night && s >= 16 && b[4] >= 10) {
      const rows = Math.min(7, Math.floor(b[4] / 14) + 1), lit = st === 'old' ? 0.3 : 0.45;
      ctx.fillStyle = 'rgba(255,214,140,0.85)';
      for (let r = 0; r < rows; r++) for (let q = 0; q < 2; q++) {
        if (U.hash2(c * 7 + k, r * 3 + q, 13) > lit) continue;
        const t = 0.3 + q * 0.4, hh = (r + 0.6) / rows * h;
        const fx = Dd[0] + (C[0] - Dd[0]) * t, fy = Dd[1] + (C[1] - Dd[1]) * t, p = pj(fx, fy, hh);
        ctx.fillRect(p[0] - 1, p[1] - 0.8, 2, 1.6);
      }
    }
  };
  // 圆冠树
  Renderer.prototype.isoTrees = function (ctx, pj, c, i, j, n, s) {
    let cnt = 0;
    const T = S.TH.tree[0];
    for (let k = 0; k < n; k++) {
      const x = i + 0.15 + U.hash2(c, k, 61) * 0.7, y = j + 0.15 + U.hash2(c, k, 62) * 0.7;
      const r = (0.07 + U.hash2(c, k, 63) * 0.05) * s * 0.85;
      const t = pj(x, y, 0.07 + U.hash2(c, k, 64) * 0.04);
      const v = 0.92 + U.hash2(c, k, 65) * 0.16;
      ctx.fillStyle = U.rgb(U.shade(T, v * 0.86)); ctx.beginPath(); ctx.arc(t[0], t[1], Math.max(1, r), 0, Math.PI * 2); ctx.fill();
      if (s >= 16) { ctx.fillStyle = U.rgb(U.shade(T, v * 1.12)); ctx.beginPath(); ctx.arc(t[0] - r * 0.25, t[1] - r * 0.3, r * 0.55, 0, Math.PI * 2); ctx.fill(); }
      cnt++;
    }
    return cnt;
  };
  // 山体深度（到山区边缘的格数），用于山峰高度
  Renderer.prototype.hillDepth = function () {
    const city = this.game.city;
    if (this._hd && this._hdCity === city) return this._hd;
    const W = city.W, H = city.H, N = city.N, d = new Float32Array(N).fill(1e9), q = [];
    for (let c = 0; c < N; c++) if (city.lu[c] !== LU.HILL) { d[c] = 0; q.push(c); }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], i = c % W, j = (c / W) | 0;
      for (const o of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + o[0], jj = j + o[1]; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue; const n2 = jj * W + ii; if (d[n2] > d[c] + 1) { d[n2] = d[c] + 1; q.push(n2); } }
    }
    this._hd = d; this._hdCity = city;
    return d;
  };
  // 水墨山峰：渐变填充的山形剪影，山脚融入雾中
  Renderer.prototype.isoPeak = function (ctx, pj, c, i, j, s) {
    const depth = this.hillDepth()[c], pk = S.TH.peak;
    const m = Math.min(1, depth / 5);
    if (U.hash2(c, 3, 41) > 0.16 + 0.12 * m) return 0;
    const cx = i + 0.2 + U.hash2(c, 1, 42) * 0.6, cy = j + 0.2 + U.hash2(c, 2, 43) * 0.6;
    const hm = (60 + 320 * m) * (0.55 + 0.75 * U.hash2(c, 4, 44));
    const r = (1.1 + 1.5 * m + U.hash2(c, 5, 45) * 0.7) * s;
    const P0 = pj(cx, cy, 0), A0 = pj(cx, cy, hm * EX * 0.6), A = [A0[0] + (U.hash2(c, 8, 47) - 0.5) * r * 0.5, A0[1]];
    const by = P0[1] + r * 0.18;
    const g = ctx.createLinearGradient(0, A[1], 0, by);
    g.addColorStop(0, U.rgb(pk.top, 0.95)); g.addColorStop(0.5, U.rgb(U.mixc(pk.top, pk.base, 0.55), 0.8)); g.addColorStop(1, U.rgb(pk.base, 0));
    const jit = function (k) { return (U.hash2(c, k, 46) - 0.5); };
    const pts = [[P0[0] - r, by]];
    for (let k = 1; k <= 3; k++) { const t = k / 4; pts.push([P0[0] - r + (A[0] - P0[0] + r) * t + jit(k) * r * 0.22, by + (A[1] - by) * Math.pow(t, 0.8) + jit(k + 5) * r * 0.16]); }
    pts.push([A[0], A[1]]);
    for (let k = 1; k <= 3; k++) { const t = k / 4; pts.push([A[0] + (P0[0] + r - A[0]) * t + jit(k + 10) * r * 0.22, A[1] + (by - A[1]) * Math.pow(t, 1.25) + jit(k + 15) * r * 0.16]); }
    pts.push([P0[0] + r, by]);
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.quadraticCurveTo(P0[0], by + r * 0.12, pts[0][0], pts[0][1]); ctx.fill();
    // 背光面
    if (s >= 14) {
      const g2 = ctx.createLinearGradient(0, A[1], 0, by);
      g2.addColorStop(0, U.rgb(U.shade(pk.top, 0.72), 0.55)); g2.addColorStop(1, U.rgb(pk.top, 0));
      ctx.fillStyle = g2; ctx.beginPath(); ctx.moveTo(A[0], A[1]);
      for (let k = 5; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.lineTo(P0[0] + r * 0.15, by); ctx.closePath(); ctx.fill();
    }
    if (s >= 16) { ctx.strokeStyle = pk.ridge; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pts[1][0], pts[1][1]); for (let k = 2; k <= 4; k++) ctx.lineTo(pts[k][0], pts[k][1]); ctx.stroke(); }
    // 山脚云雾
    if (s >= 10) {
      const mg = ctx.createRadialGradient(P0[0], by - r * 0.05, 0, P0[0], by - r * 0.05, r * 1.1);
      mg.addColorStop(0, U.rgb(S.TH.fog, 0.55)); mg.addColorStop(1, U.rgb(S.TH.fog, 0));
      ctx.fillStyle = mg; ctx.beginPath(); ctx.ellipse(P0[0], by - r * 0.05, r * 1.1, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    }
    return 1;
  };

  // 截锥（两环之间的侧面 + 顶面），用于层檐、穹顶与塔身收分
  function frustumRings(ctx, pj, b, t, h0, h1, col, cx, cy, noTop) {
    const n = b.length, faces = [];
    let rmax = 0; for (const p of b) rmax = Math.max(rmax, Math.hypot(p[0] - cx, p[1] - cy));
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; const mx = (b[i][0] + b[j][0]) / 2 - cx, my = (b[i][1] + b[j][1]) / 2 - cy; faces.push({ i: i, j: j, d: mx + my, f: 0.74 + 0.2 * U.clamp((mx - my * 0.3) / (rmax || 1), 0, 1) }); }
    faces.sort(function (p, q) { return p.d - q.d; });
    for (const fc of faces) fillPts(ctx, [pj(b[fc.i][0], b[fc.i][1], h0), pj(b[fc.j][0], b[fc.j][1], h0), pj(t[fc.j][0], t[fc.j][1], h1), pj(t[fc.i][0], t[fc.i][1], h1)], U.rgb(U.shade(col, fc.f)));
    if (!noTop) fillPts(ctx, t.map(function (p) { return pj(p[0], p[1], h1); }), U.rgb(U.shade(col, 1.06)));
  }

  // 地标精细模型：局部坐标为米（u 向东、v 向南，绕场地中心旋转 rot 度），高度为米
  Renderer.prototype.isoLandmark = function (ctx, pj, lm, s) {
    const N = S.TH.night, CMM = CFG.CELL_M, kind = lm.kind, detail = true;
    const ang = (lm.rot || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const T = function (u, v) { return [lm.x + (u * ca - v * sa) / CMM, lm.y + (u * sa + v * ca) / CMM]; };
    const tall = kind === 'tvtower' || kind === 'skyscraper' || kind === 'lattice';
    const E = EX * (tall ? 1 : 1.6);
    const hw = lm.w / 2, hd = lm.d / 2;
    const Rc = function (u0, v0, u1, v1) { return [T(u0, v0), T(u1, v0), T(u1, v1), T(u0, v1)]; };
    const NG = function (cu, cv, r, n, rot, rv) { const o = []; for (let k = 0; k < n; k++) { const t = k / n * Math.PI * 2 + (rot || 0); o.push(T(cu + Math.cos(t) * r, cv + Math.sin(t) * (rv == null ? r : rv))); } return o; };
    const box = function (u0, v0, u1, v1, h0, h1, wall, top, opt) { return prism(ctx, pj, Rc(u0, v0, u1, v1), h0 * E, h1 * E, wall, top === undefined ? U.shade(wall, 1.08) : top, opt); };
    const poly = function (pts, h0, h1, wall, top, opt) { return prism(ctx, pj, pts, h0 * E, h1 * E, wall, top === undefined ? U.shade(wall, 1.06) : top, opt); };
    const cyl = function (cu, cv, r, n, h0, h1, wall, top, rot, rv) { return poly(NG(cu, cv, r, n, rot, rv), h0, h1, wall, top); };
    const hip = function (u0, v0, u1, v1, h0, h1, col) { const c = T((u0 + u1) / 2, (v0 + v1) / 2); pyramidN(ctx, pj, Rc(u0, v0, u1, v1), c[0], c[1], h0 * E, h1 * E, col); };
    const cone = function (cu, cv, r, n, h0, h1, col, rot) { const c = T(cu, cv); pyramidN(ctx, pj, NG(cu, cv, r, n, rot), c[0], c[1], h0 * E, h1 * E, col); };
    const eaveN = function (cu, cv, r0, r1, n, h0, h1, col, rot) { const c = T(cu, cv); frustumRings(ctx, pj, NG(cu, cv, r0, n, rot), NG(cu, cv, r1, n, rot), h0 * E, h1 * E, col, c[0], c[1]); };
    const eaveR = function (u0, v0, u1, v1, over, h0, h1, col) { const c = T((u0 + u1) / 2, (v0 + v1) / 2); frustumRings(ctx, pj, Rc(u0 - over, v0 - over, u1 + over, v1 + over), Rc(u0 + over * 0.3, v0 + over * 0.3, u1 - over * 0.3, v1 - over * 0.3), h0 * E, h1 * E, col, c[0], c[1]); };
    // 两坡顶：沿 u 方向的屋脊
    const gable = function (u0, v0, u1, v1, h0, h1, col, ridge) {
      const vm = (v0 + v1) / 2, A = T(u0, vm), B = T(u1, vm);
      const RA = pj(A[0], A[1], h1 * E), RB = pj(B[0], B[1], h1 * E);
      const p = function (u, v) { const w = T(u, v); return pj(w[0], w[1], h0 * E); };
      fillPts(ctx, [p(u0, v0), p(u1, v0), RB, RA], U.rgb(U.shade(col, 0.78)));
      fillPts(ctx, [p(u0, v1), p(u1, v1), RB, RA], U.rgb(col));
      if (ridge && s >= 16) { ctx.strokeStyle = ridge; ctx.lineWidth = Math.max(1, s / 30); ctx.beginPath(); ctx.moveTo(RA[0], RA[1]); ctx.lineTo(RB[0], RB[1]); ctx.stroke(); }
    };
    const line = function (u0, v0, h0, u1, v1, h1, col, w) { const a = T(u0, v0), b = T(u1, v1), A = pj(a[0], a[1], h0 * E), B = pj(b[0], b[1], h1 * E); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); };
    const dot = function (u, v, h, r, col) { const a = T(u, v), A = pj(a[0], a[1], h * E); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(A[0], A[1], r, 0, Math.PI * 2); ctx.fill(); };
    // 夜间亮窗：立面 (u0,v0)-(u1,v1)，高度 h0-h1（米）
    const lit = function (u0, v0, u1, v1, h0, h1, rows, cols) {
      if (!N || s < 16) return;
      ctx.fillStyle = 'rgba(255,214,140,0.85)';
      for (let rr = 0; rr < rows; rr++) for (let q = 0; q < cols; q++) {
        const t = (q + 0.5) / cols, hh = h0 + (h1 - h0) * (rr + 0.5) / rows;
        const w = T(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t), p = pj(w[0], w[1], hh * E);
        ctx.fillRect(p[0] - 0.8, p[1] - 0.8, 1.6, 1.6);
      }
    };
    // 场地内的树
    const trees = function (n, seed, avoid) {
      const T0 = S.TH.tree[0], rr = Math.max(1.2, 9 / CMM * s * 0.8);
      const list = [];
      for (let k = 0; k < n; k++) {
        const u = (U.hash2(k, seed, 3) - 0.5) * lm.w * 0.92, v = (U.hash2(k, seed, 4) - 0.5) * lm.d * 0.92;
        if (avoid && avoid(u, v)) continue;
        list.push([u, v]);
      }
      list.sort(function (a, b) { const A = T(a[0], a[1]), B = T(b[0], b[1]); return (A[0] + A[1]) - (B[0] + B[1]); });
      for (const t of list) {
        const w = T(t[0], t[1]), p = pj(w[0], w[1], 12 * EX);
        const v2 = 0.85 + U.hash2(Math.round(t[0]), Math.round(t[1]), 7) * 0.3;
        ctx.fillStyle = U.rgb(U.shade(T0, v2 * 0.82)); ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2); ctx.fill();
        if (s >= 32) { ctx.fillStyle = U.rgb(U.shade(T0, v2 * 1.1)); ctx.beginPath(); ctx.arc(p[0] - rr * 0.25, p[1] - rr * 0.3, rr * 0.6, 0, Math.PI * 2); ctx.fill(); }
      }
    };
    const glass = N ? [70, 96, 130] : [176, 205, 228], white = N ? [120, 126, 140] : [242, 242, 238], stone = N ? [112, 108, 104] : [214, 206, 192];
    switch (kind) {
      case 'hall': { // 中山纪念堂：八角形宝蓝琉璃瓦大屋顶、四面抱厦
        const wall = [238, 228, 206], blue = [40, 96, 170], gold = [222, 176, 64];
        if (detail) trees(26, 11, function (u, v) { return Math.abs(u) < 70 && Math.abs(v) < 70 || (Math.abs(u) < 16 && v > 0); });
        box(-46, -46, 46, 46, 0, 3, [210, 204, 190]);
        for (const d of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const pu = d[0] * 36, pv = d[1] * 36, w = 12;
          box(pu - w, pv - w, pu + w, pv + w, 3, 15, wall, null);
          hip(pu - w - 3, pv - w - 3, pu + w + 3, pv + w + 3, 15, 22, blue);
        }
        poly(NG(0, 0, 31, 8, Math.PI / 8), 3, 24, wall, null, { lines: function (fc, q) { if (s < 16) return; ctx.strokeStyle = 'rgba(176,48,40,0.85)'; ctx.lineWidth = Math.max(1, s / 40); ctx.beginPath(); for (let t = 0.2; t < 1; t += 0.3) { ctx.moveTo(q[0][0] + (q[1][0] - q[0][0]) * t, q[0][1] + (q[1][1] - q[0][1]) * t); ctx.lineTo(q[3][0] + (q[2][0] - q[3][0]) * t, q[3][1] + (q[2][1] - q[3][1]) * t); } ctx.stroke(); } });
        eaveN(0, 0, 42, 28, 8, 24, 29, blue, Math.PI / 8);
        cyl(0, 0, 23, 8, 29, 33, wall, null, Math.PI / 8);
        cone(0, 0, 31, 8, 33, 46, blue, Math.PI / 8);
        line(0, 0, 46, 0, 0, 52, U.rgb(gold), Math.max(1.5, s / 22));
        break;
      }
      case 'tower': { // 镇海楼：红砂岩台基、五层红墙绿瓦
        const red = [176, 58, 46], green = [64, 112, 92];
        box(-18, -13, 18, 13, 0, 5, [160, 112, 96]);
        for (let k = 0; k < 5; k++) {
          const w = 15 - k * 1.1, d = 10.5 - k * 0.9, h0 = 5 + k * 4.6;
          box(-w, -d, w, d, h0, h0 + 3.6, red, null);
          lit(-w, d, w, d, h0, h0 + 3.6, 1, 4);
          eaveR(-w, -d, w, d, 2.6, h0 + 3.6, h0 + 4.6, green);
        }
        hip(-11, -7, 11, 7, 28, 32, green);
        break;
      }
      case 'pagoda': { // 六榕寺：岭南灰瓦殿宇 + 八角九层花塔（57 m）
        const body = [236, 210, 160], eaveC = [168, 64, 46], tile = [98, 100, 104], wallT = [196, 186, 170];
        if (detail) trees(10, 21, function (u, v) { return u > -20; });
        for (let k = 0; k < 2; k++) { const v0 = -30 + k * 34; box(-75, v0, -25, v0 + 18, 0, 7, wallT, null); gable(-77, v0 - 2, -23, v0 + 20, 7, 11, tile, '#3aa37a'); }
        const pu = 30, pv = 0;
        cyl(pu, pv, 11, 8, 0, 2, stone, null, Math.PI / 8);
        for (let k = 0; k < 9; k++) {
          const r = 8.5 - k * 0.45, h0 = 2 + k * 6;
          cyl(pu, pv, r, 8, h0, h0 + 5, body, null, Math.PI / 8);
          lit(pu - r, pv + r * 0.7, pu + r, pv + r * 0.7, h0 + 1, h0 + 4, 1, 3);
          eaveN(pu, pv, r + 2.6, r + 0.5, 8, h0 + 5, h0 + 6, eaveC, Math.PI / 8);
        }
        line(pu, pv, 56, pu, pv, 63, '#c9a03e', Math.max(1.5, s / 20));
        break;
      }
      case 'minaret': { // 怀圣寺光塔：圆柱形光塔（36 m）与礼拜殿
        box(-38, -18, 0, 16, 0, 9, white, null); gable(-40, -20, 2, 18, 9, 13, N ? [70, 80, 90] : [120, 140, 150]);
        cyl(22, 0, 4.5, 14, 0, 33, N ? [150, 146, 138] : [226, 222, 210]);
        cone(22, 0, 4.8, 14, 33, 38, N ? [140, 130, 110] : [200, 190, 160]);
        break;
      }
      case 'temple': case 'traditional': { // 光孝寺 / 五仙观：沿中轴的殿宇；陈家祠 / 农讲所：三路三进岭南祠堂
        const wall = kind === 'temple' ? [214, 172, 96] : [196, 186, 170];
        const tile = kind === 'temple' ? [150, 92, 50] : [96, 98, 102];
        const ridgeC = kind === 'temple' ? '#d9a33a' : '#3aa37a';
        if (kind === 'temple' && lm.w > 150) {
          if (detail) trees(30, 31, function (u, v) { return Math.abs(u) < 60; });
          for (let k = 0; k < 4; k++) { const v0 = -hd + 30 + k * (lm.d - 60) / 4, w = k === 2 ? 34 : 26; box(-w, v0, w, v0 + 22, 0, 9 + (k === 2 ? 4 : 0), wall, null); gable(-w - 3, v0 - 3, w + 3, v0 + 25, 9 + (k === 2 ? 4 : 0), 15 + (k === 2 ? 6 : 0), tile, ridgeC); }
        } else {
          const rows = lm.d > 100 ? 3 : 2, cols = lm.w > 120 ? 3 : 1;
          for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
            const v0 = -hd + 6 + r * (lm.d - 12) / rows, v1 = v0 + (lm.d - 12) / rows * 0.55;
            const u0 = -hw + 6 + q * (lm.w - 12) / cols, u1 = u0 + (lm.w - 12) / cols - 6;
            box(u0, v0, u1, v1, 0, 8, wall, null);
            gable(u0 - 2, v0 - 2, u1 + 2, v1 + 2, 8, 12, tile, ridgeC);
          }
        }
        break;
      }
      case 'church': { // 石室圣心大教堂：哥特式双尖塔（58 m）
        const st = N ? [96, 96, 98] : [158, 156, 150], dark = N ? [70, 70, 74] : [112, 110, 106];
        box(-48, -15, 20, 15, 0, 22, st, null);
        gable(-50, -16, 20, 16, 22, 31, dark);
        lit(-48, 15, 20, 15, 4, 18, 2, 8);
        for (const dv of [-11, 11]) { box(20, dv - 6, 32, dv + 6, 0, 34, st, null); cone(26, dv, 7.5, 4, 34, 58, dark, Math.PI / 4); }
        box(20, -5, 30, 5, 0, 24, st, U.shade(st, 1.1));
        dot(31, 0, 15, Math.max(1.5, s / 18), N ? 'rgba(255,200,120,0.9)' : 'rgba(90,110,150,0.85)');
        break;
      }
      case 'colonial': {
        if (lm.w > 500) { // 沙面：欧式别墅街区、林荫大道与白天鹅宾馆
          const wallC = [[236, 212, 156], [232, 220, 196], [214, 190, 160], [226, 200, 170]], roofC = [170, 86, 64];
          const rowsV = [-80, 50];
          for (let r = 0; r < 2; r++) {
            for (let k = 0; k < 9; k++) {
              const u0 = -hw + 40 + k * (lm.w - 140) / 9, v0 = rowsV[r], w = 52, d = 46;
              if (r === 1 && k === 0) continue;
              const col = wallC[(k + r) % 4], h = 10 + U.hash2(k, r, 5) * 9;
              box(u0, v0, u0 + w, v0 + d, 0, h, col, null);
              lit(u0, v0 + d, u0 + w, v0 + d, 2, h - 2, 2, 5);
              hip(u0 - 2, v0 - 2, u0 + w + 2, v0 + d + 2, h, h + 4, roofC);
            }
          }
          if (detail) trees(40, 41, function (u, v) { return !((v > -30 && v < 40) || v < -90 - 10 || v > 110); });
          // 白天鹅宾馆（1983）：岛西南角的白色板楼
          box(-hw + 10, 95, -hw + 150, 140, 0, 14, white, null);
          box(-hw + 30, 100, -hw + 140, 128, 14, 100, white, U.shade(white, 1.05));
          lit(-hw + 30, 128, -hw + 140, 128, 18, 96, 12, 10);
        } else { // 黄埔军校：灰瓦合院
          const wallC = [214, 206, 188], tile = [92, 96, 100];
          if (detail) trees(18, 51, function (u, v) { return Math.abs(u) < 70 && Math.abs(v) < 70; });
          box(-60, -60, 60, -44, 0, 9, wallC, null); gable(-62, -62, 62, -42, 9, 13, tile);
          box(-60, 44, 60, 60, 0, 9, wallC, null); gable(-62, 42, 62, 62, 9, 13, tile);
          box(-60, -44, -44, 44, 0, 9, wallC, null); box(44, -44, 60, 44, 0, 9, wallC, null);
          lit(-60, 60, 60, 60, 2, 8, 2, 10);
          box(-14, 60, 14, 74, 0, 11, [236, 232, 220], null); hip(-16, 58, 16, 76, 11, 15, tile);
        }
        break;
      }
      case 'museum': { // 南越王墓博物馆：红砂岩阶梯体量与覆斗形墓室
        const st = [178, 98, 76];
        if (detail) trees(10, 61, function (u, v) { return Math.abs(u) < 60 && Math.abs(v) < 50; });
        box(-55, -40, 55, 40, 0, 10, st, U.shade(st, 1.1));
        box(-35, -26, 35, 26, 10, 18, st, U.shade(st, 1.15));
        hip(-24, -18, 24, 18, 18, 24, N ? [110, 140, 160] : [150, 196, 214]);
        break;
      }
      case 'memorial': { // 陵园：中轴大道、纪念碑与林木
        if (detail) trees(70, 71, function (u, v) { return Math.abs(u) < 34 || Math.hypot(u, v) < 60; });
        const plat = [212, 210, 204];
        box(-30, -30, 30, 30, 0, 2, plat, U.shade(plat, 1.06));
        box(-18, -18, 18, 18, 2, 4, plat, U.shade(plat, 1.06));
        box(-4, -4, 4, 4, 4, 40, [244, 244, 240], null);
        hip(-4.5, -4.5, 4.5, 4.5, 40, 45, [230, 230, 226]);
        break;
      }
      case 'stadium': { // 天河体育中心（主场 + 体育馆 + 游泳馆）/ 越秀山体育场
        const big = lm.w > 500;
        const bowl = function (cu, cv, rx, ry, H, roofOn) {
          const n = 36;
          const ringAt = function (sc) { const o = []; for (let k = 0; k < n; k++) { const t = k / n * Math.PI * 2; o.push(T(cu + Math.cos(t) * rx * sc, cv + Math.sin(t) * ry * sc)); } return o; };
          fillPts(ctx, ringAt(0.72).map(function (p) { return pj(p[0], p[1], 0); }), '#c8644a');
          fillPts(ctx, ringAt(0.6).map(function (p) { return pj(p[0], p[1], 0); }), '#79b85e');
          prism(ctx, pj, ringAt(1), 0, H * E, N ? [92, 100, 116] : [206, 210, 216], null, { lines: function (fc, q) { if (!N || s < 16) return; ctx.fillStyle = 'rgba(255,214,140,0.7)'; ctx.fillRect((q[0][0] + q[1][0]) / 2 - 1, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4 - 1, 2, 2); } });
          const top = ringAt(1).map(function (p) { return pj(p[0], p[1], H * E); }), inner = ringAt(0.76).map(function (p) { return pj(p[0], p[1], H * 0.3 * E); });
          ctx.fillStyle = N ? '#5a6474' : '#b9c0c8'; ctx.beginPath(); top.forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); inner.slice().reverse().forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill('evenodd');
          if (roofOn) {
            const rin = ringAt(0.86).map(function (p) { return pj(p[0], p[1], H * 1.12 * E); });
            ctx.fillStyle = N ? 'rgba(220,230,245,0.85)' : 'rgba(250,250,252,0.96)'; ctx.beginPath(); top.forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); rin.slice().reverse().forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill('evenodd');
          }
          if (N && s >= 16) for (const q of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { line(cu + q[0] * rx * 0.95, cv + q[1] * ry * 0.95, H, cu + q[0] * rx * 0.95, cv + q[1] * ry * 0.95, H + 18, '#9aa4b2', 1); dot(cu + q[0] * rx * 0.95, cv + q[1] * ry * 0.95, H + 18, 2.2, 'rgba(255,250,220,0.95)'); }
        };
        if (big) {
          if (detail) trees(60, 81, function (u, v) { return Math.hypot(u / 180, (v + 70) / 150) < 1.1 || (Math.abs(u + 270) < 90 && Math.abs(v - 170) < 70) || (Math.abs(u - 270) < 90 && Math.abs(v - 170) < 60); });
          bowl(0, -70, 150, 125, 30, true);
          cyl(-270, 170, 70, 20, 0, 18, N ? [96, 104, 120] : [220, 222, 226], null, 0, 52);
          eaveN(-270, 170, 74, 30, 20, 18, 30, N ? [130, 140, 160] : [196, 206, 220]);
          box(200, 125, 340, 210, 0, 16, N ? [86, 108, 128] : [196, 220, 236]);
        } else bowl(0, 0, lm.w / 2 * 0.95, lm.d / 2 * 0.95, 14, false);
        break;
      }
      case 'campus': { // 校园标志建筑（其余校舍由街区建筑生成）
        const brick = [180, 92, 70], tile = [80, 124, 98];
        if (lm.id === 'sysu') { // 怀士堂：红砖钟楼礼堂
          box(-24, -12, 24, 12, 0, 12, brick, null); hip(-26, -14, 26, 14, 12, 18, tile);
          box(-6, -20, 6, -8, 0, 26, brick, null); hip(-7, -21, 7, -7, 26, 32, tile);
          lit(-24, 12, 24, 12, 2, 10, 2, 6);
        } else if (lm.id === 'scut') { // 华工一号楼：宫殿式教学楼
          box(-40, -10, 40, 10, 0, 16, [214, 204, 180], null); hip(-43, -13, 43, 13, 16, 24, [70, 120, 96]);
          box(-12, -14, 12, 14, 0, 20, [214, 204, 180], null); hip(-14, -16, 14, 16, 20, 28, [70, 120, 96]);
          lit(-40, 10, 40, 10, 2, 14, 3, 10);
        } else { // 暨南大学：现代礼堂与校门
          box(-30, -22, 30, 22, 0, 14, white, U.shade(white, 1.04)); cyl(0, 0, 16, 16, 14, 20, N ? [110, 130, 160] : [170, 196, 222]);
          lit(-30, 22, 30, 22, 2, 12, 2, 8);
        }
        break;
      }
      case 'rail': { // 广州站：长条站房 + 中央钟楼 + 站台雨棚；广州东站：大跨度方形站房
        const body = N ? [86, 92, 104] : [226, 226, 230];
        if (lm.w > 500) {
          for (let k = 0; k < 5; k++) { const v0 = -120 + k * 34; box(-hw + 40, v0, hw - 40, v0 + 18, 6, 9, N ? [70, 76, 88] : [196, 200, 206], N ? [96, 104, 118] : [212, 216, 222]); }
          box(-170, 60, 170, 110, 0, 22, body, U.shade(body, 1.04));
          lit(-170, 110, 170, 110, 3, 20, 3, 16);
          box(-12, 64, 12, 96, 22, 52, [214, 208, 196], null);
          hip(-13, 63, 13, 97, 52, 58, [140, 60, 50]);
          dot(0, 97, 45, Math.max(1.5, s / 22), N ? '#ffe08a' : '#ffffff');
        } else {
          box(-hw + 20, -hd + 30, hw - 20, hd - 50, 0, 36, body, null);
          lit(-hw + 20, hd - 50, hw - 20, hd - 50, 4, 32, 4, 12);
          const n = 12; ctx.fillStyle = N ? 'rgba(140,170,210,0.95)' : 'rgba(176,204,232,0.98)'; ctx.beginPath();
          for (let k = 0; k <= n; k++) { const t = k / n, w = T(-hw + 20 + (lm.w - 40) * t, -hd + 30), p = pj(w[0], w[1], (36 + 10 * Math.sin(Math.PI * t)) * E); if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
          for (let k = n; k >= 0; k--) { const t = k / n, w = T(-hw + 20 + (lm.w - 40) * t, hd - 50), p = pj(w[0], w[1], (36 + 10 * Math.sin(Math.PI * t)) * E); ctx.lineTo(p[0], p[1]); }
          ctx.fill();
        }
        break;
      }
      case 'expo': { // 琶洲会展中心：三排展馆的波浪形屋面
        const n = 30;
        for (let r = 0; r < 3; r++) {
          const v0 = -hd + 70 + r * (lm.d - 140) / 3, v1 = v0 + (lm.d - 140) / 3 - 50;
          box(-hw + 60, v0, hw - 60, v1, 0, 22, N ? [70, 84, 102] : [210, 222, 232], null);
          lit(-hw + 60, v1, hw - 60, v1, 3, 18, 2, 24);
          for (let side = 0; side < 2; side++) {
            ctx.fillStyle = side ? (N ? '#8fa6c0' : '#eef3f7') : (N ? '#6e86a2' : '#cfdbe6');
            ctx.beginPath();
            const va = side ? (v0 + v1) / 2 : v0, vb = side ? v1 : (v0 + v1) / 2;
            for (let k = 0; k <= n; k++) { const t = k / n, w = T(-hw + 60 + (lm.w - 120) * t, va), p = pj(w[0], w[1], (22 + 9 * Math.abs(Math.sin(t * Math.PI * 5))) * E); if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
            for (let k = n; k >= 0; k--) { const t = k / n, w = T(-hw + 60 + (lm.w - 120) * t, vb), p = pj(w[0], w[1], (22 + 9 * Math.abs(Math.sin(t * Math.PI * 5))) * E); ctx.lineTo(p[0], p[1]); }
            ctx.fill();
          }
        }
        break;
      }
      case 'tvtower': { // 广州塔：扭转收腰的钢结构网格外筒（454 m）+ 天线桅杆（600 m）
        // 白天：中灰立柱与斜撑、深灰圆环、深灰混凝土核心筒、灰色桅杆（顶部红色航空障碍灯）；夜间：结构内嵌的彩色 LED 灯光
        const H = 454, rings = 26, nv = 24, tw = 280 / H;
        // 双曲面外筒：底部椭圆约 80 × 60 m，280 m 处收腰约 27 × 21 m，顶部约 54 × 41 m
        const radius = function (t) { const d = t - tw; return { rx: Math.sqrt(13.5 * 13.5 + 3692 * d * d), ry: Math.sqrt(10.5 * 10.5 + 2057 * d * d) }; };
        const b = pj(lm.x, lm.y, 0), top = pj(lm.x, lm.y, H * E);
        if (this.shadows) { ctx.fillStyle = S.TH.isoShadow; ctx.beginPath(); ctx.ellipse(b[0], b[1], 70 / CMM * s, 30 / CMM * s, 0, 0, Math.PI * 2); ctx.fill(); }
        cyl(0, 0, 7, 12, 0, H * 0.98, N ? [40, 38, 54] : [92, 98, 108], null, 0, 8.5);   // 椭圆核心筒约 14 × 17 m
        let col, brace, ringCol;
        if (N) {
          const gr = ctx.createLinearGradient(b[0], b[1], top[0], top[1]);
          gr.addColorStop(0, 'rgba(255,72,150,0.95)'); gr.addColorStop(0.45, 'rgba(196,92,255,0.95)'); gr.addColorStop(1, 'rgba(84,176,255,0.95)');
          col = gr; brace = gr; ringCol = 'rgba(255,214,246,0.55)';
        } else { col = 'rgba(128,135,146,0.95)'; brace = 'rgba(128,135,146,0.55)'; ringCol = 'rgba(88,95,106,0.85)'; }
        const strand = function (a0, twist, style, lw) {
          ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath();
          for (let q = 0; q <= rings; q++) {
            const t = q / rings, a = a0 + t * twist, r = radius(t);
            if (Math.cos(a) + Math.sin(a) < -0.3) { ctx.stroke(); ctx.beginPath(); continue; }
            const w = T(Math.cos(a) * r.rx, Math.sin(a) * r.ry), p = pj(w[0], w[1], H * t * E);
            if (q) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
          }
          ctx.stroke();
        };
        const lw = Math.max(1.1, s / 34);
        for (let v = 0; v < nv; v++) strand(v / nv * Math.PI * 2, Math.PI * 0.9, col, lw);          // 24 根倾斜立柱
        if (s >= 16) for (let v = 0; v < nv; v += 2) strand(v / nv * Math.PI * 2, -Math.PI * 0.55, brace, lw * 0.7); // 反向斜撑
        ctx.strokeStyle = ringCol; ctx.lineWidth = lw;
        for (let q = 1; q <= rings; q += 2) { const t = q / rings, r = radius(t); ctx.beginPath(); for (let a = -0.8; a <= 2.4; a += 0.2) { const w = T(Math.cos(a) * r.rx, Math.sin(a) * r.ry), p = pj(w[0], w[1], H * t * E); if (a > -0.8) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); } ctx.stroke(); }
        // 顶部观光层圆环
        { const r = radius(1); ctx.strokeStyle = N ? 'rgba(255,236,250,0.9)' : 'rgba(176,182,192,0.95)'; ctx.lineWidth = lw * 1.6; ctx.beginPath(); for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.25) { const w = T(Math.cos(a) * r.rx, Math.sin(a) * r.ry), p = pj(w[0], w[1], H * E); if (a > 0) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); } ctx.stroke(); }
        line(0, 0, H, 0, 0, 600, N ? '#f4dcff' : '#8e949c', Math.max(1.2, s / 26));
        line(0, 0, 540, 0, 0, 600, N ? '#ffffff' : '#a6acb4', Math.max(0.8, s / 40));
        dot(0, 0, 600, Math.max(1.2, s / (N ? 24 : 34)), N ? '#ff4d6d' : '#e0403a');
        break;
      }
      case 'lattice': { // 钢结构电波塔：东京塔（国际橙/白相间桁架）与东京晴空塔（三角底座渐变为圆形的白色桁架）
        const b = pj(lm.x, lm.y, 0);
        if (this.shadows) { ctx.fillStyle = S.TH.isoShadow; ctx.beginPath(); ctx.ellipse(b[0], b[1], 60 / CMM * s, 26 / CMM * s, 0, 0, Math.PI * 2); ctx.fill(); }
        const lw = Math.max(0.8, s / 40);
        // 正对观察者的立面：世界方向 (1,1)
        const front = function (u, v) { return (u * ca - v * sa) + (u * sa + v * ca) > -0.1; };
        if (lm.style === 'skytree') {
          const H = 634, f0 = -Math.PI / 2, n = 18;
          const R = function (h) { return 17 + 22 * Math.pow(Math.max(0, 1 - h / 350), 1.6); };
          const ring = function (h) {
            const f = U.clamp(h / 300, 0, 1), sm = f * f * (3 - 2 * f), r = R(h), o = [];
            for (let k = 0; k < n; k++) {
              const t = f0 + k / n * Math.PI * 2;
              let d = ((t - f0) % (Math.PI * 2 / 3) + Math.PI * 2 / 3) % (Math.PI * 2 / 3) - Math.PI / 3;
              const tri = 0.5 / Math.cos(d);
              const rr = r * ((1 - sm) * tri + sm);
              o.push([Math.cos(t) * rr, Math.sin(t) * rr]);
            }
            return o;
          };
          const W = function (pts) { return pts.map(function (p) { return T(p[0], p[1]); }); };
          const white = N ? [92, 150, 214] : [226, 233, 240], deck = N ? [150, 200, 255] : [176, 196, 214];
          const hs = [0, 40, 80, 125, 170, 215, 260, 305, 340];
          let prev = ring(0);
          for (let q = 1; q < hs.length; q++) {
            const cur = ring(hs[q]);
            frustumRings(ctx, pj, W(prev), W(cur), hs[q - 1] * E, hs[q] * E, white, lm.x, lm.y, q < hs.length - 1);
            if (s >= 16) { // 桁架斜撑
              ctx.strokeStyle = N ? 'rgba(200,232,255,0.55)' : 'rgba(120,134,150,0.45)'; ctx.lineWidth = lw * 0.8; ctx.beginPath();
              for (let k = 0; k < n; k++) {
                const a = prev[k], c = cur[(k + 1) % n], c2 = cur[(k + n - 1) % n];
                if (!front(a[0], a[1])) continue;
                const A = T(a[0], a[1]), C1 = T(c[0], c[1]), C2 = T(c2[0], c2[1]);
                const pA = pj(A[0], A[1], hs[q - 1] * E), p1 = pj(C1[0], C1[1], hs[q] * E), p2 = pj(C2[0], C2[1], hs[q] * E);
                ctx.moveTo(pA[0], pA[1]); ctx.lineTo(p1[0], p1[1]); ctx.moveTo(pA[0], pA[1]); ctx.lineTo(p2[0], p2[1]);
              }
              ctx.stroke();
            }
            prev = cur;
          }
          cyl(0, 0, 24, 18, 340, 352, white);
          cyl(0, 0, 26, 18, 352, 368, deck);      // 天望甲板
          cyl(0, 0, 22, 18, 368, 375, white);
          cyl(0, 0, 15, 14, 375, 440, white);
          cyl(0, 0, 19, 16, 440, 452, deck);      // 天望回廊
          cyl(0, 0, 12, 12, 452, 497, white);
          line(0, 0, 497, 0, 0, H, N ? '#d8ecff' : '#b8c2cc', Math.max(1.4, s / 22));
          line(0, 0, 560, 0, 0, H, N ? '#ffffff' : '#d0d6dc', Math.max(0.8, s / 40));
          if (N) dot(0, 0, H, Math.max(1.2, s / 28), '#ff4d6d');
          break;
        }
        // 东京塔：333 m，底边约 80 m 的四足桁架，150 m 大展望台、250 m 特别展望台
        const H = lm.h || 333;
        const hwAt = function (h) { return 3 + 37 * Math.pow(Math.max(0, 1 - h / 260), 1.8); };
        const ORG = N ? [255, 132, 52] : [214, 74, 42], WHT = N ? [255, 204, 140] : [238, 236, 230];
        box(-45, -30, 45, 30, 0, 22, N ? [96, 100, 116] : [226, 223, 216]); // 塔下大楼
        lit(-45, 30, 45, 30, 3, 20, 4, 10);
        const sq = function (w) { return Rc(-w, -w, w, w); };
        // 四足：0–50 m
        for (const a of [-1, 1]) for (const c of [-1, 1]) {
          const u0 = a * 38, v0 = c * 38, u1 = a * (hwAt(50) - 3), v1 = c * (hwAt(50) - 3);
          const B = Rc(u0 - 5, v0 - 5, u0 + 5, v0 + 5), Tp = Rc(u1 - 3, v1 - 3, u1 + 3, v1 + 3), cc = T((u0 + u1) / 2, (v0 + v1) / 2);
          frustumRings(ctx, pj, B, Tp, 0, 50 * E, ORG, cc[0], cc[1]);
        }
        const bands = [50, 78, 102, 124, 145, 168, 190, 212, 232, 250];
        const xb = function (h0, h1) { // 立面上的 X 形斜撑
          if (s < 16) return;
          const w0 = hwAt(h0), w1 = hwAt(h1);
          ctx.strokeStyle = N ? 'rgba(255,240,210,0.5)' : 'rgba(110,40,24,0.45)'; ctx.lineWidth = lw; ctx.beginPath();
          const sides = [[1, 0], [0, 1], [-1, 0], [0, -1]];
          for (const sd of sides) {
            if (!front(sd[0], sd[1])) continue;
            const P = function (t, w, h) { const u = sd[0] ? sd[0] * w : (t * 2 - 1) * w, v = sd[1] ? sd[1] * w : (t * 2 - 1) * w, q = T(u, v); return pj(q[0], q[1], h * E); };
            const a0 = P(0, w0, h0), a1 = P(1, w1, h1), b0 = P(1, w0, h0), b1 = P(0, w1, h1);
            ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.moveTo(b0[0], b0[1]); ctx.lineTo(b1[0], b1[1]);
          }
          ctx.stroke();
        };
        for (let q = 1; q < bands.length; q++) {
          const h0 = bands[q - 1], h1 = bands[q];
          frustumRings(ctx, pj, sq(hwAt(h0)), sq(hwAt(h1)), h0 * E, h1 * E, q % 2 ? ORG : WHT, lm.x, lm.y, true);
          xb(h0, h1);
          if (h1 === 145) { box(-19, -19, 19, 19, 145, 160, N ? [255, 226, 170] : [196, 204, 212]); lit(-19, 19, 19, 19, 148, 158, 2, 8); } // 大展望台
        }
        box(-7, -7, 7, 7, 248, 256, N ? [255, 226, 170] : [196, 204, 212]); // 特别展望台
        // 天线段：250–333 m，橙白相间
        const ah = [256, 270, 284, 298, 312];
        for (let q = 1; q < ah.length; q++) { const w0 = 3 - (ah[q - 1] - 256) / 40, w1 = 3 - (ah[q] - 256) / 40; frustumRings(ctx, pj, sq(w0), sq(w1), ah[q - 1] * E, ah[q] * E, q % 2 ? WHT : ORG, lm.x, lm.y, q < ah.length - 1); }
        line(0, 0, 312, 0, 0, H, N ? '#ffd9a0' : '#c45a3c', Math.max(1, s / 30));
        dot(0, 0, H, Math.max(1.2, s / (N ? 24 : 34)), N ? '#ff4d6d' : '#e0403a');
        break;
      }
      case 'skyscraper': {
        const H = lm.h;
        if (lm.style === 'citic') { // 中信广场：裙楼 + 两座公寓塔 + 主塔（双桅杆）
          box(-100, -100, 100, 100, 0, 18, N ? [80, 88, 104] : [216, 214, 210], null);
          for (const du of [-62, 62]) { box(du - 17, 30, du + 17, 64, 18, 120, N ? [96, 104, 122] : [224, 220, 210], null); lit(du - 17, 64, du + 17, 64, 22, 116, 14, 4); }
          box(-24, -60, 24, -12, 18, 322, N ? [70, 92, 120] : [196, 210, 220], null, { lines: function (fc, q) { if (s < 16) return; ctx.strokeStyle = N ? 'rgba(255,214,140,0.45)' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); for (let t = 0.1; t < 1; t += 0.1) { ctx.moveTo(q[0][0] + (q[1][0] - q[0][0]) * t, q[0][1] + (q[1][1] - q[0][1]) * t); ctx.lineTo(q[3][0] + (q[2][0] - q[3][0]) * t, q[3][1] + (q[2][1] - q[3][1]) * t); } ctx.stroke(); } });
          hip(-24, -60, 24, -12, 322, 340, N ? [120, 130, 150] : [176, 186, 196]);
          for (const du of [-10, 10]) { line(du, -36, 330, du, -36, H, N ? '#c8d0dc' : '#8a929c', Math.max(1, s / 30)); if (N) dot(du, -36, H, 1.8, '#ff4d4d'); }
        } else if (lm.style === 'west') { // 西塔：圆角三角形玻璃筒 + 斜交网格
          const tri = function (sc) { const o = []; for (let k = 0; k < 18; k++) { const t = k / 18 * Math.PI * 2; const r = 33 * sc * (1 + 0.13 * Math.cos(3 * t)); o.push(T(Math.cos(t) * r, Math.sin(t) * r)); } return o; };
          const segs = 6;
          for (let k = 0; k < segs; k++) { const h0 = H * k / segs, h1 = H * (k + 1) / segs, sc0 = 1 - 0.12 * k / segs, sc1 = 1 - 0.12 * (k + 1) / segs; const c = T(0, 0); frustumRings(ctx, pj, tri(sc0), tri(sc1), h0 * E, h1 * E, N ? [60, 90, 130] : [168, 200, 226], c[0], c[1], k < segs - 1); }
          if (s >= 16) { ctx.strokeStyle = N ? 'rgba(160,210,255,0.55)' : 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; for (let k = 0; k < 10; k++) { const a0 = k / 10 * Math.PI * 2; ctx.beginPath(); for (let q = 0; q <= 20; q++) { const t = q / 20, a = a0 + t * 1.2 * (k % 2 ? 1 : -1); if (Math.cos(a) + Math.sin(a) < -0.2) continue; const r = 33 * (1 - 0.12 * t); const w = T(Math.cos(a) * r, Math.sin(a) * r), p = pj(w[0], w[1], H * t * E); if (q) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); } ctx.stroke(); } }
          if (N) dot(0, 0, H, 2, '#ff4d4d');
        } else if (lm.style === 'taipei101') { // 台北101：裙楼 + 截头方锥基座 + 8 节外倾「竹节」 + 顶部与塔尖
          const kh = H / 508, col = N ? [62, 96, 100] : [146, 188, 184], q2 = function (w) { return Rc(-w, -w, w, w); };
          box(-62, -48, 62, 48, 0, 58 * kh, N ? [80, 88, 104] : [214, 214, 208]);
          frustumRings(ctx, pj, q2(32), q2(25), 0, 92 * kh * E, col, lm.x, lm.y, false);
          for (let k = 0; k < 8; k++) { const h0 = 92 + k * 32.5; frustumRings(ctx, pj, q2(22), q2(28), h0 * kh * E, (h0 + 32.5) * kh * E, k % 2 ? col : U.shade(col, 1.07), lm.x, lm.y, false); }
          frustumRings(ctx, pj, q2(18), q2(12), 352 * kh * E, 392 * kh * E, col, lm.x, lm.y, false);
          line(0, 0, 392 * kh, 0, 0, H, N ? '#c8d0dc' : '#8a929c', Math.max(1, s / 26));
          if (N) dot(0, 0, H, 2, '#ff4d4d');
        } else { // 东塔：方形分段收分，白色竖向陶板（其他城市的超高层按高度与占地等比缩放）
          const kh = H / 530, kw = Math.min(1.2, (lm.w || 78) / 78);
          const tiers = [[38, 0, 160], [36, 160, 330], [33, 330, 470], [29, 470, 515]];
          for (const t of tiers) box(-t[0] * kw, -t[0] * 0.9 * kw, t[0] * kw, t[0] * 0.9 * kw, t[1] * kh, t[2] * kh, N ? [80, 92, 112] : [214, 222, 230], null, { lines: function (fc, q) { if (s < 16) return; ctx.strokeStyle = N ? 'rgba(255,214,140,0.4)' : 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.beginPath(); for (let k = 0.08; k < 1; k += 0.14) { ctx.moveTo(q[0][0] + (q[1][0] - q[0][0]) * k, q[0][1] + (q[1][1] - q[0][1]) * k); ctx.lineTo(q[3][0] + (q[2][0] - q[3][0]) * k, q[3][1] + (q[2][1] - q[3][1]) * k); } ctx.stroke(); } });
          box(-22 * kw, -20 * kw, 22 * kw, 20 * kw, 515 * kh, H, N ? [110, 120, 140] : [196, 204, 214]);
          if (N) dot(0, 0, H, 2, '#ff4d4d');
        }
        break;
      }
      case 'opera': { // 广州大剧院：两块“圆润双砾”
        const facet = N ? [92, 98, 110] : [214, 214, 210];
        const pebble = function (cu, cv, r0, h, n, rot) { const c = T(cu, cv); frustumRings(ctx, pj, NG(cu, cv, r0, n, rot, r0 * 0.78), NG(cu + 6, cv - 4, r0 * 0.62, n, rot + 0.3, r0 * 0.48), 0, h * 0.75 * E, facet, c[0], c[1], true); const top = NG(cu + 6, cv - 4, r0 * 0.62, n, rot + 0.3, r0 * 0.48); const t2 = T(cu + 10, cv - 6); pyramidN(ctx, pj, top, t2[0], t2[1], h * 0.75 * E, h * E, U.shade(facet, 1.05)); };
        pebble(-30, 0, 62, 42, 7, 0.2);
        pebble(62, 38, 32, 26, 6, 0.6);
        lit(-80, 30, 20, 40, 3, 12, 1, 8);
        break;
      }
      case 'box': { // 广东省博物馆：“宝盒”
        box(-40, -40, 40, 40, 0, 7, N ? [60, 64, 72] : [120, 124, 130], null);
        box(-58, -58, 58, 58, 7, 42, N ? [70, 72, 80] : [96, 96, 100], N ? [90, 92, 100] : [150, 150, 156], { lines: function (fc, q) { if (s < 16) return; ctx.strokeStyle = N ? 'rgba(220,180,90,0.35)' : 'rgba(220,200,160,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); for (let t = 0.12; t < 1; t += 0.18) { ctx.moveTo(q[0][0] + (q[3][0] - q[0][0]) * t, q[0][1] + (q[3][1] - q[0][1]) * t); ctx.lineTo(q[1][0] + (q[2][0] - q[1][0]) * t, q[1][1] + (q[2][1] - q[1][1]) * t); } ctx.stroke(); } });
        break;
      }
      case 'library': { // 广州图书馆：“之”字形层叠
        const c1 = N ? [96, 100, 112] : [206, 200, 188];
        box(-62, -36, 10, 36, 0, 26, c1, null); box(-10, -36, 62, 36, 26, 50, c1);
        box(-62, -36, 10, 36, 26, 28, U.shade(c1, 0.9)); lit(-62, 36, 10, 36, 3, 24, 4, 8); lit(-10, 36, 62, 36, 28, 48, 4, 8);
        break;
      }
      case 'mall': { // 天河城：商业裙楼
        box(-hw + 10, -hd + 10, hw - 10, hd - 10, 0, 32, N ? [86, 92, 110] : [224, 218, 206], null);
        lit(-hw + 10, hd - 10, hw - 10, hd - 10, 3, 30, 6, 14);
        box(-30, -30, 30, 30, 32, 40, N ? [110, 120, 140] : [196, 210, 224]);
        break;
      }
      case 'conference': { // 白云国际会议中心：彩色竖向遮阳板
        box(-hw + 20, -hd + 30, hw - 20, hd - 30, 0, 36, N ? [86, 92, 106] : [226, 226, 222], null, { lines: function (fc, q) { if (s < 16) return; const cols = ['#d94f3d', '#f0a72b', '#2f6fb6', '#16a085', '#8e44ad']; for (let k = 0; k < 14; k++) { const t = (k + 0.5) / 14; ctx.strokeStyle = cols[k % 5]; ctx.lineWidth = Math.max(1, s / 30); ctx.beginPath(); ctx.moveTo(q[0][0] + (q[1][0] - q[0][0]) * t, q[0][1] + (q[1][1] - q[0][1]) * t); ctx.lineTo(q[3][0] + (q[2][0] - q[3][0]) * t, q[3][1] + (q[2][1] - q[3][1]) * t); ctx.stroke(); } } });
        break;
      }
      case 'concert': { // 星海音乐厅：双曲抛物面屋顶
        poly([T(-58, -26), T(56, -38), T(48, 36), T(-52, 30)], 0, 8, N ? [88, 96, 110] : [236, 238, 240], null);
        lit(-52, 30, 48, 36, 1, 7, 1, 8);
        const P = [T(-58, -26), T(56, -38), T(48, 36), T(-52, 30)].map(function (p, k) { return pj(p[0], p[1], [8, 32, 8, 24][k] * E); });
        fillPts(ctx, [P[0], P[1], P[2]], N ? '#9fb2c8' : '#f7f8fa');
        fillPts(ctx, [P[0], P[2], P[3]], N ? '#7d90a8' : '#dfe4ea');
        break;
      }
      case 'gallery': { // 广东美术馆：白色多面体
        poly(NG(0, 0, 46, 5, -Math.PI / 2), 0, 14, white, U.shade(white, 0.96));
        poly(NG(6, -4, 22, 4, Math.PI / 4), 14, 22, white, U.shade(white, 1.02));
        break;
      }
      default: box(-hw * 0.6, -hd * 0.6, hw * 0.6, hd * 0.6, 0, 12, [214, 196, 172]); break;
    }
  };

  CM.RH_ISO = { polyRect: polyRect, fillPts: fillPts, prism: prism, pyramidN: pyramidN, frustumRings: frustumRings, ISO: ISO, HSF: HSF, EX: EX, MAX_H: MAX_H };
})(window.CM);
