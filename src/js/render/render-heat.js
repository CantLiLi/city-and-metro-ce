'use strict';
// 分析图层：人口、岗位、覆盖、片区、设施出行需求、服务缺口等热力格
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;

  // ---------------- 分析图层（热力格） ----------------
  // 片区吸引的出行分到各格（按与 sim.js 相同的用地权重），用于「设施出行需求」与「地铁服务缺口」图层
  Renderer.prototype.cellWeights = function (q) {
    const city = this.game.city, LU = CM.LU, N = city.N, w = new Float32Array(N);
    const fn = this.game.model.fn, excl = fn ? fn.excl : null;
    for (let c = 0; c < N; c++) {
      const pc = city.pop[c], jc = city.jobs[c], L = city.lu[c], com = L === LU.COM || L === LU.MIX;
      if (q === 'hw') w[c] = jc;
      else if (q === 'all') w[c] = pc + jc;
      else if (excl && excl[c]) w[c] = 0;
      else if (q === 'sc') w[c] = pc * 0.25 + (L === LU.INST ? jc * 1.2 : 0);
      else if (q === 'sh') w[c] = jc * (com ? 1 : (L === LU.RES ? 0.5 : (L === LU.IND ? 0.1 : 0.3))) + pc * 0.05;
      else if (q === 'md') w[c] = (L === LU.INST ? jc * 0.5 : 0) + (com ? jc * 0.05 : 0) + pc * 0.03;
      else if (q === 'lz') w[c] = (city.isPark[c] || L === LU.PARK ? 400 * city.landFrac[c] : 0) + (L === LU.HILL ? 60 * city.landFrac[c] : 0) + (com ? jc * 0.25 : 0) + pc * 0.12 + (L === LU.LANDMARK ? 200 : 0);
    }
    return w;
  };
  Renderer.prototype.zoneToCells = function (zv, w) {
    const model = this.game.model, out = new Float32Array(this.game.city.N);
    for (let z = 0; z < model.Z; z++) {
      const cs = model.zoneCells[z]; let s = 0;
      for (const c of cs) s += w[c];
      if (!(s > 0) || !(zv[z] > 0)) continue;
      for (const c of cs) out[c] = zv[z] * w[c] / s;
    }
    return out;
  };
  Renderer.prototype.buildHeat = function () {
    const g = this.game, city = g.city, model = g.model, W = city.W, H = city.H, LO = this.layerOpt, lay = this.layer;
    const access = lay === 'cover' || lay === 'gap' ? model.net : null;
    const dyn = lay === 'fac' || lay === 'gap';
    const key = lay + ':' + city.version + ':' + g.clock.y + ':' + g.clock.m + ':' + (lay === 'cover' ? g.netVersion + ':' + LO.cover : '') + (lay === 'fac' ? LO.facP + ':' + LO.facDt : '') + (lay === 'gap' ? LO.gapDt + ':' + g.netVersion : '') + (dyn ? ':' + model.cycles + ':' + (model.settled ? 's' : '') : '');
    const old = this.heatLayers.get(lay);
    if (old && old.key === key && old.access === access) { this.heat = old.cv; this.heatKey = key; return; }
    this.heatKey = key;
    this.heat = old && old.cv.width === W && old.cv.height === H ? old.cv : makeCanvas(W, H);
    const ctx = this.heat.getContext('2d');
    const img = ctx.createImageData(W, H), d = img.data;
    const acc = model.net ? model.net.acc : null;
    // 设施出行需求：片区吸引（按目的）分到各格；全部目的时按主要目的着色
    let facCell = null, facDom = null, gapCell = null;
    const TR = CFG.trips, PK = TR.keys;
    const fd = dyn ? model.facData(lay === 'gap' ? LO.gapDt : LO.facDt) : null;
    if (lay === 'fac' && fd) {
      const Z = model.Z;
      const list = LO.facP === 'all' ? ['sc', 'sh', 'md', 'lz'] : [LO.facP];   // 全部 = 设施类出行（上学、购物、医疗、休闲）；通勤按岗位，单独查看
      facCell = new Float32Array(city.N); facDom = new Int8Array(city.N).fill(-1);
      const best = new Float32Array(city.N);
      for (const q of list) {
        const qi = PK.indexOf(q);
        let zv;
        if (q === 'hb') {   // 枢纽接驳：城市一端（出发与到达的片区），按需求表中的接驳出行
          zv = new Float32Array(Z); const od = model.od, t5 = od.t[5];
          const mult = LO.facDt === 'we' ? model.weekendMult(model.year)[5] : 1;
          for (let i = 0; i < Z; i++) for (let k = od.start[i]; k < od.start[i + 1]; k++) zv[i] += 2 * t5[k] * mult;
        } else zv = fd.dest.subarray(qi * Z, qi * Z + Z);
        const cv = this.zoneToCells(zv, this.cellWeights(q));
        for (let c = 0; c < city.N; c++) { facCell[c] += cv[c]; if (cv[c] > best[c]) { best[c] = cv[c]; facDom[c] = qi; } }
      }
    }
    if (lay === 'gap' && fd) {
      const Z = model.Z, zv = new Float32Array(Z);
      for (let z = 0; z < Z; z++) {
        let dst = 0; for (let q = 0; q < 6; q++) dst += fd.dest[q * Z + z];
        zv[z] = (fd.trips[z] + dst) * (1 - (acc ? acc.zCov[z] : 0));
      }
      gapCell = this.zoneToCells(zv, this.cellWeights('all'));
    }
    const stCol = function (k) { const hsh = (k * 2654435761) >>> 0; return [40 + (hsh & 127), 110 + ((hsh >> 7) & 100), 60 + ((hsh >> 14) & 140)]; };
    for (let c = 0; c < W * H; c++) {
      let col = null, a = 0;
      const p = city.pop[c] / 0.0625, jb = city.jobs[c] / 0.0625;
      if (lay === 'fac') {
        if (facCell) { const v = facCell[c] / 0.0625; if (v > 150) { const t = U.clamp(Math.sqrt(v / 40000), 0, 1); col = U.hex2rgb(TR.color[PK[facDom[c]]] || '#888888'); a = 0.1 + 0.42 * t; } }
      } else if (lay === 'gap') {
        if (gapCell) { const v = gapCell[c] / 0.0625; if (v > 400) { const t = U.clamp(Math.sqrt(v / 60000), 0, 1); col = U.ramp([[0, [255, 214, 170]], [0.5, [236, 112, 72]], [1, [180, 24, 34]]], t); a = 0.12 + 0.45 * t; } }
      } else if (lay === 'cover' && LO.cover === 'station') {
        const w = acc ? acc.cellWalk[c] : Infinity, k = acc ? acc.cellStation[c] : -1;
        if (k >= 0 && w <= CFG.walk.maxAccessM) { col = stCol(k); a = 0.42 - 0.18 * U.clamp(w / CFG.walk.maxAccessM, 0, 1); }
        else if (p > 4000) { col = [215, 48, 39]; a = U.clamp(0.1 + p / 120000, 0, 0.38); }
      } else if (lay === 'pop') {
        // 浅色单色渐变、半透明（最高约 0.5），道路与地名仍清楚可见
        if (p > 200) { const t = U.clamp(Math.sqrt(p / 60000), 0, 1); col = U.ramp([[0, [255, 226, 150]], [0.5, [249, 158, 76]], [1, [222, 84, 52]]], t); a = 0.12 + 0.4 * t; }
      } else if (this.layer === 'jobs') {
        const t = p + jb;
        if (t > 300) { const sh = p / t; col = U.mixc([52, 104, 214], [240, 150, 60], sh); a = U.clamp(0.12 + 0.4 * Math.sqrt(t / 90000), 0, 0.5); }
      } else if (this.layer === 'cover') {
        const w = acc ? acc.cellWalk[c] : Infinity;
        const m = w / CFG.walk.mPerMin;
        if (m <= 5) { col = [27, 140, 70]; a = 0.5; }
        else if (m <= 10) { col = [90, 180, 100]; a = 0.42; }
        else if (m <= 15) { col = [160, 214, 130]; a = 0.36; }
        else if (p > 4000) { col = [215, 48, 39]; a = U.clamp(0.1 + p / 120000, 0, 0.38); }
      } else if (this.layer === 'region') {
        const rg = city.regions[city.region[c]];
        if (rg.scenic) { col = [120, 170, 110]; a = 0.25; }
        else if (!city.regionOpen[city.region[c]]) { col = [150, 150, 150]; a = 0.25; }
      }
      if (col) { const o = c * 4; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = a * 255; }
    }
    ctx.putImageData(img, 0, 0);
    this.heatLayers.set(this.layer, { key: key, access: access, cv: this.heat });
  };
})(window.CM);
