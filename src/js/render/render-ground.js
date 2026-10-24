'use strict';
// 地面绘制：地块底色、水系与岸线、道路铁路、公园林地、旧机场跑道、2D 建筑占地与地标场地，以及地面分块与整城底图
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA, LU = CM.LU;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;

  // ---------------- 地面绘制（世界坐标） ----------------
  // 格内单位坐标 (u,v) → 世界坐标
  Renderer.prototype.quadPt = function (i, j, u, v) {
    const city = this.game.city, VW = city.VW, vx = city.vx, vy = city.vy;
    const a = j * VW + i, b = a + 1, c = a + VW + 1, d = a + VW;
    const x = (vx[a] * (1 - u) + vx[b] * u) * (1 - v) + (vx[d] * (1 - u) + vx[c] * u) * v;
    const y = (vy[a] * (1 - u) + vy[b] * u) * (1 - v) + (vy[d] * (1 - u) + vy[c] * u) * v;
    return [x, y];
  };
  // 单格建筑（单位坐标 u,v ∈ [0,1]，高度为米）：在 4×4 子地块上稀疏布置，避开真实道路、铁路与水面。
  // 风格上以少量玻璃塔楼与低层体量为主；coarse=true（远景）时只保留较高的建筑。
  Renderer.prototype.cellBuildings = function (c, coarse) {
    const city = this.game.city, L = city.lu[c];
    if (!city.street[c] && L !== LU.RURAL) return null;
    const h0 = city.bh[c];
    if (h0 <= 0) return null;
    const lf = city.landFrac[c] * (1 - city.taken[c]);
    if (lf < 0.15) return null;
    if (L === LU.RURAL && city.pop[c] < 12) return null;
    if (L !== LU.RURAL && L !== LU.RES && L !== LU.MIX && L !== LU.COM && L !== LU.IND && L !== LU.INST) return null;
    if (coarse && h0 < 22) return null;
    const hs = function (k) { return U.hash2(c, k, 91); };
    const W = city.W, i = c % W, j = (c / W) | 0, BS = city.BS, BW = city.BW, bm = city.bmask;
    const free = this._free || (this._free = new Uint8Array(16));
    let nFree = 0;
    for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) {
      let maj = 0, mn = 0;
      for (let y = 0; y < 2; y++) { const row = (j * BS + v * 2 + y) * BW + i * BS + u * 2; for (let x = 0; x < 2; x++) { const m = bm[row + x]; if (m >= 2) maj++; else if (m === 1) mn++; } }
      const f = maj === 0 && mn <= 1 ? 1 : 0;
      free[v * 4 + u] = f; nFree += f;
    }
    if (!nFree) return null;
    const quadFree = function (qu, qv) { return free[qv * 8 + qu * 2] && free[qv * 8 + qu * 2 + 1] && free[qv * 8 + 4 + qu * 2] && free[qv * 8 + 4 + qu * 2 + 1]; };
    const out = [];
    const tag = function (b) { if (b[4] >= 120) b.tag = 'landmark'; return b; };
    const sub = function (u, v, size, h) { const cx = u * 0.25 + 0.125, cy = v * 0.25 + 0.125, r = size / 2; out.push(tag([cx - r, cy - r, cx + r, cy + r, h, L])); };
    const quad = function (qu, qv, size, h) { const cx = qu * 0.5 + 0.25, cy = qv * 0.5 + 0.25, r = size / 2; out.push(tag([cx - r, cy - r, cx + r, cy + r, h, L])); };
    const dens = U.clamp((city.pop[c] + city.jobs[c]) / 3000, 0.2, 1);
    // 随机挑选可用子地块
    const pickSubs = function (n, seed) { const got = []; for (let k = 0; k < 16 && got.length < n; k++) { const s2 = (k * 7 + Math.floor(hs(seed) * 16)) % 16; if (free[s2] && got.indexOf(s2) < 0) got.push(s2); } return got; };
    switch (L) {
      case LU.RURAL: {
        if (hs(2) < 0.45) for (const s2 of pickSubs(1, 3)) sub(s2 & 3, s2 >> 2, 0.14, 4 + hs(11) * 4);
        break;
      }
      case LU.RES: case LU.MIX: {
        if (h0 > 40) {
          // 高层住宅：1–2 座点式塔楼
          let n = 0;
          for (let q = 0; q < 4 && n < (dens > 0.6 ? 2 : 1); q++) { const qq = (q + Math.floor(hs(20) * 4)) % 4; if (quadFree(qq & 1, qq >> 1) && hs(21 + qq) < 0.75) { quad(qq & 1, qq >> 1, 0.22 + hs(24 + qq) * 0.06, h0 * (0.8 + 0.4 * hs(28 + qq))); n++; } }
          if (!coarse) for (const s2 of pickSubs(1, 33)) sub(s2 & 3, s2 >> 2, 0.18, Math.min(h0, 20) * (0.6 + 0.4 * hs(34)));
        } else if (!coarse) {
          const n = Math.round(dens * 1.4 + hs(5) * 0.9);
          for (const s2 of pickSubs(n, 6)) sub(s2 & 3, s2 >> 2, 0.16 + hs(40 + s2) * 0.05, h0 * (0.7 + 0.6 * hs(50 + s2)));
        }
        break;
      }
      case LU.COM: {
        let tower = false;
        for (let q = 0; q < 4 && !tower; q++) { const qq = (q + Math.floor(hs(60) * 4)) % 4; if (quadFree(qq & 1, qq >> 1)) { quad(qq & 1, qq >> 1, h0 > 50 ? 0.24 + hs(2) * 0.06 : 0.36, h0 * (0.85 + 0.3 * hs(3))); tower = true; } }
        if (!coarse) for (const s2 of pickSubs(tower ? 1 : 2, 65)) sub(s2 & 3, s2 >> 2, 0.18, h0 * (0.35 + 0.35 * hs(66 + s2)));
        break;
      }
      case LU.IND: {
        if (coarse) break;
        let n = 0;
        for (let q = 0; q < 4 && n < 2; q++) if (quadFree(q & 1, q >> 1) && hs(70 + q) < 0.55) { quad(q & 1, q >> 1, 0.4, h0 * (0.8 + 0.3 * hs(74 + q))); n++; }
        break;
      }
      case LU.INST: {
        if (coarse) break;
        for (let q = 0; q < 4; q++) if (quadFree(q & 1, q >> 1) && hs(80 + q) < 0.35) { const cx = (q & 1) * 0.5 + 0.25, cy = (q >> 1) * 0.5 + 0.25; out.push(tag([cx - 0.19, cy - 0.11, cx + 0.19, cy + 0.11, h0 * (0.8 + 0.3 * hs(84 + q)), L])); }
        break;
      }
    }
    if (!out.length) return null;
    if (city.taken[c] > 0.05) { const keep = Math.max(0, Math.round(out.length * (1 - city.taken[c]))); out.length = keep; }
    // 建筑密度：按高度从高到低保留一部分普通建筑（抖动量让比例落到小数时也平滑过渡）；
    // 带 landmark 标签的地标与超高层不参与这个比例，任何时候都保留
    const keepRatio = this.bldKeep();
    if (keepRatio < 1 && out.length) {
      const order = out.map(function (b, k) { return k; }).sort(function (a, b) { return out[b][4] - out[a][4] || a - b; });
      const mark = new Uint8Array(out.length);
      let want = Math.floor(out.length * keepRatio + U.hash2(c, 3, 97));
      for (const k of order) {
        const b = out[k];
        if (this.hasTag(b, 'landmark')) mark[k] = 1;
        else if (want > 0) { mark[k] = 1; want--; }
      }
      const kept = out.filter(function (b, k) { return mark[k]; });
      out.length = 0;
      for (const b of kept) out.push(b);
    }
    return out.length ? out : null;
  };

  Renderer.prototype.drawGround = function (ctx, X0, Y0, X1, Y1, lvl) {
    const g = this.game, city = g.city, W = city.W, H = city.H, Geo = CM.Geo;
    const i0 = Math.max(0, Math.floor(X0)), j0 = Math.max(0, Math.floor(Y0)), i1 = Math.min(W, Math.ceil(X1)), j1 = Math.min(H, Math.ceil(Y1));
    const px = 1 / lvl;
    const inBox = function (b, m) { return b[2] >= X0 - m && b[0] <= X1 + m && b[3] >= Y0 - m && b[1] <= Y1 + m; };
    ctx.fillStyle = S.GROUND.land; ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    // 地块底色（按颜色批量）
    const paths = new Map();
    const P = function (col) { let p = paths.get(col); if (!p) { p = new Path2D(); paths.set(col, p); } return p; };
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const c = j * W + i, L = city.lu[c];
        let col;
        if (L === LU.WATER) col = S.GROUND.farm[0];
        else if (L === LU.HILL) col = S.GROUND.hill[Math.floor(U.noise2(i * 0.35, j * 0.35, 5) * 3) % 3];
        else if (L === LU.AIRPORT) col = S.GROUND.airport;
        else if (city.street[c] && L !== LU.PARK) col = S.GROUND.urban[L] || S.GROUND.urban[0];
        else col = S.GROUND.farm[Math.floor(U.hash2(i >> 1, j >> 1, 3) * 3)];
        P(col).rect(i - px, j - px, 1 + 2 * px, 1 + 2 * px);
      }
    }
    paths.forEach(function (p, col) { ctx.fillStyle = col; ctx.fill(p); });
    // 夜间：商业中心与混合街区的暖色灯光（按岗位密度分三档）
    if (S.TH.night && lvl >= 16) {
      const glow = [new Path2D(), new Path2D(), new Path2D()], any = [false, false, false];
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const c = j * W + i, L = city.lu[c];
        if ((L !== LU.COM && L !== LU.MIX) || !city.street[c]) continue;
        const d = city.jobs[c] / (L === LU.COM ? 2500 : 4000), q = d > 1.2 ? 2 : (d > 0.5 ? 1 : (d > 0.15 ? 0 : -1));
        if (q < 0) continue;
        glow[q].rect(i, j, 1, 1); any[q] = true;
      }
      for (let q = 0; q < 3; q++) if (any[q]) { ctx.fillStyle = 'rgba(255,190,110,' + [0.05, 0.09, 0.14][q] + ')'; ctx.fill(glow[q]); }
    }
    // 林地（真实范围）
    ctx.fillStyle = S.GROUND.wood;
    const wp = new Path2D();
    for (const f of Geo.woods) if (inBox(f.bbox, 0.5)) wp.addPath(this.featurePath(f, true));
    ctx.fill(wp, 'evenodd');
    // 风景区山体：雾蓝绿色
    // 逐个填充：风景区内常有嵌套的子景区，合在一条路径里用奇偶规则会互相抵消成空洞
    ctx.fillStyle = S.GROUND.hill[0]; ctx.globalAlpha = 0.85;
    for (const f of Geo.reserves) if (inBox(f.bbox, 0.5)) ctx.fill(this.featurePath(f, true), 'evenodd');
    ctx.globalAlpha = 1;
    // 公园（真实范围）
    const pp = new Path2D();
    for (const f of Geo.parks) if (inBox(f.bbox, 0.5)) pp.addPath(this.featurePath(f, true));
    ctx.fillStyle = S.GROUND.park; ctx.fill(pp, 'evenodd');
    if (lvl >= 16) { ctx.strokeStyle = S.GROUND.parkEdge; ctx.lineWidth = px * 1.2; ctx.stroke(pp); }
    // 旧机场跑道
    const ab = city.airportBox;
    const rw = D.airport && D.airport.runway;
    if (rw && city.lu.indexOf(LU.AIRPORT) >= 0 && inBox([Math.min(rw[0][0], rw[1][0]), Math.min(rw[0][1], rw[1][1]), Math.max(rw[0][0], rw[1][0]), Math.max(rw[0][1], rw[1][1])], 1)) {
      // 指定方向的跑道（如伸入海港的启德跑道）
      ctx.lineCap = 'butt';
      ctx.strokeStyle = S.GROUND.apron; ctx.lineWidth = 0.55; ctx.beginPath(); ctx.moveTo(rw[0][0], rw[0][1]); ctx.lineTo(rw[1][0], rw[1][1]); ctx.stroke();
      ctx.strokeStyle = S.GROUND.runway; ctx.lineWidth = 0.26; ctx.stroke();
      ctx.strokeStyle = '#f4f4f0'; ctx.lineWidth = Math.max(px, 0.02); ctx.setLineDash([0.3, 0.3]); ctx.stroke(); ctx.setLineDash([]);
    } else if (ab && city.lu.indexOf(LU.AIRPORT) >= 0 && inBox(ab, 1)) {
      const cx = (ab[0] + ab[2]) / 2, len = (ab[3] - ab[1]) * 0.78, y0 = (ab[1] + ab[3]) / 2 - len / 2;
      ctx.fillStyle = S.GROUND.apron; ctx.fillRect(cx - 1.3, y0 + len * 0.3, 0.9, len * 0.32);
      ctx.fillStyle = S.GROUND.runway; ctx.fillRect(cx - 0.12, y0, 0.24, len);
      ctx.strokeStyle = '#f4f4f0'; ctx.lineWidth = Math.max(px, 0.02); ctx.setLineDash([0.3, 0.3]);
      ctx.beginPath(); ctx.moveTo(cx, y0 + 0.2); ctx.lineTo(cx, y0 + len - 0.2); ctx.stroke(); ctx.setLineDash([]);
    }
    // 水系（真实岸线）
    const wpth = new Path2D();
    for (const f of Geo.water) if (inBox(f.bbox, 0.5)) wpth.addPath(this.featurePath(f, true));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // 历史海岸线：尚未填海成陆的区域仍画成水面（单独以 nonzero 填充，避免与海域多边形的奇偶规则抵消）
    const rpth = new Path2D(); let anyRc = false;
    for (const f of city.reclaimFeats ? city.reclaimFeats(true) : []) if (inBox(f.bbox, 0.5)) { const path = this.featurePath(f, true); rpth.addPath(path); wpth.addPath(path); anyRc = true; }
    ctx.strokeStyle = S.GROUND.bank; ctx.lineWidth = Math.max(0.05, px * 2.4); ctx.stroke(wpth);
    ctx.fillStyle = S.GROUND.water; ctx.fill(wpth, 'evenodd');
    if (anyRc) ctx.fill(rpth, 'nonzero');
    // 水面波纹（近景）
    if (lvl >= 16) {
      ctx.save(); ctx.clip(wpth, 'evenodd');
      ctx.strokeStyle = S.GROUND.glint; ctx.lineWidth = px * 1.2;
      ctx.beginPath();
      for (let j = Math.floor(Y0); j < Y1; j += 0.7) for (let i = Math.floor(X0); i < X1; i += 1.3) {
        const hx = U.hash2(Math.round(i * 10), Math.round(j * 10), 17); if (hx > 0.35) continue;
        const x = i + hx * 1.5, y = j + U.hash2(Math.round(i * 10), Math.round(j * 10), 18) * 0.5;
        ctx.moveTo(x, y); ctx.lineTo(x + 0.35, y - 0.06);
      }
      ctx.stroke(); ctx.restore();
    }
    for (const l of Geo.waterLines) {
      if (!inBox(l.bbox, 0.5)) continue;
      ctx.strokeStyle = S.GROUND.water; ctx.lineWidth = Math.max(l.w, px * 1.5);
      ctx.stroke(this.featurePath(l, false));
    }
    // 2D 建筑占地（近景才显示，保持平面图简洁）
    if (lvl >= 32) {
      const shadow = this.shadows ? new Path2D() : null;
      const fills = new Map();
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const c = j * W + i;
        if (this.isLmCenter(c)) continue;
        const bl = this.cellBuildings(c);
        if (!bl) continue;
        for (let k = 0; k < bl.length; k++) {
          const b = bl[k];
          const x0 = i + b[0], y0 = j + b[1], x1 = i + b[2], y1 = j + b[3];
          if (shadow) { const off = Math.min(0.08, 0.008 + b[4] * 0.0005); shadow.rect(x0 + off, y0 + off, x1 - x0, y1 - y0); }
          const col = U.rgb(this.bldTopColor(c, k, b));
          let fp = fills.get(col); if (!fp) { fp = new Path2D(); fills.set(col, fp); }
          fp.rect(x0, y0, x1 - x0, y1 - y0);
        }
      }
      if (shadow) { ctx.fillStyle = S.TH.shadow2d; ctx.fill(shadow); }
      ctx.strokeStyle = S.TH.bldStroke; ctx.lineWidth = px;
      fills.forEach(function (p, col) { ctx.fillStyle = col; ctx.fill(p); if (lvl >= 32) ctx.stroke(p); });
    }
    // 公园树木（2D）
    if (lvl >= 32) {
      ctx.fillStyle = S.TH.parkTree;
      ctx.beginPath();
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const c = j * W + i, L = city.lu[c];
        if (L !== LU.PARK && L !== LU.HILL && city.wood[c] < 0.5) continue;
        for (let k = 0; k < 4; k++) {
          const x = i + 0.12 + U.hash2(c, k, 61) * 0.76, y = j + 0.12 + U.hash2(c, k, 62) * 0.76;
          if (city.waterAt(x, y) || city.bmask[Math.floor(y * city.BS) * city.BW + Math.floor(x * city.BS)] >= 2) continue;
          ctx.moveTo(x + 0.06, y); ctx.arc(x, y, 0.06, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    // 铁路
    const RD = S.TH.road;
    for (const r of Geo.rail) {
      if (!inBox(r.bbox, 0.5) || (r.flags & 2)) continue;
      if ((r.flags & 16) && g.clock.y < (D.hsrYear || 2009)) continue;   // 高速铁路按本地图的开通年份出现
      if (r.year && g.clock.y < r.year) continue;
      const railPath = this.featurePath(r, false);
      ctx.strokeStyle = RD.railCase; ctx.lineWidth = Math.max(0.05, px * 2.6); ctx.stroke(railPath);
      ctx.strokeStyle = RD.rail; ctx.lineWidth = Math.max(0.025, px * 1.2);
      if (lvl >= 32) ctx.setLineDash([0.06, 0.06]);
      ctx.stroke(railPath); ctx.setLineDash([]);
    }
    // 支路：只在已开发的街区显示
    const streets = Geo.streetBk && lvl >= 16 ? Geo.query(Geo.streetBk, X0 - 0.5, Y0 - 0.5, X1 + 0.5, Y1 + 0.5) : [];
    const st = new Path2D();
    for (const k of streets) {
      const p = Geo.streets[k].p;
      for (let q = 0; q + 3 < p.length; q += 2) {
        const c = city.cellAt((p[q] + p[q + 2]) / 2, (p[q + 1] + p[q + 3]) / 2);
        if (c < 0 || !city.street[c] || city.lu[c] === LU.PARK) continue;
        st.moveTo(p[q], p[q + 1]); st.lineTo(p[q + 2], p[q + 3]);
      }
    }
    // 主要道路（已通车）
    const ways = city.roadWayBk ? Geo.query(city.roadWayBk, X0 - 0.5, Y0 - 0.5, X1 + 0.5, Y1 + 0.5) : [];
    const lay = { 2: [], 3: [], 4: [] }, links = [], tunnels = [];
    for (const k of ways) {
      const w = city.roadWays[k];
      if (!city.roadsBuilt[w.g]) continue;
      const gr = city.roadGroups[w.g];
      if (gr.flags & 2) tunnels.push(w); else if (gr.flags & 4) links.push(w); else lay[gr.cls].push(w);
    }
    const path = (arr) => { const p = new Path2D(); for (const w of arr) p.addPath(this.featurePath(w, false)); return p; };
    const bridgePath = (arr) => { const p = new Path2D(); for (const w of arr) if (city.roadGroups[w.g].flags & 1) p.addPath(this.featurePath(w, false)); return p; };
    const P2 = path(lay[2]), P3 = path(lay[3]), P4 = path(lay[4]), PL = path(links), PT = path(tunnels);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 路缘（桥梁加深）
    ctx.strokeStyle = RD.localCase; ctx.lineWidth = Math.max(0.05, px * 2.2); ctx.stroke(st);
    ctx.strokeStyle = RD.collCase; ctx.lineWidth = Math.max(0.085, px * 2.8); ctx.stroke(P2);
    ctx.strokeStyle = RD.artCase; ctx.lineWidth = Math.max(0.12, px * 3.4); ctx.stroke(P3);
    ctx.strokeStyle = RD.expCase; ctx.lineWidth = Math.max(0.065, px * 2.4); ctx.stroke(PL);
    ctx.lineWidth = Math.max(0.16, px * 4.2); ctx.stroke(P4);
    ctx.strokeStyle = RD.bridgeCase;
    ctx.lineWidth = Math.max(0.12, px * 3.6); ctx.stroke(bridgePath(lay[3])); ctx.stroke(bridgePath(lay[2]));
    ctx.lineWidth = Math.max(0.17, px * 4.4); ctx.stroke(bridgePath(lay[4]));
    // 路面
    ctx.strokeStyle = RD.local; ctx.lineWidth = Math.max(0.03, px * 1.1); ctx.stroke(st);
    ctx.strokeStyle = RD.coll; ctx.lineWidth = Math.max(0.055, px * 1.7); ctx.stroke(P2);
    ctx.strokeStyle = RD.art; ctx.lineWidth = Math.max(0.085, px * 2.3); ctx.stroke(P3);
    ctx.strokeStyle = RD.exp; ctx.lineWidth = Math.max(0.04, px * 1.4); ctx.stroke(PL);
    ctx.lineWidth = Math.max(0.12, px * 3); ctx.stroke(P4);
    if (tunnels.length) { ctx.strokeStyle = RD.tunnel; ctx.lineWidth = Math.max(0.05, px * 1.6); ctx.setLineDash([0.12, 0.08]); ctx.stroke(PT); ctx.setLineDash([]); }
    if (lvl >= 32 && lay[4].length) { ctx.strokeStyle = RD.expLine; ctx.lineWidth = px; ctx.stroke(P4); }
    // 尚未填海成陆的区域盖回水面：伸向新土地的道路、桥梁与铁路在成陆前不显示
    if (anyRc) { ctx.fillStyle = S.GROUND.water; ctx.fill(rpth, 'nonzero'); }
    // 地标占地（2D）
    for (let k = 0; k < D.landmarks.length; k++) {
      if (!city.landmarkOn[k]) continue;
      const lm = D.landmarks[k], R = Math.max(lm.w, lm.d) / CFG.CELL_M;
      if (lm.x < X0 - R || lm.x > X1 + R || lm.y < Y0 - R || lm.y > Y1 + R) continue;
      this.drawLandmark2D(ctx, lm, lvl);
    }
    // 未开放区域
    const lock = new Path2D(); let anyLock = false;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const c = j * W + i;
      const rg = city.regions[city.region[c]];
      if (city.regionOpen[city.region[c]] || rg.scenic || city.lu[c] === LU.WATER) continue;
      lock.rect(i - px, j - px, 1 + 2 * px, 1 + 2 * px); anyLock = true;
    }
    if (anyLock) {
      ctx.save();
      ctx.clip(lock);
      // 只覆盖陆地：沿岸的格按真实岸线裁掉水面，避免锯齿状的斜线压在江面上
      const land = new Path2D(); land.rect(X0 - 1, Y0 - 1, X1 - X0 + 2, Y1 - Y0 + 2); land.addPath(wpth);
      ctx.clip(land, 'evenodd');
      ctx.fillStyle = S.TH.lockFill; ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      ctx.strokeStyle = S.TH.lockHatch; ctx.lineWidth = Math.max(px, 0.04);
      ctx.beginPath();
      for (let k = Math.floor((X0 + Y0) / 0.6) * 0.6; k < X1 + Y1; k += 0.6) { ctx.moveTo(k - Y0, Y0); ctx.lineTo(k - Y1, Y1); }
      ctx.stroke();
      ctx.restore();
    }
  };
  // 地标占地（2D 平面）：真实场地范围 + 主体建筑轮廓
  Renderer.prototype.drawLandmark2D = function (ctx, lm, lvl) {
    const F = S.TH.lm2d, N = S.TH.night, CMM = CFG.CELL_M;
    const ang = (lm.rot || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const T = function (u, v) { return [lm.x + (u * ca - v * sa) / CMM, lm.y + (u * sa + v * ca) / CMM]; };
    const hw = lm.w / 2, hd = lm.d / 2;
    ctx.save();
    ctx.lineWidth = Math.max(1 / lvl, 0.012); ctx.strokeStyle = F.stroke;
    const poly = function (pts, fill, stroke) { ctx.beginPath(); pts.forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke !== false) ctx.stroke(); };
    const rect = function (u0, v0, u1, v1, fill, stroke) { poly([T(u0, v0), T(u1, v0), T(u1, v1), T(u0, v1)], fill, stroke); };
    const ngon = function (cu, cv, r, n, rot, rv) { const o = []; for (let k = 0; k < n; k++) { const t = k / n * Math.PI * 2 + (rot || 0); o.push(T(cu + Math.cos(t) * r, cv + Math.sin(t) * (rv == null ? r : rv))); } return o; };
    const lawn = N ? '#1f3a28' : '#cfe4bf', plaza = N ? '#2c3340' : '#ece6da', bld = F.fill;
    switch (lm.kind) {
      case 'campus': ctx.globalAlpha = 0.35; rect(-hw, -hd, hw, hd, lawn, false); ctx.globalAlpha = 1; break; // 校园内建筑由街区生成，此处只铺草地底色
      case 'memorial': case 'hall':
        rect(-hw, -hd, hw, hd, lawn, false);
        rect(-12, -hd, 12, hd, plaza, false);
        if (lm.kind === 'hall') { poly(ngon(0, 0, 31, 8, Math.PI / 8), '#4a83c4'); poly(ngon(0, 0, 14, 8, Math.PI / 8), '#7fb0e0', false); }
        else rect(-18, -18, 18, 18, '#f2f2ee');
        break;
      case 'stadium':
        rect(-hw, -hd, hw, hd, lm.w > 500 ? lawn : plaza, false);
        if (lm.w > 500) {
          poly(ngon(0, -70, 150, 36, 0, 125), N ? '#3b4250' : '#eceee9'); poly(ngon(0, -70, 108, 36, 0, 90), '#c8644a', false); poly(ngon(0, -70, 90, 36, 0, 75), '#7dbb62', false);
          poly(ngon(-270, 170, 70, 20, 0, 52), N ? '#3b4250' : '#e2e5e9'); rect(200, 125, 340, 210, N ? '#33475c' : '#cfe2ef');
        } else { poly(ngon(0, 0, hw * 0.95, 30, 0, hd * 0.95), N ? '#3b4250' : '#eceee9'); poly(ngon(0, 0, hw * 0.7, 30, 0, hd * 0.7), '#7dbb62', false); }
        break;
      case 'tvtower': poly(ngon(0, 0, 40, 24, 0, 30), N ? '#4a3f66' : '#b9bec6'); poly(ngon(0, 0, 26, 24, 0, 19), N ? '#2b2840' : '#d5d9df', false); poly(ngon(0, 0, 10, 12), N ? '#d07ae0' : '#646a74', false); break;
      case 'lattice':
        if (lm.style === 'skytree') { rect(-hw, -hd, hw, hd, plaza, false); poly(ngon(0, 0, 39, 3, -Math.PI / 2), N ? '#3e4a5e' : '#dfe5ec'); poly(ngon(0, 0, 17, 18), N ? '#6fa8e0' : '#a9b3bf', false); }
        else { rect(-hw, -hd, hw, hd, plaza, false); rect(-45, -30, 45, 30, N ? '#4a4f5a' : '#e4e1da'); for (const a of [-1, 1]) for (const b of [-1, 1]) rect(a * 40 - 6, b * 40 - 6, a * 40 + 6, b * 40 + 6, '#d2452f'); rect(-8, -8, 8, 8, '#d2452f', false); }
        break;
      case 'pagoda': rect(-hw, -hd, hw, hd, plaza, false); rect(-77, -32, -23, -12, '#6f6d6a'); rect(-77, 2, -23, 22, '#6f6d6a'); poly(ngon(30, 0, 11, 8, Math.PI / 8), '#cfa96b'); break;
      case 'minaret': rect(-hw, -hd, hw, hd, plaza, false); rect(-40, -20, 2, 18, '#9aa7ad'); poly(ngon(22, 0, 5, 12), '#e2dccd'); break;
      case 'tower': rect(-18, -13, 18, 13, '#b5402f'); break;
      case 'church': rect(-hw, -hd, hw, hd, plaza, false); rect(-50, -16, 20, 16, '#9a9890'); rect(20, -17, 32, -5, '#7a786f'); rect(20, 5, 32, 17, '#7a786f'); break;
      case 'colonial':
        rect(-hw, -hd, hw, hd, lm.w > 500 ? (N ? '#22382a' : '#d8e8c8') : plaza, false);
        if (lm.w > 500) { for (let r = 0; r < 2; r++) for (let k = 0; k < 9; k++) { if (r === 1 && k === 0) continue; const u0 = -hw + 40 + k * (lm.w - 140) / 9, v0 = [-80, 50][r]; rect(u0, v0, u0 + 52, v0 + 46, '#e6c98a'); } rect(-hw + 10, 95, -hw + 150, 140, N ? '#5a6070' : '#f4f4f0'); }
        else { rect(-60, -60, 60, -44, '#d9cfbb'); rect(-60, 44, 60, 60, '#d9cfbb'); rect(-60, -44, -44, 44, '#d9cfbb'); rect(44, -44, 60, 44, '#d9cfbb'); }
        break;
      case 'traditional': case 'temple': rect(-hw, -hd, hw, hd, plaza, false); rect(-hw + 4, -hd + 4, hw - 4, hd - 4, null); break;
      case 'rail':
        rect(-hw, -hd, hw, hd, plaza, false);
        if (lm.w > 500) { for (let k = 0; k < 5; k++) rect(-hw + 40, -120 + k * 34, hw - 40, -102 + k * 34, N ? '#30363f' : '#c9cbd0', false); rect(-170, 60, 170, 110, N ? '#4a5263' : '#dcdde3'); }
        else rect(-hw + 20, -hd + 30, hw - 20, hd - 50, N ? '#4a5263' : '#dcdde3');
        break;
      case 'expo': rect(-hw, -hd, hw, hd, plaza, false); for (let r = 0; r < 3; r++) { const v0 = -hd + 70 + r * (lm.d - 140) / 3; rect(-hw + 60, v0, hw - 60, v0 + (lm.d - 140) / 3 - 50, N ? '#3a4a5c' : '#d4e1ec'); } break;
      case 'skyscraper':
        rect(-hw, -hd, hw, hd, plaza, false);
        if (lm.style === 'citic') { rect(-100, -100, 100, 100, N ? '#3a4152' : '#e2e0db'); rect(-24, -60, 24, -12, N ? '#4a6080' : '#c6d6e2'); }
        else rect(-hw * 0.9, -hd * 0.9, hw * 0.9, hd * 0.9, N ? '#4a6080' : '#c6d6e2');
        break;
      case 'opera': rect(-hw, -hd, hw, hd, plaza, false); poly(ngon(-30, 0, 62, 7, 0.2, 48), N ? '#4c525e' : '#dcdcd8'); poly(ngon(62, 38, 32, 6, 0.6, 25), N ? '#4c525e' : '#dcdcd8'); break;
      case 'box': rect(-hw, -hd, hw, hd, plaza, false); rect(-58, -58, 58, 58, N ? '#40424a' : '#8e8e94'); break;
      case 'concert': poly([T(-58, -26), T(56, -38), T(48, 36), T(-52, 30)], N ? '#5a6474' : '#eef0f2'); break;
      case 'gallery': poly(ngon(0, 0, 46, 5, -Math.PI / 2), N ? '#4a5262' : '#f4f4f2'); break;
      default: rect(-hw * 0.8, -hd * 0.8, hw * 0.8, hd * 0.8, bld);
    }
    ctx.restore();
  };

  // ---------------- 地面分块与整城底图 ----------------
  Renderer.prototype.renderGroundChunk = function (lvl, ci, cj, reuse) {
    const C = 512 / lvl, x0 = ci * C, y0 = cj * C, n = 512 + 2;
    const cv = reuse && reuse.width === n && reuse.height === n ? reuse : makeCanvas(n, n);
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, n, n);
    ctx.setTransform(lvl, 0, 0, lvl, -x0 * lvl + 1, -y0 * lvl + 1);
    this.drawGround(ctx, x0 - 1 / lvl, y0 - 1 / lvl, x0 + C + 1 / lvl, y0 + C + 1 / lvl, lvl);
    return cv;
  };
  Renderer.prototype.renderOverview = function () {
    const lvl = 4, cv = makeCanvas(CFG.W * lvl, CFG.H * lvl), ctx = cv.getContext('2d');
    ctx.fillStyle = S.GROUND.land; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = S.GROUND.water;
    const city = this.game.city;
    for (let c = 0; c < city.N; c++) if (city.lu[c] === LU.WATER) ctx.fillRect((c % city.W) * lvl, ((c / city.W) | 0) * lvl, lvl, lvl);
    this.overview = cv; this.overviewStale = false; this.overviewAt = performance.now();
    this.overviewJob = { cv: cv, row: 0, version: city.version };
  };
  Renderer.prototype.stepOverview = function () {
    const job = this.overviewJob;
    if (!job) return;
    const y0 = job.row, y1 = Math.min(CFG.H, y0 + 4), ctx = job.cv.getContext('2d');
    ctx.save(); ctx.setTransform(4, 0, 0, 4, 0, 0); ctx.beginPath(); ctx.rect(0, y0, CFG.W, y1 - y0); ctx.clip();
    this.drawGround(ctx, 0, y0, CFG.W, y1, 4); ctx.restore();
    job.row = y1;
    if (y1 >= CFG.H) { this.overviewJob = null; this.overviewAt = performance.now(); this.overviewStale = job.version !== this.game.city.version; }
  };
})(window.CM);
