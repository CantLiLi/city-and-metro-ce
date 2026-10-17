'use strict';
// 经营：资金、拨款、票款、运营费用、满意度、失败判定；任务：历史参考任务与动态任务
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA;

  function blankMonth(y, m, funds) {
    return { y: y, m: m, start: funds, grant: 0, fare: 0, construction: 0, demolition: 0, upgrade: 0, relocation: 0, ops: 0, reward: 0, days: 0, end: funds };
  }

  function Economy(mode, y, m) {
    this.mode = mode;
    this.funds = mode === 'free' ? 0 : CFG.economy.startFunds;
    this.fare = Object.assign({}, CFG.fareDefault);
    this.cur = blankMonth(y, m, this.funds);
    this.ledger = [];
    this.sat = CFG.economy.startSat;
    this.mods = [];
    this.negMonths = 0; this.lowSatMonths = 0;
    this.failed = null;
    this.lastDay = null;
    this.satFactors = null;
  }
  CM.Economy = Economy;

  Economy.prototype.isFree = function () { return this.mode === 'free'; };
  // 只检查新增的现金支出：零费用操作（如拆除既有设施）在负余额时也允许，便于止损
  Economy.prototype.canAfford = function (amount) { return this.isFree() || amount <= 0.5 || this.funds >= amount; };
  Economy.prototype.spend = function (kind, amount) {
    if (amount <= 0) return;
    this.cur[kind] = (this.cur[kind] || 0) + amount;
    if (!this.isFree()) this.funds -= amount;
  };
  Economy.prototype.income = function (kind, amount) {
    this.cur[kind] = (this.cur[kind] || 0) + amount;
    if (!this.isFree()) this.funds += amount;
  };
  Economy.prototype.costIndex = function (year) { return Math.pow(1 + CFG.cost.inflation, Math.max(0, year - 1990)); };
  Economy.prototype.opsIndex = function (year) { return Math.pow(1 + CFG.ops.inflation, Math.max(0, year - 1990)); };

  // 每日结算：票款与运营费用（均按当日典型工作日模拟结果）
  Economy.prototype.day = function (daily, compiled, year) {
    const fareWan = daily && daily.ready ? daily.fare / 10000 : 0;
    let ops = 0;
    if (daily && compiled) {
      const oi = this.opsIndex(year);
      ops += daily.carKm * CFG.ops.carKmCost * oi;
      for (const s of compiled.stations) ops += CFG.ops.stationDaily[s.size] * oi;
    }
    this.income('fare', fareWan);
    this.spend('ops', ops);
    this.cur.days++;
    this.lastDay = { fare: fareWan, ops: ops };
  };

  Economy.prototype.grantFor = function (y, m) {
    const ym = U.ymIndex(y, m);
    let f = 0.6 + 0.8 * this.sat / 100, mf = 1;
    for (const md of this.mods) if (md.kind === 'grant' && md.until >= ym) mf *= md.factor;
    return U.interp(CFG.economy.grantBase, y + (m - 1) / 12) * f * Math.max(0.6, mf);
  };
  Economy.prototype.grantFactors = function (y, m) {
    const ym = U.ymIndex(y, m);
    const list = [{ label: '满意度系数（' + Math.round(this.sat) + '）', f: 0.6 + 0.8 * this.sat / 100 }];
    for (const md of this.mods) if (md.kind === 'grant' && md.until >= ym) list.push({ label: md.reason + '（至 ' + Math.floor(md.until / 12) + '年' + (md.until % 12 + 1) + '月）', f: md.factor });
    return list;
  };
  // 新月份：先开新账（期初 = 上月期末），任务奖励等记入新月；再发放本月拨款
  Economy.prototype.openMonth = function (y, m) { this.cur = blankMonth(y, m, this.funds); };
  Economy.prototype.payGrant = function (y, m) {
    if (!this.isFree()) this.income('grant', this.grantFor(y, m));
    else this.cur.grant = 0;
  };
  Economy.prototype.startMonth = function (y, m) { this.openMonth(y, m); this.payGrant(y, m); };
  // 封账：记录期末并归档；之后的收支一律记入下一个月
  Economy.prototype.closeMonth = function () {
    this.cur.end = this.funds;
    this.cur.closed = true;
    this.ledger.push(this.cur);
    if (this.ledger.length > 600) this.ledger.shift();
    return this.cur;
  };

  // 满意度（0–100）：通勤、覆盖、拥堵、票价负担、拥挤
  Economy.prototype.updateSatisfaction = function (daily, model, y, m) {
    if (!daily || !daily.ready) return;
    const vot = U.interp(CFG.choice.vot, y);
    const f = [];
    f.push({ label: '平均通勤时间（' + Math.round(daily.commute) + ' 分钟）', v: 14 * U.clamp((40 - daily.commute) / 15, -1, 1) });
    f.push({ label: '地铁覆盖（' + U.fmtPct(daily.coverage, 0) + ' 人口）', v: 12 * U.clamp(daily.coverage / 0.5, 0, 1) });
    f.push({ label: '道路拥堵（指数 ' + daily.cong.toFixed(2) + '）', v: -14 * U.clamp((daily.cong - 1.25) / 0.8, 0, 1) });
    const burden = daily.metro > 1 ? daily.avgFare / (vot * 0.35) : 0;
    f.push({ label: '票价负担（平均 ' + daily.avgFare.toFixed(1) + ' 元）', v: -9 * U.clamp((burden - 1) / 2, 0, 1) });
    f.push({ label: '车厢拥挤（超载客公里 ' + U.fmtPct(daily.crowdShare, 0) + '）', v: -9 * U.clamp(daily.crowdShare / 0.25, 0, 1) });
    const ym = U.ymIndex(y, m);
    for (const md of this.mods) if (md.kind === 'sat' && md.until >= ym) f.push({ label: md.reason, v: md.delta });
    let target = 55;
    for (const x of f) target += x.v;
    target = U.clamp(target, 0, 100);
    this.sat = U.clamp(this.sat + (target - this.sat) * 0.25, 0, 100);
    this.satFactors = { base: 55, factors: f, target: target };
  };

  // 失败判定（仅经营挑战）
  Economy.prototype.checkFailure = function (y) {
    if (this.isFree() || this.failed) return null;
    const E = CFG.economy;
    const limit = E.debtLimit * this.costIndex(y);
    this.negMonths = this.funds < 0 ? this.negMonths + 1 : 0;
    this.lowSatMonths = this.sat < E.satFail ? this.lowSatMonths + 1 : 0;
    const reasons = [];
    if (this.funds < limit) reasons.push('资金低于负债下限（' + U.fmtMoney(this.funds) + '，下限 ' + U.fmtMoney(limit) + '）');
    if (this.negMonths >= E.negMonthsLimit) reasons.push('连续 ' + this.negMonths + ' 个月负余额（上限 ' + E.negMonthsLimit + ' 个月）');
    if (this.lowSatMonths >= E.satFailMonths) reasons.push('居民满意度连续 ' + this.lowSatMonths + ' 个月低于 ' + E.satFail + '，交通持续恶化');
    if (reasons.length) { this.failed = { reasons: reasons }; return this.failed; }
    return null;
  };
  Economy.prototype.warnings = function () {
    if (this.isFree()) return [];
    const E = CFG.economy, out = [];
    if (this.negMonths > 0) out.push({ level: this.negMonths >= E.negMonthsLimit * 0.6 ? 'danger' : 'warn', text: '财政预警：已连续 ' + this.negMonths + ' 个月负余额（满 ' + E.negMonthsLimit + ' 个月挑战失败）' });
    if (this.lowSatMonths > 0) out.push({ level: this.lowSatMonths >= E.satFailMonths * 0.6 ? 'danger' : 'warn', text: '交通预警：满意度已连续 ' + this.lowSatMonths + ' 个月低于 ' + E.satFail + '（满 ' + E.satFailMonths + ' 个月挑战失败）' });
    return out;
  };

  Economy.prototype.serialize = function () {
    return { mode: this.mode, funds: this.funds, fare: this.fare, cur: this.cur, ledger: this.ledger, sat: this.sat, mods: this.mods, negMonths: this.negMonths, lowSatMonths: this.lowSatMonths, failed: this.failed };
  };
  Economy.restore = function (s) {
    const e = new Economy(s.mode, s.cur.y, s.cur.m);
    Object.assign(e, { funds: s.funds, fare: Economy.normFare(s.fare), cur: s.cur, ledger: s.ledger || [], sat: s.sat, mods: s.mods || [], negMonths: s.negMonths || 0, lowSatMonths: s.lowSatMonths || 0, failed: s.failed || null });
    return e;
  };
  // 票制统一为全网单一票价；旧存档的里程计价按起步价换算
  Economy.normFare = function (f) {
    const R = CFG.fareRange;
    let v = f ? (f.mode === 'flat' ? f.flat : f.base) : CFG.fareDefault.flat;
    if (!isFinite(v)) v = CFG.fareDefault.flat;
    return { mode: 'flat', flat: U.clamp(Math.round(v / R.step) * R.step, R.min, R.max) };
  };
  // 票价对满意度的影响（与月度满意度计算同一公式）
  Economy.fareSatEffect = function (fare, year) {
    const vot = U.interp(CFG.choice.vot, year);
    const burden = fare / (vot * 0.35);
    return -9 * U.clamp((burden - 1) / 2, 0, 1);
  };

  // ======================== 任务 ========================
  function Tasks() {
    this.active = []; this.done = []; this.failed = [];
    this.issued = {};
    this.nextDyn = 0; this.seq = 1;
  }
  CM.Tasks = Tasks;

  // 网络连通分量（线路 + 站外换乘）
  function stationComponents(C, acc) {
    const N = C.stations.length, par = new Int32Array(N);
    for (let i = 0; i < N; i++) par[i] = i;
    const find = function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = function (a, b) { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (const r of C.routes) for (let k = 1; k < r.stIdx.length; k++) uni(r.stIdx[0], r.stIdx[k]);
    if (acc) for (const t of acc.transfers) uni(t.a, t.b);
    return { find: find, serviced: C.serviced };
  }
  Tasks.stationComponents = stationComponents;

  Tasks.prototype.evaluate = function (t, g) {
    const C = g.compiled, model = g.model, acc = model.net ? model.net.acc : null;
    if (t.type === 'connect') {
      const comp = stationComponents(C, acc);
      const anchorSets = t.anchors.map(function (a) {
        const set = [];
        C.stations.forEach(function (s, i) { if (C.serviced[i] && U.dist(s.x, s.y, a.x, a.y) <= a.r) set.push(i); });
        return set;
      });
      const hits = anchorSets.map(function (s) { return s.length > 0; });
      let ok = false;
      if (hits.every(Boolean)) {
        const roots = anchorSets.map(function (s) { return new Set(s.map(comp.find)); });
        for (const r of roots[0]) if (roots.every(function (S) { return S.has(r); })) { ok = true; break; }
      }
      const n = hits.filter(Boolean).length;
      return { ok: ok, value: ok ? 1 : n / (t.anchors.length + 1), text: t.anchors.map(function (a, i) { return (hits[i] ? '✓ ' : '✗ ') + a.name; }).join('；') + (hits.every(Boolean) && !ok ? '（车站尚未连通）' : '') };
    }
    if (t.type === 'coverage') {
      const v = acc ? acc.coverage : 0;
      return { ok: v >= t.target, value: v / t.target, text: '当前覆盖 ' + U.fmtPct(v) + ' / 目标 ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'zoneCong') {
      const v = g.zoneCong(t.zone);
      return { ok: v <= t.target, value: U.clamp((t.start - v) / Math.max(0.01, t.start - t.target), 0, 1), text: '早高峰拥堵指数 ' + v.toFixed(2) + ' / 目标 ≤ ' + t.target.toFixed(2) };
    }
    if (t.type === 'zoneCov') {
      const v = acc ? acc.zCov[t.zone] : 0;
      return { ok: v >= t.target, value: v / t.target, text: '该片区覆盖 ' + U.fmtPct(v) + ' / 目标 ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'stationCrowd') {
      const i = C.sIndex.get(t.station);
      if (i === undefined) return { ok: false, value: 0, text: '车站已拆除' };
      const peak = model.stDaily ? model.stDaily.peak[i] : 0;
      const cap = CFG.metro.stationCap[C.stations[i].size];
      const v = peak / cap;
      return { ok: v <= t.target, value: U.clamp((t.start - v) / Math.max(0.01, t.start - t.target), 0, 1), text: '高峰负荷 ' + U.fmtPct(v, 0) + ' / 目标 ≤ ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'ridership') {
      const v = model.daily ? model.daily.metro : 0;
      return { ok: v >= t.target, value: v / t.target, text: '日均客运量 ' + U.fmtPeople(v) + ' / 目标 ' + U.fmtPeople(t.target) };
    }
    if (t.type === 'recovery') {
      const last = g.econ.ledger[g.econ.ledger.length - 1];
      const v = last && last.ops > 0 ? last.fare / last.ops : 0;
      return { ok: v >= t.target, value: v / t.target, text: '上月票款/运营费用 ' + U.fmtPct(v, 0) + ' / 目标 ' + U.fmtPct(t.target, 0) + (t.sustain ? '（需连续 ' + t.sustain + ' 个月，已 ' + (t.streak || 0) + ' 个月）' : '') };
    }
    return { ok: false, value: 0, text: '' };
  };

  Tasks.prototype.monthly = function (g) {
    const y = g.clock.y, m = g.clock.m, ym = U.ymIndex(y, m);
    const out = [];
    const challenge = g.econ.mode === 'challenge';
    // 发布历史参考任务
    for (const h of D.histTasks) {
      if (this.issued[h.id]) continue;
      if (ym < U.ymIndex(h.appear[0], h.appear[1])) continue;
      this.issued[h.id] = 1;
      if (ym > U.ymIndex(h.deadline[0], h.deadline[1])) continue;
      const t = Object.assign({ kind: 'hist', status: 'active', issuedAt: [y, m], streak: 0 }, JSON.parse(JSON.stringify(h)));
      t.reward = h.reward * g.econ.costIndex(y);
      this.active.push(t);
      out.push({ type: 'issued', task: t });
    }
    // 动态任务（开局一年后开始）
    if (!this.nextDyn) this.nextDyn = ym + 12;
    if (!D.noDynTasks && ym >= this.nextDyn && this.active.filter(function (t) { return t.kind === 'dyn'; }).length < 2 && g.compiled.stations.length >= 0) {
      const t = this.generate(g);
      if (t) { this.active.push(t); out.push({ type: 'issued', task: t }); }
      this.nextDyn = ym + 6;
    }
    // 评估
    for (const t of this.active.slice()) {
      const ev = this.evaluate(t, g);
      t.progress = ev;
      let complete = false;
      if (ev.ok) {
        t.streak = (t.streak || 0) + 1;
        if (!t.sustain || t.streak >= t.sustain) complete = true;
      } else t.streak = 0;
      if (t.kind === 'dyn' && (complete || ym >= U.ymIndex(t.deadline[0], t.deadline[1]))) {
        this.cool = this.cool || {};
        this.cool[t.coolKey || t.type] = ym + (complete ? 24 : 36);
        this.cool['type:' + t.type] = ym + (complete ? 6 : 18);
      }
      if (complete) {
        t.status = 'done'; t.closedAt = [y, m];
        this.active.splice(this.active.indexOf(t), 1); this.done.push(t);
        if (challenge) { g.econ.income('reward', t.reward); g.econ.mods.push({ kind: 'sat', delta: 4, until: ym + 6, reason: '完成任务「' + t.title + '」' }); }
        out.push({ type: 'done', task: t });
      } else if (ym >= U.ymIndex(t.deadline[0], t.deadline[1])) {
        t.status = 'failed'; t.closedAt = [y, m];
        this.active.splice(this.active.indexOf(t), 1); this.failed.push(t);
        if (challenge) {
          const E = CFG.economy;
          g.econ.mods.push({ kind: 'grant', factor: E.failGrantFactor, until: ym + E.failGrantMonths, reason: '任务未完成：' + t.title });
          g.econ.mods.push({ kind: 'sat', delta: E.failSat, until: ym + 12, reason: '任务未完成：' + t.title });
        }
        out.push({ type: 'failed', task: t });
      }
    }
    if (this.done.length > 60) this.done.splice(0, this.done.length - 60);
    if (this.failed.length > 60) this.failed.splice(0, this.failed.length - 60);
    return out;
  };

  Tasks.prototype.generate = function (g) {
    const y = g.clock.y, m = g.clock.m, model = g.model, city = g.city;
    const acc = model.net ? model.net.acc : null;
    const ci = g.econ.costIndex(y);
    const dl = function (months) { const t = U.ymIndex(y, m) + months; return [Math.floor(t / 12), t % 12 + 1]; };
    const rng = new U.RNG((y * 13 + m * 7 + this.seq * 31) >>> 0);
    const ym = U.ymIndex(y, m);
    const cool = this.cool || (this.cool = {});
    const active = this.active;
    const free = function (key, type) { return !(cool[key] > ym) && !(cool['type:' + type] > ym) && !active.some(function (t) { return (t.coolKey || t.type) === key; }); };
    const cands = [];
    // 拥堵热点（排除近期出过任务的片区）
    let worst = -1, wv = 0;
    const zoneOpen = function (z) { const cs = model.zoneCells[z]; let n = 0; for (const c of cs) if (city.regionOpen[city.region[c]] && !city.regions[city.region[c]].scenic) n++; return n >= cs.length / 2; };
    for (let z = 0; z < model.Z; z++) {
      if (model.zPop[z] + model.zJobs[z] < 3000 || !zoneOpen(z) || !free('cong:' + z, 'zoneCong')) continue;
      const v = g.zoneCong(z);
      if (v > wv) { wv = v; worst = z; }
    }
    if (worst >= 0 && wv > 1.4) {
      cands.push({ type: 'zoneCong', coolKey: 'cong:' + worst, zone: worst, start: wv, target: Math.max(1.15, 1 + (wv - 1) * 0.6), sustain: 3, title: '缓解「' + g.zoneName(worst) + '」交通拥堵', desc: '该片区早高峰道路拥堵严重。通过地铁吸引汽车出行，将片区早高峰拥堵指数降至目标值，并连续保持 3 个月。', months: 30, reward: 60000 * ci });
    }
    // 覆盖空白
    if (acc) {
      let best = -1, bp = 0;
      for (let z = 0; z < model.Z; z++) {
        const p = model.zPop[z];
        if (p > bp && acc.zCov[z] < 0.2 && zoneOpen(z) && free('cov:' + z, 'zoneCov')) { bp = p; best = z; }
      }
      if (best >= 0 && bp > 12000) {
        cands.push({ type: 'zoneCov', coolKey: 'cov:' + best, zone: best, target: 0.5, title: '为「' + g.zoneName(best) + '」提供地铁服务', desc: '该片区人口约 ' + U.fmtPeople(bp) + '，尚无地铁覆盖。使片区 50% 以上的居民与岗位步行 15 分钟可达车站。', months: 30, reward: 50000 * ci });
      }
    }
    // 车站拥挤
    if (model.stDaily && g.compiled.stations.length) {
      let bs = -1, br = 0;
      g.compiled.stations.forEach(function (s, i) {
        if (!free('st:' + s.id, 'stationCrowd')) return;
        const r = model.stDaily.peak[i] / CFG.metro.stationCap[s.size];
        if (r > br) { br = r; bs = i; }
      });
      if (bs >= 0 && br > 1.0) {
        const s = g.compiled.stations[bs];
        cands.push({ type: 'stationCrowd', coolKey: 'st:' + s.id, station: s.id, start: br, target: 0.9, title: '缓解「' + s.name + '」车站拥挤', desc: '高峰时段车站负荷已达 ' + U.fmtPct(br, 0) + '。可升级车站或分流客流，使高峰负荷降至 90% 以下。', months: 12, reward: 30000 * ci });
      }
    }
    // 客流增长
    if (model.daily && model.daily.metro > 20000 && free('ridership', 'ridership')) {
      cands.push({ type: 'ridership', target: Math.round(model.daily.metro * 1.2 / 1000) * 1000, title: '提升地铁客运量', desc: '在期限内使日均地铁客运量较当前提高 20%（可通过新线、延长线、换乘或调整票价实现）。', months: 24, reward: 40000 * ci });
    }
    // 经营：票款覆盖
    if (g.econ.mode === 'challenge' && model.daily && model.daily.metro > 50000 && free('recovery', 'recovery')) {
      cands.push({ type: 'recovery', target: 0.7, sustain: 3, title: '改善运营收支', desc: '连续 3 个月票款收入不低于运营费用的 70%。', months: 24, reward: 40000 * ci });
    }
    if (!cands.length) return null;
    const c = cands[Math.floor(rng.next() * cands.length)];
    const t = Object.assign({ id: 'd' + (this.seq++), kind: 'dyn', status: 'active', issuedAt: [y, m], deadline: dl(c.months), streak: 0 }, c);
    return t;
  };

  Tasks.prototype.serialize = function () { return { active: this.active, done: this.done, failed: this.failed, issued: this.issued, nextDyn: this.nextDyn, seq: this.seq, cool: this.cool || {} }; };
  Tasks.restore = function (s) { const t = new Tasks(); Object.assign(t, s); return t; };
})(window.CM);
