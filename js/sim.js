'use strict';
// 交通模拟：小区出行需求（重力模型）→ 步行接驳与地铁路径 → 汽车/地铁方式选择（Logit）→ 道路分配与拥堵（BPR + MSA）
// 地铁运力按客流自动调整；所有计算分时段进行，并以时间切片方式运行，保证画面流畅。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const NP = 4;
  const INF = 1e30;

  // Keep the hot shortest-path loop outside the yielding orchestration. This is
  // the same binary heap, relaxation order and numeric precision as before.
  function roadTree(road, rd, time, origin, work, heap) {
    const dist = work.dist, dkm = work.dkm, pred = work.pred, order = work.order;
    const start = rd.start, node = rd.nodes, initial = rd.times, km = rd.km;
    const outStart = road.outStart, outArc = road.outArc, arcTo = road.arcTo, arcKm = rd.arcKm;
    dist.fill(INF); heap.clear();
    // Each directed arc can relax once after its source is settled. Reserve the
    // queue once, then keep its size local to avoid millions of property writes.
    const keys = work.heapK || (work.heapK = new Array(road.nA + 4).fill(0.1));
    const values = work.heapV || (work.heapV = new Array(road.nA + 4).fill(0));
    let count = 0;
    for (let k = start[origin]; k < start[origin + 1]; k++) {
      const v = node[k], t = initial[k];
      if (t < dist[v]) {
        dist[v] = t; dkm[v] = km[k]; pred[v] = -1;
        let i = count++;
        while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= t) break; keys[i] = keys[p]; values[i] = values[p]; i = p; }
        keys[i] = t; values[i] = v;
      }
    }
    let no = 0;
    while (count) {
      const u = values[0], du = keys[0], n = --count;
      heap.lastKey = du;
      if (n > 0) {
        const key = keys[n], val = values[n];
        let i = 0;
        for (;;) {
          const left = i * 2 + 1; if (left >= n) break;
          const right = left + 1, child = right < n && keys[right] < keys[left] ? right : left;
          if (keys[child] >= key) break;
          keys[i] = keys[child]; values[i] = values[child]; i = child;
        }
        keys[i] = key; values[i] = val;
      }
      if (du > dist[u]) continue;
      order[no++] = u;
      for (let k = outStart[u]; k < outStart[u + 1]; k++) {
        const a = outArc[k], v = arcTo[a], nd = du + time[a];
        if (nd < dist[v]) {
          dist[v] = nd; dkm[v] = dkm[u] + arcKm[a]; pred[v] = a;
          let i = count++;
          while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= nd) break; keys[i] = keys[p]; values[i] = values[p]; i = p; }
          keys[i] = nd; values[i] = v;
        }
      }
    }
    return no;
  }

  function Model(city) {
    this.city = city;
    this.ZW = CFG.W / CFG.ZONE; this.ZH = CFG.H / CFG.ZONE; this.Z = this.ZW * this.ZH;
    this.BW = Math.ceil(this.ZW / 2); this.BH = Math.ceil(this.ZH / 2); this.B = this.BW * this.BH;
    const prof = CFG.hourProfile.slice(); const s = prof.reduce(function (a, b) { return a + b; }, 0);
    this.profile = prof.map(function (v) { return v / s; });
    this.hourPeriod = new Int8Array(24);
    this.pHours = []; this.pMean = [];
    const self = this;
    CFG.periods.forEach(function (pd, p) {
      pd.hours.forEach(function (h) { self.hourPeriod[h] = p; });
      self.pHours.push(pd.hours.length);
      self.pMean.push(pd.hours.reduce(function (a, h) { return a + self.profile[h]; }, 0) / pd.hours.length);
    });
    this.year = CFG.START.y;
    this.fare = Object.assign({}, CFG.fareDefault);
    this.heap = new U.Heap(8192);
    this.zoneCells = [];
    const Z = CFG.ZONE;
    for (let z = 0; z < this.Z; z++) {
      const zi = z % this.ZW, zj = (z / this.ZW) | 0, arr = [];
      for (let j = zj * Z; j < zj * Z + Z; j++) for (let i = zi * Z; i < zi * Z + Z; i++) arr.push(j * CFG.W + i);
      this.zoneCells.push(Int32Array.from(arr));
    }
    this.zPop = new Float32Array(this.Z); this.zJobs = new Float32Array(this.Z); this.zAttr = new Float32Array(this.Z);
    this.zCx = new Float32Array(this.Z); this.zCy = new Float32Array(this.Z);
    this.road = city.car; this.roadVer = city.roadVersion;
    this.prepareRoad();
    this.arcZone = null; this.computeArcZones();
    this.buildZones(); this.buildDemand();
    this.net = null;
    this.live = this.newCtx(4);
    this.gen = null; this.predJob = null;
    this.liveBuf = {}; this.predBuf = {};
    this.cycles = 0; this.sinceChange = 0; this.version = 0;
    this.daily = null;
  }
  CM.Model = Model;

  Model.prototype.wake = function () { this.settled = false; this.quietCycles = 0; this.gen = null; };
  Model.prototype.setYear = function (y) { if (this.year !== y) this.wake(); this.year = y; this.capF = U.interp(CFG.road.capGrowth, y); };
  // 当前通行能力（含系统道路改造增长）
  Model.prototype.cap = function (a) { return this.road.arcCap[a] * (this.capF || 1); };
  Model.prototype.params = function () {
    const c = CFG.choice, y = this.year;
    return {
      vot: U.interp(c.vot, y), cpk: U.interp(c.carCostPerKm, y), park: U.interp(c.parking, y), occ: U.interp(c.occupancy, y),
      theta: c.theta, walkW: c.walkW, waitW: c.waitW, tpen: c.transferPen, opn: c.outTransferPen, carAccess: c.carAccess,
    };
  };
  // 全网统一票价：与乘车里程无关，换乘不另收费
  Model.prototype.fareFor = function () { return this.fare.flat; };

  // ---------------- 小区与需求 ----------------
  Model.prototype.buildZones = function () {
    const city = this.city, LU = CM.LU;
    for (let z = 0; z < this.Z; z++) {
      let p = 0, j = 0, a = 0, sx = 0, sy = 0, sw = 0;
      for (const c of this.zoneCells[z]) {
        const pc = city.pop[c], jc = city.jobs[c];
        p += pc; j += jc;
        const L = city.lu[c];
        a += jc * ((L === LU.COM || L === LU.MIX) ? 1.0 : (L === LU.INST ? 0.8 : 0.35)) + pc * 0.22;
        const w = pc + jc;
        sx += w * ((c % CFG.W) + 0.5); sy += w * (((c / CFG.W) | 0) + 0.5); sw += w;
      }
      this.zPop[z] = p; this.zJobs[z] = j; this.zAttr[z] = a;
      const zi = z % this.ZW, zj = (z / this.ZW) | 0;
      this.zCx[z] = sw > 1 ? sx / sw : zi * CFG.ZONE + CFG.ZONE / 2;
      this.zCy[z] = sw > 1 ? sy / sw : zj * CFG.ZONE + CFG.ZONE / 2;
    }
  };
  Model.prototype.buildDemand = function () {
    const g = this.buildDemandGen();
    while (!g.next().done) { /* run */ }
  };
  // 时间切片版本：每 16 个起点让出一次；结果在最后一次性替换 this.od
  Model.prototype.buildDemandGen = function* () {
    const Z = this.Z, y = this.year, c = CFG.choice;
    const L1 = U.interp(c.distDecayHW, y), L2 = U.interp(c.distDecayHO, y);
    const wr = U.interp(c.workerRate, y), hr = U.interp(c.hoRate, y);
    const kmPerCell = CFG.CELL_M / 1000 * 1.2;
    const dests = [], hw = [], ho = [], start = [0];
    const w1 = new Float64Array(Z), w2 = new Float64Array(Z), scores = new Float64Array(Z);
    const cand = [];
    let totHW = 0, totHO = 0;
    for (let i = 0; i < Z; i++) {
      if (i > 0 && (i & 15) === 0) yield;
      const P = this.zPop[i];
      if (P < 20) { start.push(dests.length); continue; }
      let s1 = 0, s2 = 0;
      for (let j = 0; j < Z; j++) {
        if (j === i) { w1[j] = 0; w2[j] = 0; continue; }
        const J = this.zJobs[j], A = this.zAttr[j];
        if (J < 5 && A < 5) { w1[j] = 0; w2[j] = 0; continue; }
        const d = U.dist(this.zCx[i], this.zCy[i], this.zCx[j], this.zCy[j]) * kmPerCell;
        w1[j] = J * Math.exp(-d / L1); w2[j] = A * Math.exp(-d / L2);
        s1 += w1[j]; s2 += w2[j];
      }
      if (s1 <= 0 && s2 <= 0) { start.push(dests.length); continue; }
      cand.length = 0;
      for (let j = 0; j < Z; j++) {
        const sh = (s1 > 0 ? w1[j] / s1 : 0) + (s2 > 0 ? w2[j] / s2 : 0);
        if (sh > 0.003) { scores[j] = sh; cand.push(j); }
      }
      cand.sort(function (a, b) { return scores[b] - scores[a]; });
      if (cand.length > 240) cand.length = 240;
      let k1 = 0, k2 = 0;
      for (const cd of cand) { k1 += w1[cd]; k2 += w2[cd]; }
      const W = P * wr, O = P * hr;
      for (const cd of cand) {
        const j = cd;
        dests.push(j);
        const a = k1 > 0 ? W * w1[j] / k1 : 0, b = k2 > 0 ? O * w2[j] / k2 : 0;
        hw.push(a); ho.push(b); totHW += a; totHO += b;
      }
      start.push(dests.length);
    }
    this.od = { start: Int32Array.from(start), dest: Int32Array.from(dests), hw: Float32Array.from(hw), ho: Float32Array.from(ho), totHW: totHW, totHO: totHO };
    this.version++;
  };
  // 分步版本（月度处理中使用，避免单帧长时间停顿）。进行期间暂停实时求解与预测（见 step），
  // 使其不会读到新旧混合的小区/需求/路网状态；计算结果与一次性执行相同。
  Model.prototype.refreshCityGen = function* (C) {
    this.refreshing = true;
    try {
      this.buildZones();
      yield* this.buildDemandGen();
      if (this.city.roadVersion !== this.roadVer) { this.syncRoad(); yield; }
      if (this.net || C) this.setNetwork(C || this.net.C, true); // 步行网络与覆盖随城市变化重算
      this.gen = null;
    } finally {
      this.refreshing = false;
    }
  };

  // ---------------- 道路网络同步 ----------------
  Model.prototype.computeArcZones = function () {
    const road = this.road, city = this.city;
    const az = new Int16Array(road.nA);
    for (const L of road.links) {
      const m = L.pts[Math.floor(L.pts.length / 2)];
      const c = city.cellAt(m[0], m[1]);
      const z = c < 0 ? 0 : city.zoneOf(c);
      az[2 * L.id] = z; az[2 * L.id + 1] = z;
    }
    this.arcZone = az;
  };
  // Immutable road topology in a compact layout; keep connection order and Float64 costs.
  Model.prototype.prepareRoad = function () {
    const road = this.road, start = new Int32Array(this.Z + 1), zones = [], nodes = [], times = [], km = [];
    for (let z = 0; z < this.Z; z++) {
      const list = road.zoneConn[z] || [];
      if (list.length) zones.push(z);
      for (const c of list) { nodes.push(c.node); times.push(c.t); km.push(c.km); }
      start[z + 1] = nodes.length;
    }
    this.roadData = { start: start, zones: Int32Array.from(zones), nodes: Int32Array.from(nodes), times: Float64Array.from(times), km: Float64Array.from(km), arcKm: Float64Array.from(road.arcLen, function (v) { return v / 1000; }), uniqueKeys: new Set(road.links.map(function (L) { return L.key; })).size === road.links.length };
  };
  Model.prototype.syncRoad = function () {
    this.wake();
    const old = this.road, nw = this.city.car;
    // Preserve legacy state remapping even for identical graphs with duplicate link keys.
    if (old === nw && this.roadData.uniqueKeys) { this.roadVer = this.city.roadVersion; this.version++; return; }
    const map = new Map();
    old.links.forEach(function (L) { map.set(L.key, L); });
    const remap = function (arr, fillFn) {
      const out = new Float32Array(nw.nA);
      for (const L of nw.links) {
        const o = map.get(L.key);
        for (let d = 0; d < 2; d++) {
          const a = 2 * L.id + d;
          if (o) {
            const sameDir = o.verts[0] === L.verts[0];
            out[a] = arr[2 * o.id + (sameDir ? d : 1 - d)];
          } else out[a] = fillFn(a);
        }
      }
      return out;
    };
    for (const ctx of [this.live]) {
      for (const P of ctx.per) {
        if (!P) continue;
        P.arcVol = remap(P.arcVol, function () { return 0; });
        P.arcTime = remap(P.arcTime, function (a) { return nw.arcT0[a]; });
      }
    }
    this.road = nw; this.roadVer = this.city.roadVersion;
    this.prepareRoad();
    this.computeArcZones();
    this.version++;
  };

  // ---------------- 地铁网络与步行接驳 ----------------
  Model.prototype.computeAccess = function (C) {
    const city = this.city, walk = city.walk, VW = city.VW, N = C.stations.length;
    const maxM = CFG.walk.maxAccessM, xferM = CFG.walk.transferMaxM, extra = CFG.walk.cellExtraM, mpm = CFG.walk.mPerMin;
    const nC = city.N;
    const cellWalk = new Float32Array(nC).fill(Infinity), cellStation = new Int32Array(nC).fill(-1);
    const dist = this._wdist || (this._wdist = new Float64Array(city.V).fill(INF));
    if (dist.length !== city.V) { this._wdist = new Float64Array(city.V).fill(INF); }
    const D_ = this._wdist;
    const pred = this._wpred || (this._wpred = new Int32Array(city.V));
    const touched = [];
    const heap = this.heap;
    const zMap = new Map();
    const trees = [], accessible = new Uint8Array(N), catchPop = new Float32Array(N), transfers = [];
    const limit = Math.max(maxM, xferM) + 200;
    const treeRules = maxM + ':' + xferM + ':' + CFG.CELL_M;
    if (this._treeWalk !== walk || this._treeRules !== treeRules) { this._treeWalk = walk; this._treeRules = treeRules; this._walkTrees = new Map(); }
    const treeCache = this._walkTrees;
    for (let k = 0; k < N; k++) {
      const st = C.stations[k];
      trees.push(null);
      const c0 = city.cellAt(st.x, st.y);
      if (c0 < 0) continue;
      const ci = c0 % city.W, cj = (c0 / city.W) | 0;
      heap.clear(); touched.length = 0;
      const treeKey = st.x + ':' + st.y;
      const cachedTree = treeCache.get(treeKey);
      if (cachedTree) {
        trees[k] = cachedTree.tree; accessible[k] = 1;
        for (let q = 0; q < cachedTree.tree.verts.length; q++) { const v = cachedTree.tree.verts[q]; touched.push(v); D_[v] = cachedTree.exact[q]; }
      } else {
        const corners = [cj * VW + ci, cj * VW + ci + 1, (cj + 1) * VW + ci, (cj + 1) * VW + ci + 1];
        for (const v of corners) {
          if (walk.deg[v] === 0) continue;
          const d0 = U.dist(st.x, st.y, city.vx[v], city.vy[v]) * CFG.CELL_M;
          if (d0 < D_[v]) { if (D_[v] >= INF) touched.push(v); D_[v] = d0; pred[v] = -1; heap.push(d0, v); }
        }
        if (!heap.n) continue;
        accessible[k] = 1;
        while (heap.n) {
          const u = heap.pop(), du = heap.lastKey;
          if (du > D_[u]) continue;
          for (let e = walk.start[u]; e < walk.start[u + 1]; e++) {
            const v = walk.to[e], nd = du + walk.len[e];
            if (nd < D_[v] && nd <= limit) {
              if (D_[v] >= INF) touched.push(v);
              D_[v] = nd; pred[v] = u; heap.push(nd, v);
            }
          }
        }
        // 行人路径树（未通车站也保留，用于详情中的“接入线路后的潜在覆盖”）
        const tv = Int32Array.from(touched), td = new Float32Array(tv.length), tp = new Int32Array(tv.length);
        for (let q = 0; q < tv.length; q++) { td[q] = D_[tv[q]]; tp[q] = pred[tv[q]]; }
        trees[k] = { verts: tv, dist: td, pred: tp };
        const exact = new Float64Array(tv.length);
        for (let q = 0; q < tv.length; q++) exact[q] = D_[tv[q]];
        if (treeCache.size >= 512) treeCache.clear();
        treeCache.set(treeKey, { tree: trees[k], exact: exact });
      }
      // 只有接入运营线路的车站提供服务：未通车站不计覆盖、不参与接驳与站外换乘
      if (C.serviced && !C.serviced[k]) { for (const v of touched) D_[v] = INF; continue; }
      // 覆盖格
      for (let j = Math.max(0, cj - 6); j <= Math.min(city.H - 1, cj + 6); j++) {
        for (let i = Math.max(0, ci - 6); i <= Math.min(city.W - 1, ci + 6); i++) {
          const v0 = j * VW + i;
          const cd = Math.min(D_[v0], D_[v0 + 1], D_[v0 + VW], D_[v0 + VW + 1]) + extra;
          if (cd > maxM) continue;
          const c = j * city.W + i;
          if (cd < cellWalk[c]) { cellWalk[c] = cd; cellStation[c] = k; }
          const w = city.pop[c] + city.jobs[c];
          if (w <= 0) continue;
          if (cd <= 750) catchPop[k] += city.pop[c];
          const z = city.zoneOf(c);
          let m = zMap.get(z); if (!m) { m = new Map(); zMap.set(z, m); }
          const e = m.get(k) || [0, 0]; e[0] += w; e[1] += w * cd; m.set(k, e);
        }
      }
      // 站外换乘
      for (let m2 = 0; m2 < N; m2++) {
        if (m2 === k || (C.serviced && !C.serviced[m2])) continue;
        const s2 = C.stations[m2];
        if (U.dist(st.x, st.y, s2.x, s2.y) * CFG.CELL_M > xferM + 150) continue;
        const c2 = city.cellAt(s2.x, s2.y); if (c2 < 0) continue;
        const i2 = c2 % city.W, j2 = (c2 / city.W) | 0;
        let best = INF;
        for (const v of [j2 * VW + i2, j2 * VW + i2 + 1, (j2 + 1) * VW + i2, (j2 + 1) * VW + i2 + 1]) {
          if (D_[v] >= INF) continue;
          const dd = D_[v] + U.dist(s2.x, s2.y, city.vx[v], city.vy[v]) * CFG.CELL_M;
          if (dd < best) best = dd;
        }
        if (best <= xferM) transfers.push({ a: k, b: m2, m: best });
      }
      for (const v of touched) D_[v] = INF;
    }
    // 小区接驳表
    const zl = new Array(this.Z).fill(null), zCov = new Float32Array(this.Z), zWalk = new Float32Array(this.Z);
    for (let z = 0; z < this.Z; z++) {
      let tot = 0, cov = 0, wsum = 0;
      for (const c of this.zoneCells[z]) {
        const w = city.pop[c] + city.jobs[c];
        tot += w;
        if (cellWalk[c] <= maxM) { cov += w; wsum += w * cellWalk[c]; }
      }
      zCov[z] = tot > 0 ? cov / tot : 0;
      zWalk[z] = cov > 0 ? wsum / cov / mpm : 0;
      const m = zMap.get(z);
      if (m && zCov[z] > 0) {
        const arr = [];
        m.forEach(function (e, s) { arr.push({ s: s, w: e[1] / e[0] / mpm, share: e[0] / Math.max(1, tot) }); });
        arr.sort(function (a, b) { return a.w - b.w; });
        zl[z] = arr.slice(0, 4);
      }
    }
    // 人口覆盖率
    let pc = 0, pt = 0;
    for (let c = 0; c < nC; c++) { pt += city.pop[c]; if (cellWalk[c] <= maxM) pc += city.pop[c]; }
    return { cellWalk: cellWalk, cellStation: cellStation, zl: zl, zCov: zCov, zWalk: zWalk, trees: trees, accessible: accessible, catchPop: catchPop, transfers: transfers, coverage: pt > 0 ? pc / pt : 0 };
  };

  Model.prototype.buildMetro = function (C) {
    const N = C.stations.length, R = C.routes.length, mc = CFG.metro;
    const acc = this.computeAccess(C);
    const platBase = new Int32Array(R);
    let nNodes = N;
    for (let r = 0; r < R; r++) { platBase[r] = nNodes; nNodes += C.routes[r].stIdx.length; }
    const E = { from: [], to: [], type: [], route: [], leg: [], dir: [], st: [], km: [], t0: [], wm: [] };
    const push = function (f, t, ty, r, leg, dir, st, km, t0, wm) {
      E.from.push(f); E.to.push(t); E.type.push(ty); E.route.push(r); E.leg.push(leg); E.dir.push(dir); E.st.push(st); E.km.push(km); E.t0.push(t0); E.wm.push(wm);
      return E.from.length - 1;
    };
    const rideEdge = [], boardEdge = [];
    for (let r = 0; r < R; r++) {
      const rt = C.routes[r], n = rt.stIdx.length;
      const be = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        be[k] = push(rt.stIdx[k], platBase[r] + k, 0, r, k, 0, rt.stIdx[k], 0, 0, 0);
        push(platBase[r] + k, rt.stIdx[k], 1, r, k, 0, rt.stIdx[k], 0, 0, 0);
      }
      const nLegs = rt.legSec.length;
      const re = new Int32Array(nLegs * 2);
      for (let k = 0; k < nLegs; k++) {
        const a = platBase[r] + k, b = platBase[r] + ((k + 1) % n);
        const t0 = rt.legSec[k] / 60 + mc.dwell / 60, km = rt.legLenM[k] / 1000;
        re[2 * k] = push(a, b, 2, r, k, 0, -1, km, t0, 0);
        re[2 * k + 1] = push(b, a, 2, r, k, 1, -1, km, t0, 0);
      }
      rideEdge.push(re); boardEdge.push(be);
    }
    for (const tr of acc.transfers) push(tr.a, tr.b, 3, -1, -1, 0, tr.b, 0, tr.m / CFG.walk.mPerMin, tr.m);
    const nE = E.from.length;
    const net = {
      C: C, N: N, R: R, nNodes: nNodes, nE: nE, platBase: platBase, acc: acc, rideEdge: rideEdge, boardEdge: boardEdge,
      eFrom: Int32Array.from(E.from), eTo: Int32Array.from(E.to), eType: Uint8Array.from(E.type), eRoute: Int32Array.from(E.route),
      eLeg: Int32Array.from(E.leg), eDir: Uint8Array.from(E.dir), eSt: Int32Array.from(E.st), eKm: Float32Array.from(E.km), eT0: Float32Array.from(E.t0), eWm: Float32Array.from(E.wm),
      routeKey: C.routes.map(function (r) { return r.lineId + ':' + r.stIds.join(','); }),
    };
    const deg = new Int32Array(nNodes + 1);
    for (let e = 0; e < nE; e++) deg[net.eFrom[e]]++;
    const os = new Int32Array(nNodes + 1);
    for (let n = 0; n < nNodes; n++) os[n + 1] = os[n] + deg[n];
    const oe = new Int32Array(nE), f = new Int32Array(nNodes);
    for (let e = 0; e < nE; e++) { const a = net.eFrom[e]; oe[os[a] + f[a]++] = e; }
    net.outStart = os; net.outEdge = oe;
    return net;
  };

  // ---------------- 运算上下文 ----------------
  Model.prototype.newCtx = function (nPer) {
    const ctx = { per: [], nPer: nPer };
    for (let p = 0; p < nPer; p++) ctx.per.push(this.makePer(this.net));
    return ctx;
  };
  Model.prototype.makePer = function (net) {
    const Z = this.Z, nA = this.road.nA;
    const P = {
      arcVol: new Float32Array(nA), arcTime: Float32Array.from(this.road.arcT0),
      skimT: new Float32Array(Z * Z), skimK: new Float32Array(Z * Z),
      desTot: new Float32Array(this.B * this.B), desMetro: new Float32Array(this.B * this.B),
      zTrips: new Float32Array(Z), zMetro: new Float32Array(Z), zAccess: new Float32Array(Z),
      stats: null, iters: 0,
    };
    this.initMetroPer(P, net, -1);
    return P;
  };
  Model.prototype.initMetroPer = function (P, net, p, old, oldNet) {
    const N = net ? net.N : 0, R = net ? net.R : 0, nE = net ? net.nE : 0;
    P.freq = new Float32Array(R); P.crowd = new Float32Array(nE).fill(1); P.load = new Float32Array(nE);
    P.stDelay = new Float32Array(N); P.stIn = new Float32Array(N); P.stOut = new Float32Array(N); P.stXfer = new Float32Array(N); P.stBoard = new Float32Array(N);
    for (let r = 0; r < R; r++) P.freq[r] = Model.serviceFloor(net.C.routes[r], p < 0 ? 1 : p);
    if (old && oldNet && net) {
      const keyIdx = new Map(); oldNet.routeKey.forEach(function (k, i) { keyIdx.set(k, i); });
      for (let r = 0; r < R; r++) {
        const o = keyIdx.get(net.routeKey[r]);
        if (o === undefined) continue;
        P.freq[r] = old.freq[o];
        const re = net.rideEdge[r], ore = oldNet.rideEdge[o];
        for (let q = 0; q < re.length && q < ore.length; q++) { P.load[re[q]] = old.load[ore[q]]; P.crowd[re[q]] = old.crowd[ore[q]]; }
        const be = net.boardEdge[r], obe = oldNet.boardEdge[o];
        for (let q = 0; q < be.length && q < obe.length; q++) P.load[be[q]] = old.load[obe[q]];
      }
      const sIdx = new Map(); oldNet.C.stations.forEach(function (s, i) { sIdx.set(s.id, i); });
      net.C.stations.forEach(function (s, i) {
        const o = sIdx.get(s.id); if (o === undefined) return;
        P.stIn[i] = old.stIn[o]; P.stOut[i] = old.stOut[o]; P.stXfer[i] = old.stXfer[o]; P.stBoard[i] = old.stBoard[o]; P.stDelay[i] = old.stDelay[o];
      });
    }
  };
  // 设置正式运营网络
  Model.prototype.setNetwork = function (C, keepState) {
    this.wake();
    const oldNet = this.net;
    const net = this.buildMetro(C);
    if (oldNet && (oldNet.N !== net.N || oldNet.nE !== net.nE || oldNet.nNodes !== net.nNodes)) { this.liveBuf = {}; this.predBuf = {}; }
    for (let p = 0; p < this.live.per.length; p++) {
      const P = this.live.per[p], old = { freq: P.freq, load: P.load, crowd: P.crowd, stIn: P.stIn, stOut: P.stOut, stXfer: P.stXfer, stBoard: P.stBoard, stDelay: P.stDelay };
      this.initMetroPer(P, net, p, old, oldNet);
    }
    this.net = net;
    this.gen = null;
    // 车站日客流（stDaily）按旧网络统计，到下一次 computeDaily 前与新网络的车站编号不对应
    if (!keepState || !this.stDaily || this.stDaily.inn.length !== net.N) this.dailyStale = true;
    if (!keepState) this.sinceChange = 0;
    this.version++;
  };

  // ---------------- 单时段迭代 ----------------
  Model.prototype.metroSkim = function* (net, P, p, prm, store) {
    const N = net.N, nn = net.nNodes, nE = net.nE, mc = CFG.metro;
    let work = store.work;
    if (!work || work.cost.length !== nE || work.dist.length !== nn) work = store.work = { cost: new Float32Array(nE), tAct: new Float32Array(nE), dist: new Float64Array(nn), dtm: new Float32Array(nn), dkm: new Float32Array(nn) };
    const cost = work.cost, tAct = work.tAct;
    cost.fill(0); tAct.fill(0);
    for (let e = 0; e < nE; e++) {
      const ty = net.eType[e];
      if (ty === 0) {
        const f = Math.max(0.5, P.freq[net.eRoute[e]]);
        const w = 60 / (2 * f);
        cost[e] = prm.waitW * w + prm.tpen + P.stDelay[net.eSt[e]];
        tAct[e] = w + P.stDelay[net.eSt[e]] * 0.5;
      } else if (ty === 2) {
        cost[e] = net.eT0[e] * P.crowd[e]; tAct[e] = net.eT0[e];
      } else if (ty === 3) {
        cost[e] = prm.walkW * net.eT0[e] + prm.opn; tAct[e] = net.eT0[e];
      }
    }
    const gt = store.gt, tm = store.tm, km = store.km;
    const pred = store.pred, order = store.order, nOrd = store.nOrd;
    const dist = work.dist, dtm = work.dtm, dkm = work.dkm;
    const heap = this.heap;
    for (let s = 0; s < N; s++) {
      dist.fill(INF);
      heap.clear();
      dist[s] = 0; dtm[s] = 0; dkm[s] = 0;
      const pb = s * nn;
      pred[pb + s] = -1;
      heap.push(0, s);
      let no = 0;
      while (heap.n) {
        const u = heap.pop(), du = heap.lastKey;
        if (du > dist[u]) continue;
        order[pb + no++] = u;
        for (let k = net.outStart[u]; k < net.outStart[u + 1]; k++) {
          const e = net.outEdge[k], v = net.eTo[e], nd = du + cost[e];
          if (nd < dist[v]) { dist[v] = nd; dtm[v] = dtm[u] + tAct[e]; dkm[v] = dkm[u] + net.eKm[e]; pred[pb + v] = e; heap.push(nd, v); }
        }
      }
      nOrd[s] = no;
      const ob = s * N;
      for (let t = 0; t < N; t++) {
        // 至少包含一段实际乘车（乘车里程 > 0）；只靠站外步行连通的路径不算地铁行程
        if (dist[t] >= INF || t === s || !(dkm[t] > 0)) { gt[ob + t] = INF; continue; }
        gt[ob + t] = dist[t] - prm.tpen; tm[ob + t] = dtm[t]; km[ob + t] = dkm[t];
      }
      if ((s & 3) === 3) yield;
    }
  };

  Model.prototype.allocSkimStore = function (net, buf) {
    const N = net.N, nn = net.nNodes;
    const st = buf.skim;
    if (st && st.N === N && st.nn === nn) return st;
    buf.skim = { N: N, nn: nn, gt: new Float32Array(N * N), tm: new Float32Array(N * N), km: new Float32Array(N * N), pred: new Int32Array(N * nn), order: new Int32Array(N * nn), nOrd: new Int32Array(N), D: new Float32Array(N * N) };
    return buf.skim;
  };

  // 一个时段的一次完整迭代（buf 为该求解流程独占的临时缓冲区）
  Model.prototype.iterate = function* (net, P, p, opts) {
    opts = opts || {};
    const buf = opts.buf || this.liveBuf;
    const prm = this.params();
    const Z = this.Z, od = this.od;
    const N = net ? net.N : 0;
    const sp = CFG.purposeSplit, hrs = this.pHours[p];
    const fHWo = sp.hwOut[p] / hrs, fHWr = sp.hwRet[p] / hrs, fHOo = sp.hoOut[p] / hrs, fHOr = sp.hoRet[p] / hrs;
    let store = null;
    const hasMetro = net && net.R > 0;
    let stable = P.iters > 0;
    if (hasMetro) { store = this.allocSkimStore(net, buf); yield* this.metroSkim(net, P, p, prm, store); store.D.fill(0); }
    // ---- 方式选择 ----
    if (!buf.carDem || buf.carDem.length !== Z * Z) buf.carDem = new Float32Array(Z * Z);
    if (!buf.hasCar || buf.hasCar.length !== Z) buf.hasCar = new Uint8Array(Z);
    const carDem = buf.carDem, hasCar = buf.hasCar;
    carDem.fill(0);
    hasCar.fill(0);
    const st = { trips: 0, metro: 0, car: 0, timeSum: 0, commTrips: 0, commTime: 0, fare: 0, metroPkm: 0, vkt: 0, carPkm: 0, congNum: 0, congDen: 0, crowdPkm: 0, metroTime: 0, carTime: 0 };
    const skT = P.skimT, skK = P.skimK;
    const acc = hasMetro ? net.acc : null;
    const kmPerCell = CFG.CELL_M / 1000;
    P.desTot.fill(0); P.desMetro.fill(0); P.zTrips.fill(0); P.zMetro.fill(0); P.zAccess.fill(0);
    const BW = this.BW, ZW = this.ZW;
    if (!this.zoneBlock) this.zoneBlock = Int32Array.from({ length: Z }, function (_, z) { return (((z / ZW) | 0) >> 1) * BW + ((z % ZW) >> 1); });
    const blocks = this.zoneBlock;
    // The same directed OD can appear in both purpose flows. Cache only the winning
    // access-pair indices within this iteration, never rounded costs or stale results.
    if (hasMetro && (!buf.choice || buf.choice.length !== Z * Z)) buf.choice = new Int8Array(Z * Z);
    const choices = hasMetro ? buf.choice : null;
    if (choices) choices.fill(-2);
    const self = this;
    const zJ = this.zJobs;
    const theta = prm.theta;
    const process = function (o, d, F, cw) {
      if (F <= 0) return;
      let ct = skT[o * Z + d], ck = skK[o * Z + d];
      if (!(ct > 0) || ct >= INF) { const straight = U.dist(self.zCx[o], self.zCy[o], self.zCx[d], self.zCy[d]) * kmPerCell * 1.3; ct = straight / 16 * 60 + 3; ck = straight; }
      const carMoney = ck * prm.cpk + prm.park;
      const gtCar = ct + prm.carAccess + carMoney / prm.vot * 60;
      let metro = 0, mTime = 0, fare = 0, mKm = 0, bs = -1, bt = -1;
      let gtBest = gtCar;
      if (acc) {
        const fo = acc.zCov[o], fd = acc.zCov[d];
        const lo = acc.zl[o], ld = acc.zl[d];
        if (fo > 0 && fd > 0 && lo && ld) {
          let best = INF, bw = 0;
          const pair = o * Z + d, cached = choices[pair];
          let winner = -1;
          if (cached >= 0) {
            const A = lo[cached >> 2], Bq = ld[cached & 3];
            bs = A.s; bt = Bq.s; bw = A.w + Bq.w;
            best = prm.walkW * bw + store.gt[bs * N + bt];
          } else if (cached === -2) for (let a = 0; a < lo.length; a++) {
            const A = lo[a], row = A.s * N;
            for (let b = 0; b < ld.length; b++) {
              const Bq = ld[b];
              if (A.s === Bq.s) continue;
              const g = store.gt[row + Bq.s];
              if (g >= INF) continue;
              const v = prm.walkW * (A.w + Bq.w) + g;
              if (v < best) { best = v; bs = A.s; bt = Bq.s; bw = A.w + Bq.w; winner = (a << 2) | b; }
            }
          }
          if (cached === -2) choices[pair] = winner;
          if (bs >= 0) {
            mKm = store.km[bs * N + bt];
            fare = self.fareFor(mKm);
            const gtM = best + fare / prm.vot * 60;
            const pM = 1 / (1 + Math.exp(theta * (gtM - gtCar)));
            metro = F * fo * fd * pM;
            mTime = bw + store.tm[bs * N + bt];
            if (gtM < gtBest) gtBest = gtM;
            if (metro > 0) store.D[bs * N + bt] += metro;
          }
        }
      }
      const car = F - metro;
      if (car > 0) { carDem[o * Z + d] += car / prm.occ; hasCar[o] = 1; }
      st.trips += F; st.metro += metro; st.car += car;
      const tCar = ct + prm.carAccess * 0.5;
      st.timeSum += car * tCar + metro * mTime;
      st.carTime += car * tCar; st.metroTime += metro * mTime;
      st.fare += metro * fare; st.metroPkm += metro * mKm; st.carPkm += car * ck; st.vkt += car / prm.occ * ck;
      if (cw > 0) { st.commTrips += F * cw; st.commTime += (car * tCar + metro * mTime) * cw; }
      P.zTrips[o] += F; P.zMetro[o] += metro;
      P.zAccess[o] += zJ[d] * Math.exp(-gtBest / 30);
      const key = blocks[o] * self.B + blocks[d];
      P.desTot[key] += F; P.desMetro[key] += metro;
    };
    let cnt = 0;
    for (let i = 0; i < Z; i++) {
      for (let k = od.start[i]; k < od.start[i + 1]; k++) {
        const j = od.dest[k], hw = od.hw[k], ho = od.ho[k];
        const F1 = hw * fHWo + ho * fHOo, F2 = hw * fHWr + ho * fHOr;
        process(i, j, F1, F1 > 0 ? hw * fHWo / F1 : 0);
        process(j, i, F2, F2 > 0 ? hw * fHWr / F2 : 0);
      }
      if ((++cnt & 7) === 0) yield;
    }
    // ---- 地铁客流加载与自动运营 ----
    if (hasMetro) {
      const nn = net.nNodes, nE = net.nE;
      let work = buf.metroLoad;
      if (!work || work.load.length !== nE || work.accN.length !== nn || work.stIn.length !== N) work = buf.metroLoad = { load: new Float32Array(nE), accN: new Float64Array(nn), stIn: new Float32Array(N), stOut: new Float32Array(N), stBoard: new Float32Array(N), walkIn: new Float32Array(N) };
      const load = work.load, accN = work.accN, stIn = work.stIn, stOut = work.stOut;
      load.fill(0); accN.fill(0); stIn.fill(0); stOut.fill(0);
      for (let s = 0; s < N; s++) {
        const row = s * N;
        let any = false;
        for (let t = 0; t < N; t++) { const v = store.D[row + t]; if (v > 0) { accN[t] += v; stIn[s] += v; stOut[t] += v; any = true; } }
        if (!any) continue;
        const pb = s * nn;
        for (let q = store.nOrd[s] - 1; q > 0; q--) {
          const n = store.order[pb + q];
          const a = accN[n];
          if (a > 0) { const e = store.pred[pb + n]; if (e >= 0) { load[e] += a; accN[net.eFrom[e]] += a; } accN[n] = 0; }
        }
        accN[s] = 0;
        if ((s & 7) === 7) yield;
      }
      const lam = opts.metroLam || 0.5;
      for (let e = 0; e < nE; e++) { const old = P.load[e]; P.load[e] = old * (1 - lam) + load[e] * lam; if (old !== P.load[e]) stable = false; }
      const stBoard = work.stBoard, walkIn = work.walkIn;
      stBoard.fill(0); walkIn.fill(0);
      for (let e = 0; e < nE; e++) {
        const ty = net.eType[e];
        if (ty === 0) stBoard[net.eSt[e]] += P.load[e];
        else if (ty === 3) walkIn[net.eSt[e]] += P.load[e];
      }
      const mc = CFG.metro;
      for (let s = 0; s < N; s++) {
        const oldIn = P.stIn[s], oldOut = P.stOut[s], oldDelay = P.stDelay[s];
        P.stIn[s] = P.stIn[s] * (1 - lam) + stIn[s] * lam;
        P.stOut[s] = P.stOut[s] * (1 - lam) + stOut[s] * lam;
        P.stBoard[s] = stBoard[s];
        P.stXfer[s] = Math.max(0, stBoard[s] - P.stIn[s] - walkIn[s]);
        const cap = mc.stationCap[net.C.stations[s].size];
        const ratio = (P.stIn[s] + P.stOut[s] + P.stXfer[s]) / cap;
        const dl = U.clamp((ratio - 0.8) * 10, 0, 12);
        P.stDelay[s] = P.stDelay[s] * 0.5 + dl * 0.5;
        if (oldIn !== P.stIn[s] || oldOut !== P.stOut[s] || oldDelay !== P.stDelay[s]) stable = false;
      }
      // 自动配车：发车频率取「线路最低服务水平」（按站数、站距）与「最大断面客流所需」中的较大者
      for (let r = 0; r < net.R; r++) {
        const rt = net.C.routes[r], re = net.rideEdge[r];
        let mx = 0;
        for (let q = 0; q < re.length; q++) if (P.load[re[q]] > mx) mx = P.load[re[q]];
        const need = U.clamp(Math.max(mx / (rt.cap * mc.targetLF), Model.serviceFloor(rt, p)), 1, mc.fMax);
        const oldFreq = P.freq[r]; P.freq[r] = oldFreq * 0.55 + need * 0.45;
        if (oldFreq !== P.freq[r]) stable = false;
        for (let q = 0; q < re.length; q++) {
          const e = re[q];
          const LF = P.load[e] / Math.max(1, P.freq[r] * rt.cap);
          let cf = 1;
          if (LF > 0.6) cf = 1 + 0.25 * Math.min(1, (LF - 0.6) / 0.4);
          if (LF > 1) cf = 1.25 + 1.6 * (LF - 1);
          const oldCrowd = P.crowd[e]; P.crowd[e] = Math.min(3.5, oldCrowd * 0.5 + cf * 0.5);
          if (oldCrowd !== P.crowd[e]) stable = false;
          if (LF > 1) st.crowdPkm += P.load[e] * net.eKm[e];
        }
      }
    }
    // ---- 汽车分配 ----
    const road = this.road, nN = road.nN, nA = road.nA;
    let work = buf.roadWork;
    if (!work || work.aux.length !== nA || work.dist.length !== nN) work = buf.roadWork = { aux: new Float32Array(nA), dist: new Float64Array(nN), dkm: new Float32Array(nN), pred: new Int32Array(nN), order: new Int32Array(nN), accN: new Float64Array(nN) };
    const aux = work.aux, dist = work.dist, dkm = work.dkm, pred = work.pred, order = work.order, accN = work.accN;
    aux.fill(0); accN.fill(0);
    const rd = this.roadData, connStart = rd.start, connNode = rd.nodes, connTime = rd.times, connKm = rd.km;
    const time = P.arcTime, heap = this.heap;
    for (let o = 0; o < Z; o++) {
      const c0 = connStart[o], c1 = connStart[o + 1];
      if (c0 === c1) continue;
      if (!hasCar[o] && !(opts.fullSkim && this.zPop[o] > 0) && P.iters > 0) continue;
      const no = roadTree(road, rd, time, o, work, heap);
      const row = o * Z;
      for (const d of rd.zones) {
        if (d === o) continue;
        let best = INF, bk = 0, bn = -1;
        for (let k = connStart[d]; k < connStart[d + 1]; k++) { const node = connNode[k], v = dist[node] + connTime[k]; if (v < best) { best = v; bk = dkm[node] + connKm[k]; bn = node; } }
        if (bn < 0 || best >= INF) continue;
        const oldT = stable ? skT[row + d] : 0, oldK = stable ? skK[row + d] : 0;
        skT[row + d] = best; skK[row + d] = bk;
        if (stable && (oldT !== skT[row + d] || oldK !== skK[row + d])) stable = false;
        const dem = carDem[row + d];
        if (dem > 0) accN[bn] += dem;
      }
      for (let q = no - 1; q >= 0; q--) {
        const n = order[q], a = accN[n];
        if (a > 0) { const e = pred[n]; if (e >= 0) { aux[e] += a; accN[road.arcFrom[e]] += a; } accN[n] = 0; }
      }
      if ((o & 1) === 1) yield;
    }
    const lam = P.iters === 0 ? 1 : (opts.lam || CFG.road.msa);
    const A = CFG.road.bprA, capF = this.capF || 1;
    for (let a = 0; a < nA; a++) {
      const oldVol = P.arcVol[a], oldTime = P.arcTime[a];
      const v = oldVol * (1 - lam) + aux[a] * lam;
      P.arcVol[a] = v;
      const x = v / (road.arcCap[a] * capF);
      P.arcTime[a] = road.arcT0[a] * Math.min(8, 1 + A * x * x * x * x);
      if (oldVol !== P.arcVol[a] || oldTime !== P.arcTime[a]) stable = false;
      st.congNum += v * road.arcLen[a] * (P.arcTime[a] / road.arcT0[a]);
      st.congDen += v * road.arcLen[a];
    }
    P.iters++;
    // 统计平滑（显示更平稳）
    if (P.stats && !opts.noSmooth) {
      const o = P.stats;
      for (const k in st) st[k] = o[k] * 0.4 + st[k] * 0.6;
    }
    if (stable && P.stats) for (const k in st) if (st[k] !== P.stats[k]) { stable = false; break; }
    P.stats = st;
    P.stable = stable;
  };

  // ---------------- 实时求解循环 ----------------
  Model.prototype.liveLoop = function* () {
    for (;;) {
      for (let p = 0; p < NP; p++) {
        yield* this.iterate(this.net, this.live.per[p], p, { fullSkim: this.sinceChange < 1 });
        this.computeDaily();
      }
      this.cycles++; this.sinceChange++;
      this.quietCycles = this.live.per.every(function (P) { return P.stable; }) ? (this.quietCycles || 0) + 1 : 0;
      // Stop only at an exact floating-point fixed point, after two complete
      // unchanged cycles. Explicit solves and all input changes still run fully.
      if (this.quietCycles >= 2) {
        this.settled = true;
        this.settledAt = { year: this.year, fare: this.fare.flat, city: this.city.version, road: this.city.roadVersion, net: this.net };
        yield;
      }
    }
  };
  Model.prototype.step = function (budget) {
    if (this.refreshing) return;
    const t0 = performance.now();
    if (this.predJob) {
      const pj = this.predJob;
      while (performance.now() - t0 < budget * 2.2) {
        const r = pj.gen.next();
        if (r.done) { this.predJob = null; pj.done(r.value); break; }
      }
      return;
    }
    if (this.settled) {
      const at = this.settledAt;
      if (at.year === this.year && at.fare === this.fare.flat && at.city === this.city.version && at.road === this.city.roadVersion && at.net === this.net) return;
      this.wake();
    }
    if (!this.gen) this.gen = this.liveLoop();
    while (!this.settled && performance.now() - t0 < budget) this.gen.next();
  };
  // 快速收敛（读档、跳月等场合），同步执行
  Model.prototype.solveNow = function (cycles) {
    this.wake();
    const g = (function* (self) {
      for (let c = 0; c < cycles; c++) for (let p = 0; p < NP; p++) { yield* self.iterate(self.net, self.live.per[p], p, { fullSkim: c === 0 }); }
    })(this);
    for (let r = g.next(); !r.done; r = g.next()) { /* run */ }
    this.computeDaily();
    this.gen = null;
  };
  Model.prototype.solveGen = function* (cycles) {
    this.wake();
    for (let c = 0; c < cycles; c++) for (let p = 0; p < NP; p++) { yield* this.iterate(this.net, this.live.per[p], p, { fullSkim: c === 0 }); }
    this.computeDaily();
    this.gen = null;
  };

  // ---------------- 汇总指标 ----------------
  Model.prototype.aggregate = function (perList, net) {
    const D = { trips: 0, metro: 0, car: 0, timeSum: 0, commTrips: 0, commTime: 0, fare: 0, metroPkm: 0, vkt: 0, carPkm: 0, congNum: 0, congDen: 0, crowdPkm: 0, carKm: 0, metroTime: 0, carTime: 0 };
    let ok = true;
    for (let p = 0; p < NP; p++) {
      const P = perList[p];
      if (!P || !P.stats) { ok = false; continue; }
      const h = this.pHours[p], s = P.stats;
      const mf = p === 3 ? 0.9 : 1;
      for (const k in s) {
        if (k === 'metro' || k === 'fare' || k === 'metroPkm' || k === 'metroTime') D[k] += s[k] * h * mf;
        else D[k] += s[k] * h;
      }
      if (net && net.R) {
        for (let r = 0; r < net.R; r++) {
          const rt = net.C.routes[r];
          const svcH = p === 3 ? 5 : h;
          D.carKm += P.freq[r] * 2 * (rt.lenM / 1000) * rt.cars * svcH;
        }
      }
    }
    D.ready = ok;
    D.metroShare = D.trips > 0 ? D.metro / D.trips : 0;
    D.avgTime = D.trips > 0 ? D.timeSum / D.trips : 0;
    D.commute = D.commTrips > 0 ? D.commTime / D.commTrips : 0;
    D.cong = D.congDen > 0 ? D.congNum / D.congDen : 1;
    const am = perList[0] && perList[0].stats;
    D.congAM = am && am.congDen > 0 ? am.congNum / am.congDen : D.cong;
    D.crowdShare = D.metroPkm > 0 ? D.crowdPkm / D.metroPkm : 0;
    D.avgFare = D.metro > 0 ? D.fare / D.metro : 0;
    D.coverage = net ? net.acc.coverage : 0;
    return D;
  };
  Model.prototype.computeDaily = function () {
    this.daily = this.aggregate(this.live.per, this.net);
    // 按车站汇总日客流
    const net = this.net;
    if (net) {
      const N = net.N;
      const sIn = new Float32Array(N), sOut = new Float32Array(N), sX = new Float32Array(N), peak = new Float32Array(N);
      const rBoard = new Float32Array(net.R);
      for (let p = 0; p < NP; p++) {
        const P = this.live.per[p], h = this.pHours[p] * (p === 3 ? 0.9 : 1);
        for (let s = 0; s < N; s++) {
          sIn[s] += P.stIn[s] * h; sOut[s] += P.stOut[s] * h; sX[s] += P.stXfer[s] * h;
          const f = P.stIn[s] + P.stOut[s] + P.stXfer[s];
          if (f > peak[s]) peak[s] = f;
        }
        for (let r = 0; r < net.R; r++) { const be = net.boardEdge[r]; for (let q = 0; q < be.length; q++) rBoard[r] += P.load[be[q]] * h; }
      }
      this.stDaily = { inn: sIn, out: sOut, xfer: sX, peak: peak, routeBoard: rBoard };
      this.dailyStale = false;
    }
    // 小区可达性（用于城市发展）
    const za = this.live.per[0].zAccess;
    let mx = 0; for (let z = 0; z < this.Z; z++) if (za[z] > mx) mx = za[z];
    this.zoneAccessNorm = new Float32Array(this.Z);
    if (mx > 0) for (let z = 0; z < this.Z; z++) this.zoneAccessNorm[z] = Math.sqrt(za[z] / mx);
    this.version++;
  };

  // ---------------- 画面用：时刻插值 ----------------
  Model.prototype.profileAt = function (minute) {
    const h = minute / 60 - 0.5;
    const h0 = Math.floor(h), t = h - h0;
    const a = this.profile[(h0 + 24) % 24], b = this.profile[(h0 + 25) % 24];
    return a + (b - a) * t;
  };
  Model.prototype.weights = function (minute) {
    const m = ((minute % 1440) + 1440) % 1440;
    const hr = Math.floor(m / 60);
    const p0 = this.hourPeriod[hr];
    const frac = (m % 60) / 60;
    let p1 = p0, w1 = 0;
    if (frac > 0.75) { const pn = this.hourPeriod[(hr + 1) % 24]; if (pn !== p0) { p1 = pn; w1 = (frac - 0.75) / 0.5; } }
    else if (frac < 0.25) { const pp = this.hourPeriod[(hr + 23) % 24]; if (pp !== p0) { p1 = pp; w1 = (0.25 - frac) / 0.5; } }
    const prof = this.profileAt(m);
    const w0 = 1 - w1;
    return { p0: p0, w0: w0, s0: prof / this.pMean[p0], p1: p1, w1: w1, s1: prof / this.pMean[p1], svc: (m >= 360 || m < 5) ? 1 : 0, prof: prof };
  };
  Model.prototype.arcVolAt = function (a, W) {
    const P0 = this.live.per[W.p0], P1 = this.live.per[W.p1];
    return P0.arcVol[a] * W.w0 * W.s0 + P1.arcVol[a] * W.w1 * W.s1;
  };
  Model.prototype.arcRatioAt = function (a, W) {
    const v = this.arcVolAt(a, W), x = v / this.cap(a);
    return Math.min(8, 1 + CFG.road.bprA * x * x * x * x);
  };
  Model.prototype.cityCongAt = function (W) {
    const road = this.road; let num = 0, den = 0;
    const capF = this.capF || 1;
    for (let a = 0; a < road.nA; a++) {
      const v = this.arcVolAt(a, W); if (v <= 0) continue;
      const x = v / (road.arcCap[a] * capF);
      num += v * road.arcLen[a] * Math.min(8, 1 + CFG.road.bprA * x * x * x * x); den += v * road.arcLen[a];
    }
    return den > 0 ? num / den : 1;
  };
  // 线路最低服务水平（列/小时）：车站越多、站距越小的城区线越密，站距大的郊区线较疏；非环线保证至少 2 列车在线运行
  Model.serviceFloor = function (rt, p) {
    const mc = CFG.metro;
    if (!rt) return mc.fMin[p];
    const ns = rt.stIdx.length, sp = rt.lenM / 1000 / Math.max(1, rt.loop ? ns : ns - 1);
    const fs = U.clamp(1.5 - 0.35 * sp, 0.7, 1.3);          // 平均站距 1 km → 1.15；2.3 km 以上 → 0.7
    const fn = U.clamp(0.82 + ns / 45, 0.85, 1.3);          // 8 站 → 1.0；22 站以上 → 1.3
    let f = mc.fMin[p] * fs * fn;
    if (!rt.loop && rt.cycleSec > 0) f = Math.max(f, 2 * 3600 / rt.cycleSec);
    return Math.min(f, mc.fMax);
  };
  Model.prototype.freqAt = function (r, W) {
    if (!this.net || !W.svc) return 0;
    return this.live.per[W.p0].freq[r] * W.w0 + this.live.per[W.p1].freq[r] * W.w1;
  };
  Model.prototype.stFlowAt = function (s, W, kind) {
    const P0 = this.live.per[W.p0], P1 = this.live.per[W.p1];
    const k = kind || 'stIn';
    return (P0[k][s] * W.w0 * W.s0 + P1[k][s] * W.w1 * W.s1) * W.svc;
  };
  Model.prototype.edgeLoadAt = function (e, W) {
    const P0 = this.live.per[W.p0], P1 = this.live.per[W.p1];
    return (P0.load[e] * W.w0 * W.s0 + P1.load[e] * W.w1 * W.s1) * W.svc;
  };

  // ---------------- 建设前预测 ----------------
  // 基于同一城市状态与票价，比较当前网络与草案网络（均从当前运行状态热启动，迭代次数相同）
  Model.prototype.predict = function (draftC, affectedLineIds, done) {
    const self = this;
    const gen = (function* () {
      const result = { conditions: { year: self.year, fare: Object.assign({}, self.fare) }, progress: 0 };
      self.predState = result;
      const baseNet = self.net, draftNet = self.buildMetro(draftC);
      yield;
      const runFor = function* (net, label, prog) {
        const per = [];
        for (let p = 0; p < NP; p++) {
          const L = self.live.per[p];
          const P = {
            arcVol: Float32Array.from(L.arcVol), arcTime: Float32Array.from(L.arcTime), skimT: Float32Array.from(L.skimT), skimK: Float32Array.from(L.skimK),
            desTot: new Float32Array(self.B * self.B), desMetro: new Float32Array(self.B * self.B), zTrips: new Float32Array(self.Z), zMetro: new Float32Array(self.Z), zAccess: new Float32Array(self.Z),
            stats: null, iters: Math.max(1, L.iters),
          };
          self.initMetroPer(P, net, p, L, self.net);
          const its = p === 3 ? 1 : 2;
          for (let it = 0; it < its; it++) {
            yield* self.iterate(net, P, p, { noSmooth: true, metroLam: it === 0 ? 0.7 : 0.6, buf: self.predBuf });
            result.progress = prog + (p * 2 + it + 1) / 16;
          }
          // 仅保留结果所需
          per.push({ stats: P.stats, freq: P.freq, load: P.load, stIn: P.stIn, stOut: P.stOut, stXfer: P.stXfer, arcVol: p === 0 ? P.arcVol : null, arcTime: p === 0 ? P.arcTime : null });
        }
        return per;
      };
      result.progress = 0;
      const basePer = baseNet ? yield* runFor(baseNet, 'base', 0) : null;
      const draftPer = yield* runFor(draftNet, 'draft', 0.5);
      const fill = function (per, net) {
        if (!per) return null;
        const full = per.map(function (x) { return x; });
        return self.aggregate(full, net);
      };
      const B = basePer ? fill(basePer, baseNet) : self.aggregate([0, 1, 2, 3].map(function () { return null; }), null);
      const Dr = fill(draftPer, draftNet);
      result.base = B; result.draft = Dr;
      // 新线客流：受影响线路的日上车人次
      const lineBoard = function (per, net) {
        const m = new Map();
        if (!per || !net) return m;
        for (let p = 0; p < NP; p++) {
          const h = self.pHours[p] * (p === 3 ? 0.9 : 1);
          for (let r = 0; r < net.R; r++) {
            const lid = net.C.routes[r].lineId;
            let s = 0; const be = net.boardEdge[r];
            for (let q = 0; q < be.length; q++) s += per[p].load[be[q]];
            m.set(lid, (m.get(lid) || 0) + s * h);
          }
        }
        return m;
      };
      const lb0 = lineBoard(basePer, baseNet), lb1 = lineBoard(draftPer, draftNet);
      result.lines = [];
      for (const lid of affectedLineIds) {
        const ln = draftC.net.lines[lid];
        result.lines.push({ id: lid, name: ln ? ln.name : '（已拆除）', color: ln ? ln.color : '#999', before: lb0.get(lid) || 0, after: lb1.get(lid) || 0 });
      }
      // 道路变化：早高峰按道路名汇总
      if (basePer) {
        const road = self.road, byName = new Map();
        const v0 = basePer[0].arcVol, v1 = draftPer[0].arcVol;
        for (const L of road.links) {
          if (!L.name || L.cls < 3) continue;
          for (let d = 0; d < 2; d++) {
            const a = 2 * L.id + d;
            const e = byName.get(L.name) || { n0: 0, n1: 0, d0: 0, d1: 0, vkt0: 0 };
            const x0 = v0[a] / self.cap(a), x1 = v1[a] / self.cap(a);
            e.n0 += v0[a] * L.lenM * x0; e.d0 += v0[a] * L.lenM; e.n1 += v1[a] * L.lenM * x1; e.d1 += v1[a] * L.lenM; e.vkt0 += v0[a] * L.lenM;
            byName.set(L.name, e);
          }
        }
        const roads = [];
        byName.forEach(function (e, nid) {
          if (e.d0 <= 0 || !self.city.roadNames[nid]) return;
          const vc0 = e.n0 / e.d0, vc1 = e.d1 > 0 ? e.n1 / e.d1 : 0;
          roads.push({ name: self.city.roadNames[nid], vc0: vc0, vc1: vc1, delta: vc1 - vc0, w: e.vkt0 });
        });
        roads.sort(function (a, b) { return a.delta - b.delta; });
        result.roads = roads.filter(function (r) { return Math.abs(r.delta) > 0.004; }).slice(0, 5);
        result.roadsWorse = roads.filter(function (r) { return r.delta > 0.004; }).sort(function (a, b) { return b.delta - a.delta; }).slice(0, 3);
      } else { result.roads = []; result.roadsWorse = []; }
      // 有效性
      result.valid = draftNet.R > 0 && Dr.metro > 1;
      if (!result.valid) {
        if (draftNet.R === 0) result.reason = '草案中没有形成可运营的线路（至少需要两座车站和一段轨道）。';
        else {
          let acc = 0; for (let s = 0; s < draftNet.N; s++) acc += draftNet.acc.accessible[s];
          result.reason = acc === 0 ? '车站周边暂无可步行到达的道路，无法形成有效地铁行程。' : '车站覆盖范围内的出行需求很少，暂未形成有效地铁行程。';
        }
      }
      result.progress = 1;
      return result;
    })();
    this.predJob = { gen: gen, done: done };
    return gen;
  };
  Model.prototype.cancelPredict = function () { this.predJob = null; };
})(window.CM);
