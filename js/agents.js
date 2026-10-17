'use strict';
// 动态对象：列车（按发车间隔调度、加减速平滑运行）、汽车（按路段流量与车速）、行人（沿街道往返车站）
// 代表性展示：数量与模拟人口不一一对应，但与交通变化方向一致。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const CAR_COLORS = ['#ffffff', '#d7dbe0', '#3b4b5e', '#c0392b', '#e9b824', '#2c6fbb', '#8c959f', '#f2f2f2', '#d35400'];
  const PED_COLORS = ['#4a5568', '#2d3748', '#9b2c2c', '#2b6cb0', '#744210', '#553c9a', '#2f855a'];

  function Agents() {
    this.vt = 0;
    this.groups = new Map();
    this.trains = [];
    this.cars = []; this.carIndex = new Map();
    this.peds = [];
    this.netRef = null;
    this.treeMaps = new Map();
    this.seq = 0;
  }
  CM.Agents = Agents;

  Agents.prototype.reset = function () { this.groups.clear(); this.trains = []; this.cars = []; this.carIndex.clear(); this.peds = []; this.netRef = null; this.treeMaps.clear(); };

  Agents.prototype.update = function (dt, game, R) {
    const sp = game.speed > 0 && !game.jumping && !game.pending ? CFG.time.speeds[game.speed - 1] : 0;
    const dtv = dt * sp * CFG.time.visualPerSec;
    this.vt += dtv;
    const model = game.model;
    const W = model.weights(game.clock.minute);
    this.W = W;
    if (model.net !== this.netRef) this.syncNetwork(model.net);
    this.updateTrains(dtv, dt, model, W);
    if (!R.view) return;
    this.updateCars(dtv, dt, game, R, W);
    this.updatePeds(dtv, dt, game, R, W);
  };

  // ---------------- 列车 ----------------
  function legSpeed(Lm, T, a) {
    const disc = a * a * T * T - 4 * a * Lm;
    return (a * T - Math.sqrt(Math.max(0, disc))) / 2;
  }
  function legFrac(t, T, Lm, v, a) {
    if (t <= 0) return 0;
    if (t >= T) return 1;
    const ta = v / a;
    let d;
    if (t < ta) d = 0.5 * a * t * t;
    else if (t < T - ta) d = 0.5 * a * ta * ta + v * (t - ta);
    else { const tr = T - t; d = Lm - 0.5 * a * tr * tr; }
    return U.clamp(d / Lm, 0, 1);
  }
  Agents.prototype.syncNetwork = function (net) {
    this.netRef = net;
    const old = this.groups;
    this.groups = new Map();
    this.treeMaps.clear();
    if (!net) { for (const t of this.trains) t.dying = true; return; }
    const mc = CFG.metro, a = mc.accel;
    const C = net.C;
    for (let r = 0; r < C.routes.length; r++) {
      const rt = C.routes[r], n = rt.stIdx.length;
      const dirs = rt.loop ? [0, 1] : [0];
      for (const dir of dirs) {
        const legs = [];
        const mk = function (k, rev, dwell) {
          const Lm = rt.legLenM[k], T = rt.legSec[k];
          return { k: k, rev: rev, d0: rev ? rt.stopDist[k + 1] : rt.stopDist[k], d1: rev ? rt.stopDist[k] : rt.stopDist[k + 1], T: T, Lm: Lm, v: legSpeed(Lm, T, a), dwell: dwell };
        };
        if (!rt.loop) {
          for (let k = 0; k < n - 1; k++) legs.push(mk(k, false, k + 1 === n - 1 ? mc.turnaround : mc.dwell));
          for (let k = n - 2; k >= 0; k--) legs.push(mk(k, true, k === 0 ? mc.turnaround : mc.dwell));
        } else if (dir === 0) {
          for (let k = 0; k < n; k++) legs.push(mk(k, false, mc.dwell));
        } else {
          for (let k = n - 1; k >= 0; k--) legs.push(mk(k, true, mc.dwell));
        }
        let cycle = 0; for (const l of legs) cycle += l.T + l.dwell;
        const key = net.routeKey[r] + '#' + dir + '#' + legs.length;
        const og = old.get(key);
        const g = { key: key, r: r, dir: dir, rt: rt, legs: legs, cycle: cycle, lastDep: og ? og.lastDep : -1e9, count: 0 };
        this.groups.set(key, g);
      }
    }
    for (const t of this.trains) {
      const g = this.groups.get(t.gkey);
      if (g && t.leg < g.legs.length) t.g = g; else t.dying = true;
    }
  };
  Agents.prototype.updateTrains = function (dtv, dt, model, W) {
    const net = this.netRef;
    this.groups.forEach(function (g) { g.count = 0; });
    for (const t of this.trains) if (!t.dying && t.g) t.g.count++;
    const vt = this.vt;
    if (net) {
      this.groups.forEach((g) => {
        const f = model.freqAt(g.r, W);
        g.h = f > 0.1 ? 3600 / f : Infinity;
        g.need = isFinite(g.h) ? Math.max(1, Math.ceil(g.cycle / g.h)) : 0;
        if (g.count < g.need && vt >= g.lastDep + g.h) {
          this.trains.push({ id: ++this.seq, g: g, gkey: g.key, leg: 0, t: 0, alpha: 0, dying: false, held: false });
          g.lastDep = vt; g.count++;
        }
      });
    }
    for (const t of this.trains) {
      t.alpha = t.dying ? Math.max(0, t.alpha - dt / 0.6) : Math.min(1, t.alpha + dt / 0.6);
      if (t.dying || !t.g) continue;
      const g = t.g;
      let rem = dtv;
      let guard = 0;
      while (rem > 0 && guard++ < 50) {
        const L = g.legs[t.leg];
        const end = L.T + L.dwell;
        if (t.t + rem < end) { t.t += rem; rem = 0; break; }
        rem -= end - t.t;
        t.leg++; t.t = 0;
        if (t.leg >= g.legs.length) {
          t.leg = 0;
          if (g.count > g.need) { t.dying = true; g.count--; t.t = 0; t.leg = g.legs.length - 1; t.t = g.legs[t.leg].T + g.legs[t.leg].dwell; rem = 0; break; }
          // 发车间隔控制：在控制点等候
          const due = g.lastDep + g.h;
          if (vt < due) { t.t = -(due - vt); }
          g.lastDep = Math.max(vt, isFinite(due) ? due : vt);
        }
      }
    }
    this.trains = this.trains.filter(function (t) { return !(t.dying && t.alpha <= 0); });
  };
  Agents.prototype.trainPos = function (t, out) {
    const g = t.g, L = g.legs[t.leg], rt = g.rt;
    const f = t.t < 0 ? 0 : legFrac(Math.min(t.t, L.T), L.T, L.Lm, L.v, CFG.metro.accel);
    const d = L.d0 + (L.d1 - L.d0) * f;
    out.d = d; out.fwd = L.d1 >= L.d0; out.k = L.k; out.rev = L.rev;
    return out;
  };
  Agents.prototype.drawTrains = function (ctx, R, ui) {
    const net = this.netRef; if (!net) return;
    const z = R.z, under = U.smooth(R.cam.under);
    const model = CM.game ? CM.game.model : null;
    const W = this.W;
    const tmp = {}, pa = {}, pb = {};
    const lenPerCar = 20 / CFG.CELL_M;
    const width = U.clamp(z * 0.075, 2.4, 7.5);
    const v = R.view;
    const hl = ui && ui.highlightLine;
    for (const t of this.trains) {
      if (!t.g || t.alpha <= 0.01) continue;
      const rt = t.g.rt;
      this.trainPos(t, tmp);
      const total = rt.cum[rt.cum.length - 1];
      const Lt = Math.max(lenPerCar * rt.cars, 0.12);
      const dir = tmp.fwd ? 1 : -1;
      let dRear = tmp.d - dir * Lt;
      if (rt.loop) dRear = (dRear + total) % total; else dRear = U.clamp(dRear, 0, total);
      U.posAt(rt.pts, rt.cum, tmp.d, pa);
      U.posAt(rt.pts, rt.cum, dRear, pb);
      if (pa.x < v.x0 || pa.x > v.x1 || pa.y < v.y0 || pa.y > v.y1) continue;
      const hA = heightAt(rt, pa), hB = heightAt(rt, pb);
      const off = 0.055 * dir;
      const nx = -Math.sin(pa.a) * off, ny = Math.cos(pa.a) * off;
      const uw = function (h) { return h < 0 ? h * under * CM.RENDER_CONST.UNDER_DEPTH : h; };
      const A = R.P(pa.x + nx, pa.y + ny, uw(hA)), B = R.P(pb.x + nx, pb.y + ny, uw(hB));
      let alpha = t.alpha;
      const seg = rt.segRefs[tmp.k];
      const segType = net.C.segs.get(seg.id) ? net.C.segs.get(seg.id).seg.type : 'underground';
      if (segType === 'underground' && hA < -0.01) alpha *= U.lerp(0.55, 1, under);
      else if (under > 0) alpha *= U.lerp(1, 0.4, under);
      if (hl && hl !== rt.lineId) alpha *= 0.3;
      ctx.globalAlpha = alpha;
      if (z < 7) {
        ctx.fillStyle = rt.color; ctx.beginPath(); ctx.arc(A.x, A.y, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        continue;
      }
      // 拥挤度
      let lf = 0;
      if (model) {
        const e = net.rideEdge[t.g.r][2 * tmp.k + (tmp.rev ? 1 : 0)];
        const f = model.freqAt(t.g.r, W);
        if (f > 0) lf = model.edgeLoadAt(e, W) / (f * rt.cap);
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(20,24,30,0.55)'; ctx.lineWidth = width + 2;
      ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(A.x, A.y); ctx.stroke();
      ctx.strokeStyle = rt.color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(A.x, A.y); ctx.stroke();
      if (z >= 14) {
        ctx.strokeStyle = lf > 1 ? 'rgba(255,200,200,0.95)' : 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1, width * 0.28); ctx.setLineDash([width * 0.7, width * 0.5]);
        ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(A.x, A.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(A.x, A.y, Math.max(1, width * 0.22), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  function heightAt(rt, p) {
    const i = p.i, f = p.f || 0;
    const a = rt.hs[i], b = rt.hs[Math.min(rt.hs.length - 1, i + 1)];
    return a + (b - a) * f;
  }

  // ---------------- 汽车 ----------------
  Agents.prototype.updateCars = function (dtv, dt, game, R, W) {
    const model = game.model, road = model.road, city = game.city;
    const z = R.z, v = R.view;
    if (this.roadRef !== road) { this.cars = []; this.carIndex.clear(); this.roadRef = road; }
    const show = z >= 7 && R.cam.under < 0.95;
    const margin = 3;
    const inView = function (L) { const b = L.bbox; return b[2] >= v.x0 - margin && b[0] <= v.x1 + margin && b[3] >= v.y0 - margin && b[1] <= v.y1 + margin; };
    // 移动
    const kmh2cell = 1 / 3.6 / CFG.CELL_M;
    const idx = this.carIndex;
    for (const c of this.cars) {
      c.alpha = c.dying ? c.alpha - dt / 0.35 : Math.min(1, c.alpha + dt / 0.5);
      if (dtv <= 0) continue;
      const L = road.links[c.link];
      const a = 2 * c.link + c.dir;
      const ratio = model.arcRatioAt(a, W);
      const vTarget = CFG.road.speed[L.cls] / Math.min(8, ratio) * kmh2cell;
      c.v = U.lerp(c.v, vTarget, Math.min(1, dt * 2));
      c.s += c.v * dtv;
      const len = L.cum[L.cum.length - 1];
      if (c.s >= len) {
        // 进入下一路段
        const node = c.dir === 0 ? L.b : L.a;
        let pick = -1, tot = 0;
        for (let k = road.outStart[node]; k < road.outStart[node + 1]; k++) {
          const arc = road.outArc[k];
          if ((arc >> 1) === c.link) continue;
          const L2 = road.links[arc >> 1];
          if (L2.cls < 2 || !L2.real) continue;
          const w = model.arcVolAt(arc, W) + 5;
          tot += w;
          if (Math.random() * tot < w) pick = arc;
        }
        if (pick < 0 || !inView(road.links[pick >> 1])) { c.dead = true; continue; }
        this.idxRemove(c);
        c.link = pick >> 1; c.dir = pick & 1; c.s = c.s - len;
        this.idxAdd(c);
      }
    }
    // 跟车：同路段同方向保持间距
    idx.forEach(function (list) {
      if (list.length < 2) return;
      list.sort(function (a, b) { return b.s - a.s; });
      for (let i = 1; i < list.length; i++) {
        const gap = 0.07;
        if (list[i].s > list[i - 1].s - gap) { list[i].s = list[i - 1].s - gap; list[i].v = Math.min(list[i].v, list[i - 1].v); }
      }
    });
    // 清理
    if (this.cars.some(function (c) { return c.dead || c.alpha <= 0 || c.s < -0.5; })) {
      const keep = [];
      for (const c of this.cars) { if (c.dead || (c.dying && c.alpha <= 0) || c.s < -0.5) this.idxRemove(c); else keep.push(c); }
      this.cars = keep;
    }
    if (!show) { for (const c of this.cars) c.dying = true; return; }
    // 生成：按路段流量
    const vis = 0.09 * U.clamp(z / 22, 0.25, 1.2);
    let budget = 60;
    const maxCars = CFG.perf.maxCars;
    let total = this.cars.length;
    const step = this.frameFlip = !this.frameFlip;
    for (const L of road.links) {
      if (L.cls < 2 || !L.real || !inView(L)) continue;
      if (((L.id & 1) === 1) !== step) continue;
      for (let dir = 0; dir < 2; dir++) {
        const a = 2 * L.id + dir;
        const vol = model.arcVolAt(a, W);
        if (vol < 5) continue;
        const ratio = model.arcRatioAt(a, W);
        const sp = CFG.road.speed[L.cls] / Math.min(8, ratio);
        const lenKm = L.lenM / 1000;
        const target = Math.min(lenKm * 30, vol / sp * lenKm * vis);
        const key = a;
        const list = idx.get(key);
        const have = list ? list.length : 0;
        if (have < target - 0.5 && budget > 0 && total < maxCars) {
          const len = L.cum[L.cum.length - 1];
          const s = Math.random() * len;
          let ok = true;
          if (list) for (const o of list) if (Math.abs(o.s - s) < 0.09) { ok = false; break; }
          if (ok) {
            const c = { link: L.id, dir: dir, s: s, v: sp * kmh2cell, alpha: 0, color: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0], ang: null };
            this.cars.push(c); this.idxAdd(c); budget--; total++;
          }
        } else if (list && have > target * 1.4 + 1) {
          for (const c of list) if (!c.dying) { c.dying = true; break; }
        }
      }
    }
  };
  Agents.prototype.idxAdd = function (c) { const k = 2 * c.link + c.dir; let l = this.carIndex.get(k); if (!l) { l = []; this.carIndex.set(k, l); } l.push(c); };
  Agents.prototype.idxRemove = function (c) { const k = 2 * c.link + c.dir; const l = this.carIndex.get(k); if (!l) return; const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); if (!l.length) this.carIndex.delete(k); };
  Agents.prototype.carWorld = function (c, road, out) {
    const L = road.links[c.link];
    const len = L.cum[L.cum.length - 1];
    const s = c.dir === 0 ? U.clamp(c.s, 0, len) : U.clamp(len - c.s, 0, len);
    U.posAt(L.pts, L.cum, s, out);
    let ang = out.a + (c.dir === 1 ? Math.PI : 0);
    if (c.ang == null) c.ang = ang;
    let da = ang - c.ang; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    c.ang += da * 0.25;
    const off = L.cls === 4 ? 0.085 : (L.cls === 3 ? 0.06 : 0.035);
    out.x += -Math.sin(ang) * off; out.y += Math.cos(ang) * off;
    out.ang = c.ang;
    return out;
  };

  // ---------------- 行人 ----------------
  Agents.prototype.treeMap = function (k, tree) {
    let m = this.treeMaps.get(k);
    if (!m) { m = new Map(); for (let q = 0; q < tree.verts.length; q++) m.set(tree.verts[q], q); this.treeMaps.set(k, m); }
    return m;
  };
  Agents.prototype.updatePeds = function (dtv, dt, game, R, W) {
    const model = game.model, net = model.net, city = game.city;
    const z = R.z, v = R.view;
    const show = z >= 18 && R.cam.under < 0.9;
    const mps2cell = 1 / CFG.CELL_M;
    for (const p of this.peds) {
      p.alpha = p.dying ? p.alpha - dt / 0.4 : Math.min(1, p.alpha + dt / 0.5);
      p.s += p.v * dtv;
      if (p.s >= p.len) { p.s = p.len; p.dying = true; }
    }
    this.peds = this.peds.filter(function (p) { return !(p.dying && p.alpha <= 0); });
    if (!show) { for (const p of this.peds) p.dying = true; return; }
    if (!net) return;
    let budget = 25;
    const C = net.C, acc = net.acc;
    const counts = new Map();
    for (const p of this.peds) if (!p.dying) counts.set(p.st, (counts.get(p.st) || 0) + 1);
    let total = this.peds.length;
    for (let k = 0; k < C.stations.length && budget > 0; k++) {
      const s = C.stations[k];
      if (s.x < v.x0 || s.x > v.x1 || s.y < v.y0 || s.y > v.y1) continue;
      const tree = acc.trees[k];
      if (!tree || tree.verts.length < 2) continue;
      const flow = model.stFlowAt(k, W, 'stIn') + model.stFlowAt(k, W, 'stOut');
      const target = Math.min(36, flow * 0.006 * U.clamp(z / 30, 0.5, 1.5));
      if ((counts.get(k) || 0) >= target || total >= CFG.perf.maxPeds) continue;
      // 随机起点（步行 600 m 内）
      const m = this.treeMap(k, tree);
      let q = (Math.random() * tree.verts.length) | 0;
      if (tree.dist[q] > 650 || tree.dist[q] < 60) continue;
      const pts = [];
      let vtx = tree.verts[q], guard = 0;
      const side = (Math.random() - 0.5) * 0.12;
      while (vtx >= 0 && guard++ < 80) {
        pts.push([city.vx[vtx] + side, city.vy[vtx] + side]);
        const qi = m.get(vtx); if (qi === undefined) break;
        vtx = tree.pred[qi];
      }
      pts.push([s.x + side * 0.3, s.y + side * 0.3]);
      const inbound = Math.random() < (model.stFlowAt(k, W, 'stIn') + 1) / (flow + 2);
      if (!inbound) pts.reverse();
      const cum = U.cumLen(pts);
      const len = cum[cum.length - 1];
      if (len < 0.2) continue;
      this.peds.push({ pts: pts, cum: cum, len: len, s: 0, v: (1.1 + Math.random() * 0.5) * mps2cell, alpha: 0, st: k, color: PED_COLORS[(Math.random() * PED_COLORS.length) | 0] });
      budget--; total++;
    }
  };

  // ---------------- 绘制（汽车与行人） ----------------
  Agents.prototype.bucket = function (C) {
    const out = new Map(), road = this.roadRef, tmp = {};
    if (road) for (const c of this.cars) {
      if (c.alpha <= 0.01) continue;
      this.carWorld(c, road, tmp);
      c.wx = tmp.x; c.wy = tmp.y; c.wa = tmp.ang;
      const k = Math.floor(tmp.x / C) + ':' + Math.floor(tmp.y / C);
      let l = out.get(k); if (!l) { l = []; out.set(k, l); } l.push(c);
    }
    for (const p of this.peds) {
      if (p.alpha <= 0.01) continue;
      U.posAt(p.pts, p.cum, p.s, tmp);
      p.wx = tmp.x; p.wy = tmp.y; p.ped = true;
      const k = Math.floor(tmp.x / C) + ':' + Math.floor(tmp.y / C);
      let l = out.get(k); if (!l) { l = []; out.set(k, l); } l.push(p);
    }
    return out;
  };
  Agents.prototype.drawAll = function (ctx, R, alpha) {
    const road = this.roadRef, tmp = {};
    const list = [];
    if (road) for (const c of this.cars) { if (c.alpha <= 0.01) continue; this.carWorld(c, road, tmp); c.wx = tmp.x; c.wy = tmp.y; c.wa = tmp.ang; list.push(c); }
    for (const p of this.peds) { if (p.alpha <= 0.01) continue; U.posAt(p.pts, p.cum, p.s, tmp); p.wx = tmp.x; p.wy = tmp.y; p.ped = true; list.push(p); }
    this.drawList(ctx, R, list, alpha);
  };
  Agents.prototype.drawList = function (ctx, R, list, alpha) {
    const z = R.z, iso = R.tEase > 0.5, night = !!(R.th && R.th.night);
    const Lc = 0.085, wcar = U.clamp(z * 0.038, 1.6, 4.2);
    ctx.lineCap = 'round';
    const pa = {}, pb = {};
    for (const a of list) {
      ctx.globalAlpha = a.alpha * alpha;
      if (a.ped) {
        const p = R.P(a.wx, a.wy, 0, pa);
        ctx.fillStyle = a.color;
        if (iso) { ctx.fillRect(p.x - 0.8, p.y - 3.4, 1.6, 3); ctx.beginPath(); ctx.arc(p.x, p.y - 4.2, 1, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        continue;
      }
      const cx = Math.cos(a.wa) * Lc / 2, cy = Math.sin(a.wa) * Lc / 2;
      R.P(a.wx + cx, a.wy + cy, 0, pa); R.P(a.wx - cx, a.wy - cy, 0, pb);
      if (iso) {
        ctx.strokeStyle = 'rgba(40,40,50,0.25)'; ctx.lineWidth = wcar + 1;
        ctx.beginPath(); ctx.moveTo(pb.x, pb.y + 1); ctx.lineTo(pa.x, pa.y + 1); ctx.stroke();
      }
      ctx.strokeStyle = a.color; ctx.lineWidth = wcar;
      ctx.beginPath(); ctx.moveTo(pb.x, pb.y - (iso ? 1 : 0)); ctx.lineTo(pa.x, pa.y - (iso ? 1 : 0)); ctx.stroke();
      if (z > 30) { ctx.strokeStyle = 'rgba(30,40,60,0.45)'; ctx.lineWidth = wcar * 0.5; ctx.beginPath(); const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2; ctx.moveTo(mx, my - (iso ? 1 : 0)); ctx.lineTo(pa.x * 0.7 + mx * 0.3, pa.y * 0.7 + my * 0.3 - (iso ? 1 : 0)); ctx.stroke(); }
      if (night && z > 14) {
        // 夜间车灯：前白后红
        const dy = iso ? 1 : 0, rr = Math.max(0.9, wcar * 0.38);
        ctx.fillStyle = 'rgba(255,244,200,0.95)'; ctx.beginPath(); ctx.arc(pa.x, pa.y - dy, rr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,70,60,0.9)'; ctx.beginPath(); ctx.arc(pb.x, pb.y - dy, rr * 0.8, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
})(window.CM);
