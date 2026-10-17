'use strict';
// 城市：地形、区域、土地利用、人口与就业、道路网络（格网顶点 + 边）及城市发展
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA;
  const LU = { RURAL: 0, RES: 1, COM: 2, IND: 3, MIX: 4, PARK: 5, INST: 6, WATER: 7, HILL: 8, AIRPORT: 9, LANDMARK: 10 };
  CM.LU = LU;
  CM.LU_NAME = ['农村/待开发', '住宅', '商业办公', '工业仓储', '混合功能', '公园绿地', '学校与机构', '水域', '山地风景区', '机场', '历史地标'];
  const PLAN_KEYS = { RES: LU.RES, COM: LU.COM, IND: LU.IND, MIX: LU.MIX, INST: LU.INST };
  const CELL_KM2 = 0.0625;

  function City() {
    this.W = CFG.W; this.H = CFG.H; this.N = this.W * this.H;
    this.VW = this.W + 1; this.VH = this.H + 1; this.V = this.VW * this.VH;
    this.version = 0; this.roadVersion = 0;
    this.dirty = new Set();
  }
  CM.City = City;

  City.prototype.idx = function (i, j) { return j * this.W + i; };
  City.prototype.cellAt = function (x, y) {
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return -1;
    return j * this.W + i;
  };
  City.prototype.zoneOf = function (c) {
    const Z = CFG.ZONE;
    const i = c % this.W, j = (c / this.W) | 0;
    return ((j / Z) | 0) * (this.W / Z) + ((i / Z) | 0);
  };

  // ---------------- 生成 ----------------
  const FS = 4;   // 水域、绿地栅格：每格 4×4 子像素（约 62 m）
  const BS = 8;   // 建筑避让栅格：每格 8×8 子像素（约 31 m）
  City.prototype.generate = function (seed, startYear) {
    const W = this.W, H = this.H, N = this.N;
    this.seed = seed;
    this.regions = D.regions.concat([D.defaultRegion]);
    this.regionOpen = new Uint8Array(this.regions.length);
    this.regionOpenDate = this.regions.map(function () { return null; });
    for (let k = 0; k < this.regions.length; k++) {
      const rg = this.regions[k];
      if (rg.open != null && rg.open <= startYear) { this.regionOpen[k] = 1; this.regionOpenDate[k] = [startYear, 1]; }
    }
    this.lu = new Uint8Array(N);
    this.plan = new Uint8Array(N);
    this.pop = new Float32Array(N);
    this.jobs = new Float32Array(N);
    this.bh = new Float32Array(N);
    this.street = new Uint8Array(N);
    this.protectedId = new Int16Array(N);
    this.taken = new Float32Array(N);
    this.urbanYear = new Uint16Array(N);
    this.isPark = new Uint8Array(N);
    this.landmarkOn = new Uint8Array(D.landmarks.length);
    this.buildTerrain();

    // 规划用地
    const airportK = this.regions.findIndex(function (r) { return r.id === 'airport'; });
    for (let c = 0; c < N; c++) {
      const i = c % W, j = (c / W) | 0, cx = i + 0.5, cy = j + 0.5;
      const rg = this.regions[this.region[c]];
      if (this.waterD[c] < 0 && this.landFrac[c] < 0.5) { this.plan[c] = LU.WATER; this.lu[c] = LU.WATER; continue; }
      if (rg.scenic) { this.plan[c] = LU.HILL; this.lu[c] = LU.HILL; continue; }
      const planName = rg.plan || 'res';
      const dist = D.plans[planName];
      const r = U.hash2(i, j, seed + 7);
      let acc = 0, pick = LU.RES;
      for (const key in dist) { acc += dist[key]; if (r <= acc) { pick = PLAN_KEYS[key]; break; } }
      // 地块成片：用低频噪声让同类用地聚集
      const nz = U.noise2(cx * 0.22, cy * 0.22, seed + 11);
      if (planName !== 'cbd' && nz > 0.72 && dist.COM) pick = LU.COM;
      else if (nz < 0.18 && dist.IND) pick = LU.IND;
      this.plan[c] = pick;
      this.lu[c] = LU.RURAL;
      if (this.parkCov[c] >= 0.45) { this.plan[c] = LU.PARK; this.lu[c] = LU.PARK; this.isPark[c] = 1; }
      else if (this.region[c] === airportK && startYear < D.airport.closeYear) this.lu[c] = LU.AIRPORT;
    }
    this.activateLandmarks(startYear);

    // 1990 年人口与就业（估算）
    let sumP = 0, sumJ = 0;
    for (let c = 0; c < N; c++) {
      const L = this.lu[c];
      if (L === LU.WATER || L === LU.HILL || L === LU.PARK || L === LU.AIRPORT) continue;
      const i = c % W, j = (c / W) | 0, cx = i + 0.5, cy = j + 0.5;
      let p = D.rural.pop, jb = D.rural.jobs;
      for (const ct of D.centers) {
        const d = U.dist(cx, cy, ct.x, ct.y) / (ct.r * 4);
        const w = Math.exp(-d * d);
        p += ct.pop * w; jb += ct.jobs * w;
      }
      p *= 0.7 + 0.6 * U.fbm(cx * 0.3, cy * 0.3, seed + 3);
      jb *= 0.65 + 0.7 * U.hash2(i, j, seed + 5);
      // 林地与未开放区域人口较少
      p *= 1 - 0.6 * this.wood[c]; jb *= 1 - 0.6 * this.wood[c];
      const urban = p + jb > 2600;
      if (urban && L !== LU.LANDMARK) {
        this.lu[c] = this.plan[c];
        const f = luSplit(this.lu[c]);
        p *= f[0]; jb *= f[1];
        this.street[c] = 1; this.urbanYear[c] = startYear;
      }
      if (L === LU.LANDMARK) { const lm = D.landmarks[this.protectedId[c] - 1]; if (lm && lm.kind === 'campus') { p *= 0.5; } else { p = 0; jb *= 0.3; } this.street[c] = 1; }
      const lf = this.landFrac[c];
      this.pop[c] = p * CELL_KM2 * lf; this.jobs[c] = jb * CELL_KM2 * lf;
      sumP += this.pop[c]; sumJ += this.jobs[c];
    }
    const tP = U.interp(CFG.growth.popCurve, startYear), tJ = tP * U.interp(CFG.growth.jobsRatio, startYear);
    for (let c = 0; c < N; c++) { this.pop[c] *= tP / sumP; this.jobs[c] *= tJ / sumJ; }
    for (let c = 0; c < N; c++) this.bh[c] = this.heightFor(c, startYear);

    // 道路格网顶点（规则方格；真实道路在其上近似通行，绘制使用真实线形）
    this.vx = new Float32Array(this.V); this.vy = new Float32Array(this.V);
    for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) { const v = j * this.VW + i; this.vx[v] = i; this.vy[v] = j; }

    // 道路格网
    const nH = (H + 1) * W, nV = H * (W + 1), nD = H * W;
    this.nE = [nH, nV, nD, nD];
    this.eOff = [0, nH, nH + nV, nH + nV + nD];
    const nTot = nH + nV + 2 * nD;
    this.eArt = new Uint8Array(nTot);   // 规划道路等级
    this.eName = new Uint16Array(nTot);
    this.eCls = new Uint8Array(nTot);   // 最终等级
    this.eBlock = new Uint8Array(nTot); // 跨水
    for (let e = 0; e < nTot; e++) {
      const uv = this.edgeVerts(e);
      const ax = uv[0] % this.VW, ay = (uv[0] / this.VW) | 0, bx = uv[1] % this.VW, by = (uv[1] / this.VW) | 0;
      let b = this.waterDistAt((ax + bx) / 2, (ay + by) / 2) < 0.08 ? 1 : 0;
      if (!b && this.crossesRiver(ax, ay, bx, by)) b = 1;
      this.eBlock[e] = b;
    }
    this.buildRoadGroups();
    this.applyRoads(startYear);
    this.updateStreets();
    this.buildGraphs();
    this.version++;
  };

  function luSplit(L) {
    switch (L) {
      case LU.RES: return [1.25, 0.35];
      case LU.COM: return [0.35, 1.6];
      case LU.IND: return [0.25, 1.35];
      case LU.INST: return [0.55, 0.9];
      default: return [1, 1];
    }
  }

  // 真实地理：水域、绿地、林地、区域（确定性，不随存档保存）
  City.prototype.buildTerrain = function () {
    const Geo = CM.Geo.init(), W = this.W, H = this.H, N = this.N;
    const FW = W * FS, FH = H * FS;
    this.FS = FS; this.FW = FW; this.FH = FH;
    // 水域：值为水体序号（面 1…，线 30001…）
    const wm = new Uint16Array(FW * FH);
    Geo.fill(wm, FW, FH, FS, Geo.water, function (f, i) { return i + 1; });
    Geo.waterLines.forEach(function (l, i) { Geo.stroke(wm, FW, FH, FS, l.p, Math.max(l.w / 2, 0.025), 30001 + i); });
    this.wmask = wm;
    this.wsdf = Geo.sdf(wm, FW, FH);
    const wcov = Geo.coverage(wm, FW, FS, W, H);
    this.landFrac = new Float32Array(N); this.waterD = new Float32Array(N);
    for (let c = 0; c < N; c++) { this.landFrac[c] = 1 - wcov[c]; this.waterD[c] = this.waterDistAt(c % W + 0.5, ((c / W) | 0) + 0.5); }
    // 公园与林地覆盖率
    const pm = new Uint8Array(FW * FH);
    Geo.fill(pm, FW, FH, FS, Geo.parks);
    this.parkCov = Geo.coverage(pm, FW, FS, W, H);
    const wd = new Uint8Array(FW * FH);
    Geo.fill(wd, FW, FH, FS, Geo.woods);
    Geo.fill(wd, FW, FH, FS, Geo.reserves);
    this.wood = Geo.coverage(wd, FW, FS, W, H);
    // 区域：风景区（真实保护区/公园范围）→ 街道 → 所属区 → 外围
    const self = this, regions = this.regions, NONE = 255;
    const rr = new Uint8Array(N).fill(NONE);
    const fillCells = function (feats, k) {
      if (!feats.length) return;
      const tmp = new Uint8Array(N);
      Geo.fill(tmp, W, H, 1, feats);
      for (let c = 0; c < N; c++) if (tmp[c] && rr[c] === NONE) rr[c] = k;
    };
    const streetOf = new Map(), distOf = new Map();
    regions.forEach(function (rg, k) {
      if (rg.geo) {
        const list = rg.geo.reserve ? Geo.reserves.filter(function (f) { return f.name === rg.geo.reserve; }) : Geo.parks.filter(function (f) { return f.name === rg.geo.park; });
        fillCells(list, k);
      }
      for (const s of rg.streets || []) if (!streetOf.has(s)) streetOf.set(s, k);
      for (const s of rg.district || []) if (!distOf.has(s)) distOf.set(s, k);
    });
    for (const f of Geo.admin) if (f.level === 8 && streetOf.has(f.name)) fillCells([f], streetOf.get(f.name));
    for (const f of Geo.admin) if (f.level === 6 && distOf.has(f.name)) fillCells([f], distOf.get(f.name));
    const def = regions.length - 1;
    this.region = new Uint8Array(N);
    for (let c = 0; c < N; c++) this.region[c] = rr[c] === NONE ? def : rr[c];
    // 区域中心（标注与定位用）与范围
    const sx = new Float64Array(regions.length), sy = new Float64Array(regions.length), sn = new Float64Array(regions.length);
    const bb = regions.map(function () { return [1e9, 1e9, -1e9, -1e9]; });
    for (let c = 0; c < N; c++) {
      if (this.landFrac[c] < 0.5) continue;
      const k = this.region[c], i = c % W, j = (c / W) | 0;
      sx[k] += i + 0.5; sy[k] += j + 0.5; sn[k]++;
      const b = bb[k]; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (i + 1 > b[2]) b[2] = i + 1; if (j + 1 > b[3]) b[3] = j + 1;
    }
    regions.forEach(function (rg, k) {
      // 标注点取离质心最近的本区域格，避免落在别的区域上
      let cx = sn[k] ? sx[k] / sn[k] : W / 2, cy = sn[k] ? sy[k] / sn[k] : H / 2;
      let best = 1e9, bx = cx, by = cy;
      for (let c = 0; c < N; c++) if (self.region[c] === k && self.landFrac[c] >= 0.5) { const d = U.dist(c % W + 0.5, ((c / W) | 0) + 0.5, cx, cy); if (d < best) { best = d; bx = c % W + 0.5; by = ((c / W) | 0) + 0.5; } }
      rg.cx = bx; rg.cy = by; rg.bbox = bb[k]; rg.cells = sn[k];
    });
    const ak = regions.findIndex(function (r) { return r.id === 'airport'; });
    this.airportBox = ak >= 0 && sn[ak] ? regions[ak].bbox : null;
    // 区名标注位置：所列街道的质心
    this.districtLabels = (D.districtLabels || []).map(function (dl) {
      const feats = Geo.admin.filter(function (f) { return dl[1].indexOf(f.name) >= 0; });
      if (!feats.length) return null;
      const tmp = new Uint8Array(N); Geo.fill(tmp, W, H, 1, feats);
      let x = 0, y = 0, n = 0;
      for (let c = 0; c < N; c++) if (tmp[c] && self.landFrac[c] >= 0.5) { x += c % W + 0.5; y += ((c / W) | 0) + 0.5; n++; }
      return n ? [dl[0], x / n, y / n] : null;
    }).filter(Boolean);
    // 建筑避让栅格：水域、道路、铁路处不放建筑（1 支路，2 干道/铁路，3 水域）
    const BW = W * BS, BH = H * BS;
    this.BS = BS; this.BW = BW; this.BH = BH;
    const bm = new Uint8Array(BW * BH);
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) if (wm[((y >> 1) * FW) + (x >> 1)]) bm[y * BW + x] = 3;
    const free = function (v) { return v === 0; }, notWater = function (v) { return v < 2; };
    for (const s of Geo.streets) Geo.stroke(bm, BW, BH, BS, s.p, 0.035, 1, free);
    for (const r of Geo.rail) if (!(r.flags & 2)) Geo.stroke(bm, BW, BH, BS, r.p, 0.07, 2, notWater);
    this.bmask = bm;
  };

  // 有符号水域距离（格）：陆地为正，水面为负
  City.prototype.waterDistAt = function (x, y) {
    const S = this.FS, FW = this.FW, FH = this.FH, d = this.wsdf;
    let fx = x * S - 0.5, fy = y * S - 0.5;
    if (fx < 0) fx = 0; if (fy < 0) fy = 0; if (fx > FW - 1.001) fx = FW - 1.001; if (fy > FH - 1.001) fy = FH - 1.001;
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * FW + i;
    const a = d[k] * (1 - u) + d[k + 1] * u, b = d[k + FW] * (1 - u) + d[k + FW + 1] * u;
    return (a * (1 - v) + b * v) / S;
  };
  City.prototype.waterAt = function (x, y) {
    const i = Math.floor(x * this.FS), j = Math.floor(y * this.FS);
    if (i < 0 || j < 0 || i >= this.FW || j >= this.FH) return 0;
    return this.wmask[j * this.FW + i];
  };
  City.prototype.crossesRiver = function (ax, ay, bx, by) {
    const L = U.dist(ax, ay, bx, by), n = Math.max(1, Math.ceil(L * this.FS));
    for (let k = 0; k <= n; k++) { const t = k / n; if (this.waterAt(ax + (bx - ax) * t, ay + (by - ay) * t)) return true; }
    return false;
  };
  City.prototype.riverNameAt = function (x, y) {
    const Geo = CM.Geo;
    for (let r = 0; r <= 8; r++) {
      for (let a = 0; a < (r ? 16 : 1); a++) {
        const t = a / 16 * Math.PI * 2, id = this.waterAt(x + Math.cos(t) * r / this.FS, y + Math.sin(t) * r / this.FS);
        if (!id) continue;
        const f = id > 30000 ? Geo.waterLines[id - 30001] : Geo.water[id - 1];
        if (f && f.name) return f.name;
        if (f) return '珠江';
      }
    }
    return '珠江';
  };

  // 地标场地：旋转矩形（米）内的格
  City.prototype.landmarkCells = function (lm) {
    const out = [], hw = lm.w / 2 / CFG.CELL_M, hd = lm.d / 2 / CFG.CELL_M, a = (lm.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const R = Math.hypot(hw, hd) + 1;
    for (let j = Math.floor(lm.y - R); j <= Math.ceil(lm.y + R); j++) for (let i = Math.floor(lm.x - R); i <= Math.ceil(lm.x + R); i++) {
      if (i < 0 || j < 0 || i >= this.W || j >= this.H) continue;
      const dx = i + 0.5 - lm.x, dy = j + 0.5 - lm.y, u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (Math.abs(u) <= hw + 0.15 && Math.abs(v) <= hd + 0.15) out.push(j * this.W + i);
    }
    const c0 = this.cellAt(lm.x, lm.y);
    if (c0 >= 0 && out.indexOf(c0) < 0) out.push(c0);
    return out;
  };
  // 点是否在地标的真实场地范围内（不含格的粗略误差）
  City.prototype.inLandmarkSite = function (k, x, y) {
    const lm = D.landmarks[k]; if (!lm) return false;
    const a = (lm.rot || 0) * Math.PI / 180, dx = x - lm.x, dy = y - lm.y;
    const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(u) <= lm.w / 2 / CFG.CELL_M && Math.abs(v) <= lm.d / 2 / CFG.CELL_M;
  };
  City.prototype.activateLandmarks = function (year) {
    let changed = false;
    for (let k = 0; k < D.landmarks.length; k++) {
      const lm = D.landmarks[k];
      if (this.landmarkOn[k] || lm.year > year) continue;
      this.landmarkOn[k] = 1; changed = true;
      for (const c of this.landmarkCells(lm)) {
        if (this.lu[c] === LU.WATER) continue;
        this.protectedId[c] = k + 1;
        // 校园：保留为学校与机构用地（照常生成校舍与人口），只受保护
        if (lm.kind === 'campus') { this.lu[c] = LU.INST; this.plan[c] = LU.INST; this.street[c] = 1; this.dirty.add(c); continue; }
        this.lu[c] = LU.LANDMARK;
        this.pop[c] = 0; this.jobs[c] = Math.min(this.jobs[c], 300);
        this.street[c] = 1;
        this.dirty.add(c);
      }
    }
    return changed;
  };

  // ---------------- 道路 ----------------
  City.prototype.edgeVerts = function (e) {
    const W = this.W, VW = this.VW;
    if (e < this.eOff[1]) { const j = (e / W) | 0, i = e % W; return [j * VW + i, j * VW + i + 1]; }
    if (e < this.eOff[2]) { const k = e - this.eOff[1]; const j = (k / VW) | 0, i = k % VW; return [j * VW + i, (j + 1) * VW + i]; }
    if (e < this.eOff[3]) { const k = e - this.eOff[2]; const j = (k / W) | 0, i = k % W; return [j * VW + i, (j + 1) * VW + i + 1]; }
    const k = e - this.eOff[3]; const j = (k / W) | 0, i = k % W; return [j * VW + i + 1, (j + 1) * VW + i];
  };
  // 两相邻顶点之间的边编号
  City.prototype.edgeBetween = function (i, j, ni, nj) {
    const W = this.W, VW = this.VW;
    if (nj === j) return this.eOff[0] + j * W + Math.min(i, ni);
    if (ni === i) return this.eOff[1] + Math.min(j, nj) * VW + i;
    const ci = Math.min(i, ni), cj = Math.min(j, nj);
    if ((ni - i) * (nj - j) > 0) return this.eOff[2] + cj * W + ci;
    return this.eOff[3] + cj * W + ci;
  };
  // 真实道路分组：同名同级道路为一组（桥梁、隧道单独成组），并确定通车年份
  City.prototype.buildRoadGroups = function () {
    const Geo = CM.Geo, self = this;
    const groups = [], byKey = new Map();
    const yearOfName = function (name, flags, p) {
      if (!name) return null;
      if (D.roadYears[name] != null) return D.roadYears[name];
      if (flags & 3) for (const k in D.bridgeYears) if (name.indexOf(k) >= 0) return D.bridgeYears[k];
      let best = null, bl = 0;
      for (const k in D.roadYears) if (k.length > bl && name.indexOf(k) === 0) { best = D.roadYears[k]; bl = k.length; }
      return best;
    };
    Geo.roads.forEach(function (r) {
      const link = (r.flags & 4) !== 0;
      const key = r.name && !link ? r.name + '|' + r.cls + '|' + (r.flags & 3) : null;
      let g = key ? byKey.get(key) : null;
      if (!g) {
        g = { name: r.name, cls: r.cls, flags: r.flags & 7, ways: [], bbox: [1e9, 1e9, -1e9, -1e9], year: null, notable: false };
        groups.push(g); if (key) byKey.set(key, g);
      }
      g.ways.push(r.p);
      const b = g.bbox; b[0] = Math.min(b[0], r.bbox[0]); b[1] = Math.min(b[1], r.bbox[1]); b[2] = Math.max(b[2], r.bbox[2]); b[3] = Math.max(b[3], r.bbox[3]);
    });
    for (const sr of D.simRoads || []) {
      const p = new Float32Array([].concat.apply([], sr.p));
      groups.push({ name: sr.n, cls: sr.c, flags: 0, ways: [p], bbox: [Math.min.apply(null, sr.p.map(function (q) { return q[0]; })), Math.min.apply(null, sr.p.map(function (q) { return q[1]; })), Math.max.apply(null, sr.p.map(function (q) { return q[0]; })), Math.max.apply(null, sr.p.map(function (q) { return q[1]; }))], year: sr.y, notable: true, sim: true });
    }
    // 年份：名称表 → 跨江桥梁默认 → 所在区域开放年份
    for (const g of groups) {
      if (g.sim) continue;
      const y = yearOfName(g.name, g.flags, g.ways[0]);
      // 只为名称与年份表完全一致的道路/桥梁播报通车（匝道、辅路、出入口不单独播报；已有历史事件的不重复）
      if (y != null) { g.year = y; g.notable = y > 1990 && !(g.flags & 4) && (D.roadYears[g.name] != null || D.bridgeYears[g.name] != null) && !D.events.some(function (e) { return e.title.indexOf(g.name) >= 0; }); continue; }
      let water = 0;
      if (g.flags & 3) for (const p of g.ways) for (let k = 0; k + 3 < p.length; k += 2) if (self.crossesRiver(p[k], p[k + 1], p[k + 2], p[k + 3])) water++;
      if (water >= 2 && (g.flags & 3)) { g.year = D.bridgeDefaultYear; continue; }
      const p = g.ways[0], m = (p.length / 4 | 0) * 2;
      const c = self.cellAt(p[m], p[m + 1]);
      const rg = c >= 0 ? self.regions[self.region[c]] : D.defaultRegion;
      g.year = rg.scenic || rg.open == null ? 1990 : Math.max(1990, rg.open);
    }
    this.roadGroups = groups;
    this.roadWays = [];
    groups.forEach(function (g, gi) { for (const p of g.ways) self.roadWays.push({ g: gi, p: p, bbox: CM.Geo.bbox(p) }); });
    this.roadWayBk = CM.Geo.buckets(this.roadWays, 4, this.W, this.H);
    this.roadNames = [''].concat(groups.map(function (g) { return g.name; }));
    this.roadsBuilt = new Uint8Array(groups.length);
  };
  City.prototype.applyRoads = function (year) {
    let changed = false;
    const groups = this.roadGroups, BW = this.BW, BH = this.BH, bm = this.bmask;
    const notWater = function (v) { return v < 3; };
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k];
      if (this.roadsBuilt[k] || g.year > year) continue;
      this.roadsBuilt[k] = 1; changed = true;
      // 建筑避让
      const hw = g.cls === 4 ? 0.1 : (g.cls === 3 ? 0.075 : 0.05);
      if (!(g.flags & 2)) for (const p of g.ways) Geo2().stroke(bm, BW, BH, BS, p, (g.flags & 4) ? 0.04 : hw, 2, notWater);
      // 车行格网：快速路与主干道（匝道除外）
      if (g.cls >= 3 && !(g.flags & 4)) {
        for (const p of g.ways) {
          for (let q = 0; q + 3 < p.length; q += 2) {
            let i = U.clamp(Math.round(p[q]), 0, this.W), j = U.clamp(Math.round(p[q + 1]), 0, this.H);
            const i1 = U.clamp(Math.round(p[q + 2]), 0, this.W), j1 = U.clamp(Math.round(p[q + 3]), 0, this.H);
            const dx = Math.abs(i1 - i), dy = Math.abs(j1 - j), sx = i < i1 ? 1 : -1, sy = j < j1 ? 1 : -1;
            let err = dx - dy, guard = 0;
            while ((i !== i1 || j !== j1) && guard++ < 1000) {
              const e2 = 2 * err; let ni = i, nj = j;
              if (e2 > -dy) { err -= dy; ni += sx; }
              if (e2 < dx) { err += dx; nj += sy; }
              const e = this.edgeBetween(i, j, ni, nj);
              if (g.cls > this.eArt[e] || (g.cls === this.eArt[e] && g.name && !this.eName[e])) { this.eArt[e] = g.cls; this.eName[e] = k + 1; }
              i = ni; j = nj;
            }
          }
        }
      }
      // 道路沿线的格重新绘制
      const b = g.bbox;
      if (year > CFG.START.y || this.version > 0) for (let jj = Math.max(0, Math.floor(b[1])); jj <= Math.min(this.H - 1, Math.floor(b[3])); jj++) for (let ii = Math.max(0, Math.floor(b[0])); ii <= Math.min(this.W - 1, Math.floor(b[2])); ii++) this.dirty.add(jj * this.W + ii);
    }
    if (changed) this.version++;
    return changed;
  };
  function Geo2() { return CM.Geo; }
  // 根据街区开发情况生成支路与次干道（系统建设）
  City.prototype.updateStreets = function () {
    const W = this.W, H = this.H, Z = CFG.ZONE, st = this.street;
    const cls = this.eCls;
    cls.set(this.eArt);
    const hasSt = function (i, j) { return i >= 0 && j >= 0 && i < W && j < H && st[j * W + i] === 1; };
    // 横向边 (i,j)-(i+1,j)：相邻格 (i,j-1) 与 (i,j)
    for (let j = 0; j <= H; j++) {
      for (let i = 0; i < W; i++) {
        const e = this.eOff[0] + j * W + i;
        if (this.eBlock[e]) continue;
        if (hasSt(i, j - 1) || hasSt(i, j)) {
          const want = (j % Z === 0) ? 2 : 1;
          if (cls[e] < want) cls[e] = want;
        }
      }
    }
    for (let j = 0; j < H; j++) {
      for (let i = 0; i <= W; i++) {
        const e = this.eOff[1] + j * this.VW + i;
        if (this.eBlock[e]) continue;
        if (hasSt(i - 1, j) || hasSt(i, j)) {
          const want = (i % Z === 0) ? 2 : 1;
          if (cls[e] < want) cls[e] = want;
        }
      }
    }
  };

  // 构建步行图（CSR）与汽车图（收缩后的路段 + 小区连接线）
  City.prototype.buildGraphs = function () {
    const V = this.V, VW = this.VW, nTot = this.eCls.length;
    const vx = this.vx, vy = this.vy, CM_ = CFG.CELL_M;
    // ---- 步行 ----
    const wDeg = new Int32Array(V + 1);
    const walkable = new Uint8Array(nTot);
    for (let e = 0; e < nTot; e++) {
      const c = this.eCls[e];
      if (c < 1 || c === 4) continue;
      if (this.eBlock[e] && c < 3) continue;
      walkable[e] = 1;
      const uv = this.edgeVerts(e); wDeg[uv[0]]++; wDeg[uv[1]]++;
    }
    const wStart = new Int32Array(V + 1);
    for (let v = 0; v < V; v++) wStart[v + 1] = wStart[v] + wDeg[v];
    const wTo = new Int32Array(wStart[V]), wLen = new Float32Array(wStart[V]);
    const fill = new Int32Array(V);
    for (let e = 0; e < nTot; e++) {
      if (!walkable[e]) continue;
      const uv = this.edgeVerts(e), a = uv[0], b = uv[1];
      const L = U.dist(vx[a], vy[a], vx[b], vy[b]) * CM_;
      wTo[wStart[a] + fill[a]] = b; wLen[wStart[a] + fill[a]] = L; fill[a]++;
      wTo[wStart[b] + fill[b]] = a; wLen[wStart[b] + fill[b]] = L; fill[b]++;
    }
    this.walk = { start: wStart, to: wTo, len: wLen, deg: wDeg };

    // ---- 汽车 ----
    const cDeg = new Int32Array(V);
    const carE = [];
    for (let e = 0; e < nTot; e++) {
      const c = this.eCls[e];
      if (c < 2) continue;
      if (this.eBlock[e] && c < 3) continue;
      carE.push(e);
      const uv = this.edgeVerts(e); cDeg[uv[0]]++; cDeg[uv[1]]++;
    }
    const cStart = new Int32Array(V + 1);
    for (let v = 0; v < V; v++) cStart[v + 1] = cStart[v] + cDeg[v];
    const cEdge = new Int32Array(cStart[V]);
    const cf = new Int32Array(V);
    for (const e of carE) {
      const uv = this.edgeVerts(e);
      cEdge[cStart[uv[0]] + cf[uv[0]]++] = e;
      cEdge[cStart[uv[1]] + cf[uv[1]]++] = e;
    }
    const forced = new Uint8Array(V);
    for (let v = 0; v < V; v++) {
      const d = cDeg[v];
      if (d === 0) continue;
      if (d !== 2) { forced[v] = 1; continue; }
      const e1 = cEdge[cStart[v]], e2 = cEdge[cStart[v] + 1];
      if (this.eCls[e1] !== this.eCls[e2] || this.eName[e1] !== this.eName[e2]) forced[v] = 1;
    }
    // 小区连接点
    const Z = CFG.ZONE, ZW = this.W / Z, ZH = this.H / Z;
    const zoneCand = [];
    for (let zj = 0; zj < ZH; zj++) {
      for (let zi = 0; zi < ZW; zi++) {
        const cx = zi * Z + Z / 2, cy = zj * Z + Z / 2;
        const cand = [];
        for (let rad = 1; rad <= 9 && cand.length === 0; rad += (rad < 3 ? 2 : 3)) {
          for (let j = Math.max(0, zj * Z - rad); j <= Math.min(this.H, zj * Z + Z + rad); j++) {
            for (let i = Math.max(0, zi * Z - rad); i <= Math.min(this.W, zi * Z + Z + rad); i++) {
              const v = j * VW + i;
              if (cDeg[v] > 0) cand.push([v, U.dist(vx[v], vy[v], cx, cy)]);
            }
          }
        }
        cand.sort(function (a, b) { return a[1] - b[1]; });
        const pick = [];
        for (const cnd of cand) {
          if (pick.length >= 3) break;
          let ok = true;
          for (const p of pick) if (U.dist(vx[p[0]], vy[p[0]], vx[cnd[0]], vy[cnd[0]]) < 1.6) ok = false;
          if (ok) pick.push(cnd);
        }
        for (const p of pick) forced[p[0]] = 1;
        zoneCand.push(pick);
      }
    }
    // 收缩路段
    const visited = new Uint8Array(nTot);
    const links = [];
    const self = this;
    function walkChain(s, e0) {
      const verts = [s];
      let cur = s, e = e0, lenM = 0, bridge = 0, guard = 0;
      for (;;) {
        visited[e] = 1;
        const uv = self.edgeVerts(e);
        const nxt = uv[0] === cur ? uv[1] : uv[0];
        lenM += U.dist(vx[cur], vy[cur], vx[nxt], vy[nxt]) * CM_;
        if (self.eBlock[e]) bridge = 1;
        verts.push(nxt);
        if (forced[nxt] || guard++ > 5000) break;
        let ne = -1;
        for (let k = cStart[nxt]; k < cStart[nxt + 1]; k++) if (cEdge[k] !== e) { ne = cEdge[k]; break; }
        if (ne < 0 || visited[ne]) break;
        cur = nxt; e = ne;
      }
      links.push({ verts: verts, lenM: lenM, cls: self.eCls[e0], name: self.eName[e0], bridge: bridge });
    }
    for (let v = 0; v < V; v++) {
      if (!forced[v]) continue;
      for (let k = cStart[v]; k < cStart[v + 1]; k++) if (!visited[cEdge[k]]) walkChain(v, cEdge[k]);
    }
    for (const e of carE) if (!visited[e]) { const uv = this.edgeVerts(e); forced[uv[0]] = 1; walkChain(uv[0], e); }

    // 节点编号
    const vertNode = new Int32Array(V).fill(-1);
    const nodeVert = [];
    const nodeOf = function (v) { if (vertNode[v] < 0) { vertNode[v] = nodeVert.length; nodeVert.push(v); } return vertNode[v]; };
    for (const L of links) { L.a = nodeOf(L.verts[0]); L.b = nodeOf(L.verts[L.verts.length - 1]); }
    const nN = nodeVert.length, nA = links.length * 2;
    const arcFrom = new Int32Array(nA), arcTo = new Int32Array(nA), arcLen = new Float32Array(nA), arcCap = new Float32Array(nA), arcT0 = new Float32Array(nA);
    const outDeg = new Int32Array(nN + 1);
    for (let k = 0; k < links.length; k++) {
      const L = links[k];
      L.id = k;
      L.key = Math.min(L.verts[0], L.verts[L.verts.length - 1]) + '_' + Math.max(L.verts[0], L.verts[L.verts.length - 1]) + '_' + L.verts.length;
      const cap = CFG.road.cap[L.cls] * (L.bridge ? 0.75 : 1);
      const t0 = L.lenM / (CFG.road.speed[L.cls] * 1000 / 60);
      arcFrom[2 * k] = L.a; arcTo[2 * k] = L.b; arcFrom[2 * k + 1] = L.b; arcTo[2 * k + 1] = L.a;
      arcLen[2 * k] = arcLen[2 * k + 1] = L.lenM;
      arcCap[2 * k] = arcCap[2 * k + 1] = cap;
      arcT0[2 * k] = arcT0[2 * k + 1] = Math.max(0.05, t0);
      outDeg[L.a]++; outDeg[L.b]++;
      // 几何
      let pts = L.verts.map(function (v) { return [vx[v], vy[v]]; });
      // 贴合真实道路线形（车辆沿真实道路行驶）；无法贴合的格网连接线只参与模拟、不显示车辆
      const real = L.name ? this.snapToRoad(L.name, pts) : null;
      if (real) { pts = real; L.real = true; }
      else if (L.cls >= 3 && pts.length > 2) pts = U.chaikin(pts, 2);
      L.pts = pts; L.cum = U.cumLen(pts);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      L.bbox = [x0, y0, x1, y1];
    }
    const outStart = new Int32Array(nN + 1);
    for (let n = 0; n < nN; n++) outStart[n + 1] = outStart[n] + outDeg[n];
    const outArc = new Int32Array(nA);
    const of = new Int32Array(nN);
    for (let a = 0; a < nA; a++) { const f = arcFrom[a]; outArc[outStart[f] + of[f]++] = a; }
    const zoneConn = zoneCand.map(function (pick) {
      return pick.map(function (p) {
        const m = p[1] * CM_;
        return { node: vertNode[p[0]], t: m / 250 + 1.0, km: m / 1000 };
      }).filter(function (c) { return c.node >= 0; });
    });
    this.car = { nN: nN, nA: nA, nodeVert: nodeVert, vertNode: vertNode, arcFrom: arcFrom, arcTo: arcTo, arcLen: arcLen, arcCap: arcCap, arcT0: arcT0, outStart: outStart, outArc: outArc, links: links, zoneConn: zoneConn };

    // 主干道旁的格（用于新区沿路开发）
    this.nearArt = new Uint8Array(this.N);
    for (let e = 0; e < nTot; e++) {
      if (this.eCls[e] < 3) continue;
      const uv = this.edgeVerts(e);
      for (const v of uv) {
        const i = v % VW, j = (v / VW) | 0;
        for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
          const ci = i + di, cj = j + dj;
          if (ci >= 0 && cj >= 0 && ci < this.W && cj < this.H) this.nearArt[cj * this.W + ci] = 1;
        }
      }
    }
    this.roadVersion++;
  };

  // 把格网路段投影到所属真实道路上，取两端投影点之间的真实折线
  function projPoly(p, x, y) {
    let best = { d: 1e9, k: 0, t: 0, s: 0 }, acc = 0;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], dx = p[k + 2] - ax, dy = p[k + 3] - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
      let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0; t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const qx = ax + dx * t - x, qy = ay + dy * t - y, d = Math.sqrt(qx * qx + qy * qy);
      if (d < best.d) best = { d: d, k: k / 2, t: t, s: acc + L * t, x: ax + dx * t, y: ay + dy * t };
      acc += L;
    }
    return best;
  }
  City.prototype.snapToRoad = function (name, pts) {
    const g = this.roadGroups[name - 1]; if (!g) return null;
    const a = pts[0], b = pts[pts.length - 1];
    let latLen = 0; for (let k = 1; k < pts.length; k++) latLen += U.dist(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    let best = null, bd = 1.5;
    for (const p of g.ways) {
      const A = projPoly(p, a[0], a[1]); if (A.d > 0.8) continue;
      const B = projPoly(p, b[0], b[1]); if (B.d > 0.8) continue;
      const len = Math.abs(B.s - A.s);
      if (len < latLen * 0.35 || len > latLen * 2.5 + 0.5) continue;
      if (A.d + B.d < bd) { bd = A.d + B.d; best = [p, A, B]; }
    }
    if (!best) return null;
    const p = best[0], A = best[1], B = best[2], out = [[A.x, A.y]];
    if (A.s <= B.s) { for (let k = A.k + 1; k <= B.k; k++) out.push([p[2 * k], p[2 * k + 1]]); }
    else { for (let k = A.k; k > B.k; k--) out.push([p[2 * k], p[2 * k + 1]]); }
    out.push([B.x, B.y]);
    return out.length >= 2 ? out : null;
  };

  // ---------------- 建筑高度 ----------------
  City.prototype.heightFor = function (c, year) {
    const L = this.lu[c];
    const pd = this.pop[c] / CELL_KM2, jd = this.jobs[c] / CELL_KM2;
    const hsh = U.hash2(c, 7, this.seed);
    let h = 0, cap = 400;
    const era = year < 1995 ? 0 : (year < 2005 ? 1 : 2);
    switch (L) {
      case LU.RES: h = 6 + 0.0011 * pd + 0.0004 * jd; cap = [21, 75, 150][era]; break;
      case LU.MIX: h = 8 + 0.0009 * (pd + jd); cap = [25, 90, 170][era]; break;
      case LU.COM: h = 10 + 0.0016 * jd + 0.0005 * pd; cap = [48, 180, 380][era]; break;
      case LU.IND: h = 7 + 0.00025 * jd; cap = 26; break;
      case LU.INST: h = 10 + 0.0003 * (pd + jd); cap = 45; break;
      case LU.RURAL: h = (pd + jd) > 300 ? 5 : 0; cap = 8; break;
      default: return 0;
    }
    return Math.min(cap, h) * (0.8 + 0.4 * hsh);
  };

  // ---------------- 区域 ----------------
  City.prototype.regionAt = function (x, y) { const c = this.cellAt(x, y); return c < 0 ? null : this.regions[this.region[c]]; };
  City.prototype.openRegion = function (k, y, m) {
    if (this.regionOpen[k]) return false;
    this.regionOpen[k] = 1; this.regionOpenDate[k] = [y, m];
    for (let c = 0; c < this.N; c++) if (this.region[c] === k) this.dirty.add(c);
    this.version++;
    return true;
  };
  City.prototype.closeAirport = function () {
    let n = 0;
    for (let c = 0; c < this.N; c++) {
      if (this.lu[c] === LU.AIRPORT) { this.lu[c] = LU.RURAL; this.dirty.add(c); n++; }
    }
    if (n) this.version++;
  };

  City.prototype.totals = function () {
    let p = 0, j = 0;
    for (let c = 0; c < this.N; c++) { p += this.pop[c]; j += this.jobs[c]; }
    return { pop: p, jobs: j };
  };

  // ---------------- 城市发展（每月） ----------------
  // ctx: { year, monthIndex, zoneAccess (Float32Array 0..1), cellWalk (Float32Array m), rng }
  City.prototype.growMonth = function (ctx) {
    const N = this.N, W = this.W, year = ctx.year;
    const tot = this.totals();
    const boost = 1 + CFG.growth.metroBoostMax * U.clamp((ctx.coverage || 0) / 0.5, 0, 1);
    const target = U.interp(CFG.growth.popCurve, year + 1 / 12) * boost;
    const targetNow = U.interp(CFG.growth.popCurve, year) * boost;
    let dP = (target - targetNow) + 0.04 * (targetNow - tot.pop);
    dP = Math.max(dP, -0.002 * tot.pop);
    const tJ = target * U.interp(CFG.growth.jobsRatio, year + 1 / 12);
    let dJ = (tJ - tot.jobs) * 0.12 + Math.max(0, dP) * U.interp(CFG.growth.jobsRatio, year) * 0.3;
    dJ = Math.max(dJ, -0.002 * tot.jobs);
    const eraMul = year < 2000 ? 0.8 : (year < 2010 ? 0.8 + 0.2 * (year - 2000) / 10 : Math.min(1.15, 1 + 0.15 * (year - 2010) / 20));
    const wR = new Float32Array(N), wJ = new Float32Array(N), capR = new Float32Array(N), capJ = new Float32Array(N);
    let sR = 0, sJ = 0;
    const mi = ctx.monthIndex;
    for (let c = 0; c < N; c++) {
      const L = this.lu[c];
      if (L === LU.WATER || L === LU.HILL || L === LU.PARK || L === LU.AIRPORT || L === LU.LANDMARK) continue;
      if (!this.regionOpen[this.region[c]]) continue;
      const lf = this.landFrac[c] * (1 - this.taken[c]);
      if (lf <= 0.05) continue;
      const P = L === LU.RURAL ? this.plan[c] : L;
      const cr = resCap(P) * eraMul * lf, cj = jobCap(P, this.regions[this.region[c]].plan) * eraMul * lf;
      capR[c] = cr; capJ[c] = cj;
      const i = c % W, j = (c / W) | 0;
      let nb = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < W && jj < this.H && this.street[jj * W + ii]) nb++;
      }
      nb /= 8;
      const walk = ctx.cellWalk ? ctx.cellWalk[c] : Infinity;
      const st = walk < 500 ? 1 : (walk < 850 ? 0.55 : (walk < 1125 ? 0.22 : 0));
      const acc = ctx.zoneAccess ? ctx.zoneAccess[this.zoneOf(c)] : 0.3;
      let seed = 1;
      if (!this.street[c]) {
        if (nb < 0.2 && st === 0 && !this.nearArt[c]) continue;
        seed = 0.35 + (this.nearArt[c] ? 0.3 : 0);
      }
      const rnd = 0.6 + 0.8 * U.hash2(c, mi, this.seed + 31);
      const remR = cr - this.pop[c], remJ = cj - this.jobs[c];
      if (remR > 0) { wR[c] = remR * (0.25 + acc) * (1 + 1.6 * st) * (0.3 + nb) * rnd * seed; sR += wR[c]; }
      if (remJ > 0) {
        const comBoost = (P === LU.COM || P === LU.MIX) ? 2.0 : 1;
        wJ[c] = remJ * (0.2 + acc * 1.2) * (1 + 1.6 * st * comBoost) * (0.3 + nb) * rnd * seed; sJ += wJ[c];
      }
    }
    const changed = [];
    const add = (arr, cap, w, s, d) => {
      if (d > 0 && s > 0) {
        let left = d;
        for (let pass = 0; pass < 2 && left > 1; pass++) {
          const k = left / s; let used = 0, s2 = 0;
          for (let c = 0; c < N; c++) {
            if (w[c] <= 0) continue;
            const room = cap[c] - arr[c];
            const inc = Math.min(room, w[c] * k, Math.max(60, cap[c] * 0.05));
            if (inc > 0) { arr[c] += inc; used += inc; changed.push(c); }
            if (cap[c] - arr[c] > 1) s2 += w[c]; else w[c] = 0;
          }
          left -= used; s = s2;
          if (s <= 0) break;
        }
      } else if (d < 0) {
        let tot2 = 0; for (let c = 0; c < N; c++) tot2 += arr[c];
        const f = 1 + d / Math.max(1, tot2);
        for (let c = 0; c < N; c++) arr[c] *= f;
      }
    };
    add(this.pop, capR, wR, sR, dP);
    add(this.jobs, capJ, wJ, sJ, dJ);
    let newUrban = 0, streetsChanged = false;
    const seen = new Set();
    for (const c of changed) {
      if (seen.has(c)) continue; seen.add(c);
      if (!this.street[c] && this.pop[c] + this.jobs[c] > 160) {
        this.street[c] = 1; this.urbanYear[c] = Math.floor(year);
        if (this.lu[c] === LU.RURAL) this.lu[c] = this.plan[c] === LU.PARK ? LU.RES : this.plan[c];
        newUrban++; streetsChanged = true; this.dirty.add(c);
      }
      const nh = this.heightFor(c, year);
      if (nh > this.bh[c] * 1.12 + 1) { this.bh[c] = nh; this.dirty.add(c); }
    }
    if (streetsChanged) { this.updateStreets(); }
    if (changed.length) this.version++;
    return { dPop: dP, dJobs: dJ, newUrban: newUrban, streetsChanged: streetsChanged };
  };
  function resCap(L) {
    switch (L) { case LU.RES: return 3000; case LU.MIX: return 2200; case LU.COM: return 600; case LU.IND: return 160; case LU.INST: return 700; default: return 300; }
  }
  function jobCap(L, plan) {
    switch (L) {
      case LU.COM: return plan === 'cbd' ? 12500 : 8000;
      case LU.MIX: return 3500; case LU.IND: return 1900; case LU.INST: return 1600; case LU.RES: return 450; default: return 150;
    }
  }

  // 地铁设施拆迁：按比例减少用地
  City.prototype.demolish = function (c, frac) {
    if (c < 0 || frac <= 0) return;
    const f = U.clamp(frac, 0, 1 - this.taken[c]);
    if (f <= 0) return;
    const keep = 1 - f / Math.max(0.05, 1 - this.taken[c]);
    this.pop[c] *= keep; this.jobs[c] *= keep;
    this.taken[c] += f;
    this.dirty.add(c);
    this.version++;
  };

  // ---------------- 存档 ----------------
  City.prototype.serialize = function () {
    return {
      seed: this.seed,
      pop: U.packTyped(this.pop, 'f32'), jobs: U.packTyped(this.jobs, 'f32'), bh: U.packTyped(this.bh, 'f32'),
      taken: U.packTyped(this.taken, 'f32'), lu: U.packTyped(this.lu, 'u8'), street: U.packTyped(this.street, 'u8'),
      urbanYear: U.packTyped(this.urbanYear, 'u16'),
      regionOpen: Array.from(this.regionOpen), regionOpenDate: this.regionOpenDate,
      landmarkOn: Array.from(this.landmarkOn),
    };
  };
  City.prototype.restore = function (s, year) {
    const N = this.N;
    const chk = function (a, n) { if (a.length !== n) throw new Error('城市数据尺寸不符'); return a; };
    this.pop = chk(U.unpackTyped(s.pop), N); this.jobs = chk(U.unpackTyped(s.jobs), N); this.bh = chk(U.unpackTyped(s.bh), N);
    this.taken = chk(U.unpackTyped(s.taken), N); this.lu = chk(U.unpackTyped(s.lu), N); this.street = chk(U.unpackTyped(s.street), N);
    this.urbanYear = chk(U.unpackTyped(s.urbanYear), N);
    this.regionOpen = Uint8Array.from(s.regionOpen); this.regionOpenDate = s.regionOpenDate;
    this.landmarkOn = new Uint8Array(D.landmarks.length);
    this.protectedId.fill(0);
    const on = s.landmarkOn || [];
    for (let k = 0; k < D.landmarks.length; k++) {
      if (!on[k]) continue;
      this.landmarkOn[k] = 1;
      for (const c of this.landmarkCells(D.landmarks[k])) if (this.lu[c] === LU.LANDMARK || (D.landmarks[k].kind === 'campus' && this.lu[c] !== LU.WATER)) this.protectedId[c] = k + 1;
    }
    this.eArt.fill(0); this.eName.fill(0); this.roadsBuilt.fill(0);
    this.applyRoads(year);
    this.updateStreets();
    this.buildGraphs();
    this.version++;
    for (let c = 0; c < N; c++) this.dirty.add(c);
  };
})(window.CM);
