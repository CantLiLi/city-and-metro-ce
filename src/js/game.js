'use strict';
// 游戏状态与流程：时钟、日/月结算、跳月/跳年、建设草案、预测与存档序列化
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA, M = CM.Metro;

  function Game() {
    U.Emitter.call(this);
    this.speed = 0;
    this.pending = null;
    this.jumping = null;
    this.draft = null;
    this.plans = [];
    this.plansById = Object.create(null);
    this.planSeq = 0;
    this.planActive = null;
    this.events = [];
    this.history = [];
    this.netVersion = 0;
    this.rev = 0;            // 持久状态版本：日结算、建设、票价等变化时递增（时钟另行比较）
    this.favs = { stations: [], lines: [] };
  }
  Game.prototype = Object.create(U.Emitter.prototype);
  CM.Game = Game;
  Game.prototype.touch = function () { this.rev++; };

  Game.create = function (opts) {
    const g = new Game();
    g.id = U.uid('g');
    g.mapId = CM.mapId || 'gz';   // 当前地图（CM.useMap 已切换好数据）
    g.name = opts.name || ((D.city || '广州') + ' ' + CFG.START.y);
    g.mode = opts.mode;
    g.seed = opts.seed || (CFG.START.y * 10000 + 101);
    if (opts.tutorial) g.tutorial = { step: 0, done: [], started: Date.now() };
    g.createdAt = Date.now();
    g.clock = Object.assign({}, CFG.START);
    g.city = new CM.City();
    g.city.generate(g.seed, g.clock.y);
    g.model = new CM.Model(g.city);
    g.model.setYear(g.clock.y);
    g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
    g.traffic = { v: CFG.TRAFFIC_MODEL };
    g.net = M.empty();
    g.mapInit = buildInitialNetwork(g);   // 开局既有地铁（东京 1950 年等），只在新建时生成一次，随存档保存
    g.compiled = M.compile(g.net, g.city);
    g.model.setNetwork(g.compiled);
    g.econ = new CM.Economy(g.mode, g.clock.y, g.clock.m);
    g.model.fare = g.econ.fare;
    g.tasks = new CM.Tasks();
    g.model.solveNow(2);
    g.econ.startMonth(g.clock.y, g.clock.m);
    const e0 = D.events && D.events[0];
    if (e0) g.logEvent({ tag: e0.tag || '史实', title: e0.title, desc: e0.desc });
    g.firedEvents = { 0: 1 };
    g.tasks.monthly(g).forEach(function (o) { g.logTask(o); });
    // 城市经济：真实城市开局即接入（教程不启用）；开局当月已发生的经济事件一并记录
    if (CM.Macro) for (const x of CM.Macro.create(g) || []) g.logMacroEvent(x);
    g.recordHistory();
    if (CM.Milestones) CM.Milestones.onStart(g);
    return g;
  };

  // 开局时已运营的真实地铁：直接属于玩家，不收取历史建设费；之后正常产生运营费用与票款，可改造、扩建或拆除
  // 一次编辑动到的对象：新建 / 修改 / 拆除的车站、轨道、线路都记上，供方案归属回溯
  function keySet(net) {
    const s = {};
    for (const k in net.stations) s[k] = JSON.stringify(net.stations[k]);
    for (const k in net.segments) s[k] = JSON.stringify(net.segments[k]);
    for (const k in net.lines) s[k] = JSON.stringify(net.lines[k]);
    return s;
  }
  function keyDiff(pre, net) {
    const out = {};
    const cur = keySet(net);
    for (const k in cur) if (pre[k] !== cur[k]) out[k] = 1;
    for (const k in pre) if (!cur[k]) out[k] = 1;
    return out;
  }
  function buildInitialNetwork(g) {
    const IN = D.initialNetwork; if (!IN) return null;
    const net = g.net, city = g.city, desc = [];
    for (const L of IN.lines) {
      const lid = M.newLine(net);
      if (L.color) net.lines[lid].color = L.color;
      if (L.name) net.lines[lid].name = L.name;
      let prev = null;
      for (const st of L.stations) {
        const sid = M.addStation(net, st[1], st[2], { size: st[3] || L.size || 'M', type: L.type || 'underground' }, city);
        const s = net.stations[sid]; s.name = st[0]; s.built = [st[4] || L.year || CFG.START.y, 1]; s.site = [s.x, s.y]; s.inherited = true;
        if (prev) M.addSegment(net, lid, prev, sid, [], L.type || 'underground');
        prev = sid;
      }
      desc.push(net.lines[lid].name + ' ' + L.stations[0][0] + '—' + L.stations[L.stations.length - 1][0] + '（' + L.stations.length + ' 站）');
    }
    M.normalizeLines(net);
    for (const id in net.segments) { net.segments[id].built = [IN.year || CFG.START.y, 1]; net.segments[id].inherited = true; }
    return { metro: (IN.note ? IN.note + '：' : '') + desc.join('；'), year: CFG.START.y };
  }

  Game.prototype.year = function () { return this.clock.y + (this.clock.m - 1) / 12 + (this.clock.d - 1) / 365; };
  Game.prototype.ym = function () { return U.ymIndex(this.clock.y, this.clock.m); };
  Game.prototype.logEvent = function (e) {
    e.y = e.y || this.clock.y; e.m = e.m || this.clock.m;
    this.events.push(e);
    if (this.events.length > 400) this.events.shift();
    this.emit('event', e);
  };
  // 经济事件：记入城市纪事的事件列表（史实 / 模拟），说明本城受影响的程度
  Game.prototype.logMacroEvent = function (x) {
    const ev = x.ev, f = x.f, k = f.k, neg = Math.min.apply(null, ev.lv) < 0;
    const peak = ev.lv.reduce(function (a, v) { return Math.abs(v) > Math.abs(a) ? v : a; }, 0) * k;
    const lvl = Math.abs(peak) < 0.005 ? '较小' : (Math.abs(peak) < 0.02 ? '中等' : (Math.abs(peak) < 0.045 ? '较大' : '严重'));
    const sim = ev.tag === '模拟', name = ev.title.replace(/^模拟：/, '');
    this.logEvent({ tag: ev.tag || '史实', kind: 'econ', econId: ev.id, title: (sim ? '经济（模拟）：' : '经济：') + name, desc: ev.desc + (neg ? ' 对本城经济的影响：' + lvl + '。' : ' 对本城经济的带动：' + lvl + '。') });
    this.emit('toast', { kind: neg ? 'warn' : 'info', text: sim ? '经济（模拟）：' + name : ev.y + ' 年：' + name });
    this.emit('macroEvent', x);
  };
  Game.prototype.logTask = function (o) {
    const t = o.task;
    if (o.type === 'issued') { this.logEvent({ tag: '任务', title: '新任务：' + t.title, desc: t.desc }); this.emit('toast', { kind: 'info', text: '新任务：' + t.title }); }
    else if (o.type === 'done') { this.logEvent({ tag: '任务', title: '任务完成：' + t.title, desc: this.econ.mode === 'challenge' ? '获得奖励拨款 ' + U.fmtMoney(t.reward) : '' }); this.emit('toast', { kind: 'good', text: '任务完成：' + t.title }); }
    else if (o.type === 'failed') { this.logEvent({ tag: '任务', title: '任务未完成：' + t.title, desc: this.econ.mode === 'challenge' ? '后果：未来 ' + CFG.economy.failGrantMonths + ' 个月（含本月）拨款 ×' + CFG.economy.failGrantFactor + '，满意度下降' : '自由建造模式下无后果' }); this.emit('toast', { kind: 'bad', text: '任务未完成：' + t.title }); }
  };

  // ---------------- 时钟 ----------------
  Game.prototype.setSpeed = function (s) { this.speed = s; this.emit('speed', s); };
  Game.prototype.update = function (dt) {
    const budget = CFG.perf.solverBudgetMs;
    if (this.jumping) { this.stepJump(); return; }
    if (this.pending) {
      const t0 = performance.now();
      while (this.pending && performance.now() - t0 < 6) {
        const r = this.pending.next();
        if (r.done) this.pending = null;
      }
      this.model.step(2);
      return;
    }
    if (this.speed > 0 && !this.econ.failed) {
      let mins = dt * CFG.time.speeds[this.speed - 1] / CFG.time.secPerHour * 60;
      this.clock.minute += mins;
      if (this.clock.minute >= 1440) {
        this.clock.minute -= 1440;
        if (this.clock.minute >= 1440) this.clock.minute = 0;
        if (this.endDay()) this.pending = this.monthGen();
      }
    }
    this.model.step(budget);
  };
  // 日终：按当天的日类型（工作日 / 周末）结算票款与运营费用，推进日期；返回是否跨月
  Game.prototype.dayType = function () { return CM.Model.dayType(this.clock.y, this.clock.m, this.clock.d); };
  Game.prototype.endDay = function () {
    const dt = this.dayType();
    this.econ.day(this.model.dailyFor(dt), this.compiled, this.clock.y, dt);
    this.clock.d++;
    this.rev++;
    if (this.clock.d > U.daysInMonth(this.clock.y, this.clock.m)) {
      this.clock.d = 1;
      this.econ.closeMonth();
      const f = this.econ.checkFailure(this.clock.y, this.inTransition(U.ymIndex(this.clock.y, this.clock.m) + 1));
      this.clock.m++;
      if (this.clock.m > 12) { this.clock.m = 1; this.clock.y++; }
      this.model.setDayType(this.dayType());
      if (f) this.onFailure(f);
      return true;
    }
    this.model.setDayType(this.dayType());
    this.emit('day');
    return false;
  };
  // 交通模型升级过渡期（旧存档升级当月，至该月月末结算）：满意度不因统计口径变化而下降，任务不判失败、连续进度不清零
  Game.prototype.inTransition = function (ym) { const t = this.traffic; return !!(t && t.until != null && ym <= t.until); };
  Game.prototype.onFailure = function (f) {
    this.setSpeed(0);
    this.logEvent({ tag: '经营', title: '经营挑战失败', desc: f.reasons.join('；') });
    this.emit('failed', f);
  };

  // 月度处理（分步执行，避免画面卡顿）
  Game.prototype.monthGen = function* () {
    const y = this.clock.y, m = this.clock.m, city = this.city, model = this.model;
    // 城市更新前停止旧预测，避免分步刷新后恢复到旧需求或旧路网的计算中。
    if (this.draft) this.invalidatePrediction('城市正在更新，请在结算完成后重新计算预测');
    const yr = y + (m - 1) / 12;
    model.setYear(yr);
    // 历史事件
    D.events.forEach((e, k) => {
      if (this.firedEvents[k]) return;
      if (U.ymIndex(e.y, e.m) <= U.ymIndex(y, m)) { this.firedEvents[k] = 1; this.logEvent({ tag: e.tag, title: e.title, desc: e.desc }); this.emit('toast', { kind: 'info', text: e.y + ' 年：' + e.title }); if (CM.Milestones) CM.Milestones.onEvent(this, e, k); }
    });
    // 城市经济：1 月结算上一年 GDP 与地方财政、确定本年预算与经济周期；触发到期的经济事件（每个事件只生效一次）
    if (this.macro && CM.Macro) for (const x of CM.Macro.month(this, y, m)) this.logMacroEvent(x);
    const ef = this.macro && CM.Macro ? CM.Macro.cityFactors(this) : null;
    if (D.airport && yr >= D.airport.closeYear + 7 / 12) {
      if (city.lu.some(function (v) { return v === CM.LU.AIRPORT; })) city.closeAirport();
    }
    let roadsChanged = false;
    // 系统填海：到达年份的填海土地成陆（之后可开发与建设）
    for (const r of city.applyReclaim(y)) {
      roadsChanged = true;
      this.logEvent({ tag: r.tag || '史实', title: '填海成陆：' + r.name, desc: r.desc || '新土地将逐步开发，之后可以在此建站与铺轨。' });
      this.emit('toast', { kind: 'info', text: '填海成陆：' + r.name });
      if (CM.Milestones) CM.Milestones.onReclaim(this, r);
    }
    const before = city.roadsBuilt.slice();
    if (city.applyRoads(y)) {
      roadsChanged = true;
      const told = new Set();
      city.roadGroups.forEach((r, k) => {
        if (before[k] || !city.roadsBuilt[k] || !r.notable || !r.name || told.has(r.name) || r.cls < 2) return;
        told.add(r.name);
        this.logEvent({ tag: r.sim ? '模拟' : '史实', title: r.name + (r.sim ? '建成（模拟规划）' : '通车（参考）'), desc: '' });
      });
    }
    const lmBefore = city.landmarkOn.slice();
    city.activateLandmarks(y);
    if (CM.Milestones) CM.Milestones.onLandmarks(this, lmBefore);
    // 区域开放
    const tot = city.totals();
    for (let k = 0; k < city.regions.length; k++) {
      const rg = city.regions[k];
      if (city.regionOpen[k] || rg.open == null) continue;
      if (rg.id === 'airport' && !D.airport.buildable && yr < D.airport.closeYear + 7 / 12) continue;
      const byYear = y >= rg.open;
      // 人口提前达到门槛时可提前开放；经济繁荣时提前窗口放宽一年，衰退时门槛略为提高
      const early = rg.pop && tot.pop >= rg.pop * (ef && ef.dev < -0.03 ? 1.03 : 1) && y >= rg.open - (ef && ef.dev > 0.02 ? 4 : 3);
      if (byYear || early) {
        city.openRegion(k, y, m);
        const why = byYear ? '参考 ' + rg.open + ' 年开放' : '城市人口增长，提前开放（参考 ' + rg.open + ' 年）';
        this.logEvent({ tag: byYear ? '史实' : '模拟', title: '新区域开放：' + rg.name, desc: why + (rg.note ? '。' + rg.note : '') });
        this.emit('toast', { kind: 'info', text: '新区域开放：' + rg.name });
      }
    }
    yield;
    // 城市发展
    const acc = model.net ? model.net.acc : null;
    const econF = this.macro && CM.Macro ? CM.Macro.applyFactors(this) : null;
    const gr = city.growMonth({ year: yr, monthIndex: this.ym(), zoneAccess: model.zoneAccessNorm, cellWalk: acc ? acc.cellWalk : null, coverage: acc ? acc.coverage : 0, econ: econF });
    yield;
    if (gr.streetsChanged || roadsChanged) { if (roadsChanged) city.updateStreets(); city.buildGraphs(); yield; }
    // 编译与模型刷新分多步执行；this.compiled 与模型网络在同一步内一起替换
    const C = M.compile(this.net, city);
    yield;
    yield* model.refreshCityGen(C);
    this.compiled = C;
    if (this.macro && CM.Macro) CM.Macro.sample(this);   // 本月的岗位与交通效率（年度 GDP 取全年平均）
    yield;
    // 经营与任务：上月已封账，先开新月账本，任务奖励记入新月，最后按本月任务结果发放拨款
    // 满意度按周平均日（5 个工作日 + 2 个周末日）计算，通勤时间按工作日；升级过渡期内不因统计口径变化而下降
    this.econ.updateSatisfaction(model.daily, model, y, m, { protect: this.inTransition(this.ym()) });
    this.econ.openMonth(y, m);
    this.tasks.monthly(this).forEach((o) => this.logTask(o));
    this.econ.payGrant(y, m);
    this.econ.serviceDebt(y, m);   // 债券：到期利息与本金、逾期处理（每月一次，不会重复结算）
    this.recordHistory();
    if (CM.Milestones) CM.Milestones.onMonth(this);
    if (this.draft) {
      this.draft.evalVer = -1; this.draft.compVer = -1;
      this.invalidatePrediction('城市状态已更新（' + y + '年' + m + '月），请重新计算预测');
    }
    this.emit('month', { y: y, m: m });
  };

  // ---------------- 债券融资（经营挑战） ----------------
  Game.prototype.issueBond = function (kind, term, amount) {
    if (this.jumping || this.pending) return { ok: false, error: '正在结算，请稍候再发行债券' };
    const r = this.econ.issueBond(kind, term, amount, { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    if (!r.ok) return r;
    const b = r.bond, D0 = CM.Economy.BOND_DEF[kind];
    this.rev++;
    this.logEvent({ tag: '经营', title: '发行' + D0.name + ' ' + U.fmtMoney(b.amount), desc: term + ' 年期，年利率 ' + (b.rate * 100).toFixed(2) + '%，每年付息、' + (b.issued[0] + term) + '年' + b.issued[1] + '月到期还本；资金进入建设专项资金，只能用于地铁建设及改扩建。' });
    this.emit('finance');
    return r;
  };
  // 月度历史：客流、分担率与拥堵为周平均日（v1.9 起，tm: 2）；此前的记录为典型工作日口径（不重算）
  Game.prototype.recordHistory = function () {
    const d = this.model.daily || {}, dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    const tot = this.city.totals();
    const last = this.econ.ledger[this.econ.ledger.length - 1];
    this.history.push({
      y: this.clock.y, m: this.clock.m, pop: tot.pop, jobs: tot.jobs, share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0,
      riders: d.metro || 0, sat: this.econ.sat, funds: this.econ.isFree() ? null : this.econ.funds, coverage: d.coverage || 0,
      debt: this.econ.isFree() ? null : this.econ.debtTotal(), capex: this.econ.isFree() ? null : this.econ.capex,
      fare: last ? last.fare : 0, ops: last ? last.ops : 0, grant: last ? last.grant : 0, stations: this.compiled.stations.length,
      trips: d.trips || 0, crowd: d.crowdShare || 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0, tm: CFG.TRAFFIC_MODEL,
    });
    if (this.history.length > 1200) this.history.shift();
  };

  // ---------------- 跳月 / 跳年 ----------------
  Game.prototype.startJump = function (months) {
    if (this.jumping || this.pending) return false;
    if (this.draft) this.invalidatePrediction();
    const t = U.ymIndex(this.clock.y, this.clock.m) + months;
    const ty = Math.floor(t / 12), tm = t % 12 + 1;
    const td = Math.min(this.clock.d, U.daysInMonth(ty, tm));
    const snap = this.snapshotMetrics();
    const total = Math.max(1, months * 30);
    this.jumping = { months: months, target: [ty, tm, td], from: [this.clock.y, this.clock.m, this.clock.d], snap: snap, progress: 0, total: total, gen: this.jumpGen(ty, tm, td, months, total) };
    this.prevSpeed = this.speed;
    this.speed = 0;
    this.emit('jump', this.jumping);
    return true;
  };
  Game.prototype.jumpGen = function* (ty, tm, td, months, total) {
    let n = 0;
    const tgt = U.ymIndex(ty, tm) * 32 + td;
    while (U.ymIndex(this.clock.y, this.clock.m) * 32 + this.clock.d < tgt && !this.econ.failed) {
      const crossed = this.endDay();
      n++;
      this.jumping.progress = Math.min(0.98, n / total);
      if (crossed) {
        yield* this.monthGen();
        const mi = this.ym();
        // 短跳每月两类都求解；长跳每月轮流求解工作日与周末（每类每 2 个月更新一次，与单一日类型时的更新频率相同）
        if (months <= 3 || U.ymIndex(this.clock.y, this.clock.m) * 32 + this.clock.d >= tgt) yield* this.model.solveGen(1);
        else yield* this.model.solveGen(1, [mi % 2 === 0 ? 'wd' : 'we']);
      }
      if ((n & 7) === 0) yield;
    }
    yield* this.model.solveGen(1);
  };
  Game.prototype.stepJump = function () {
    const j = this.jumping, t0 = performance.now();
    while (performance.now() - t0 < 14) {
      const r = j.gen.next();
      if (r.done) {
        this.jumping = null;
        this.speed = 0;
        this.recordHistoryIfNeeded();
        const res = { from: j.from, to: [this.clock.y, this.clock.m, this.clock.d], before: j.snap, after: this.snapshotMetrics(), failed: this.econ.failed };
        this.emit('jumpDone', res);
        return;
      }
    }
    this.emit('jumpProgress', j.progress);
  };
  Game.prototype.recordHistoryIfNeeded = function () {};
  Game.prototype.snapshotMetrics = function () {
    const d = this.model.daily || {};
    const tot = this.city.totals();
    let open = 0; for (let k = 0; k < this.city.regions.length; k++) open += this.city.regionOpen[k];
    const dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    return { pop: tot.pop, jobs: tot.jobs, funds: this.econ.funds, capex: this.econ.capex, debt: this.econ.debtTotal(), share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0, riders: d.metro || 0, sat: this.econ.sat, regions: open, events: this.events.length, tasksDone: this.tasks.done.length, tasksFailed: this.tasks.failed.length,
      coverage: d.coverage || 0, stations: this.compiled.stations.length, fiscF: this.econ.fiscalFactor(), macroRecs: this.macro ? this.macro.rec.length : 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0 };
  };

  // ---------------- 建设草案 ----------------
  Game.prototype.ensureDraft = function () {
    if (!this.draft) {
      this.draft = { net: M.clone(this.net), undo: [], redo: [], ver: 1, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' }, coverage: [] };

      this.emit('draft');
    }
    return this.draft;
  };
  // 草案编辑：出错、抛出异常或产生不完整网络时整体回滚，不留下失效轨道
  // opts.tag：把本次改动记入某个方案的修改痕迹（own:true 表示该方案自己改的，不计入其它方案的偏移）
  Game.prototype.edit = function (fn, opts) {
    const d = this.ensureDraft();
    const snap = JSON.stringify(d.net);
    const pre = keySet(d.net);
    let r;
    try { r = fn(d.net); } catch (e) { console.error(e); r = { error: '操作未能完成，已撤回（' + e.message + '）' }; }
    if (!(r && r.error)) { const bad = M.validate(d.net); if (bad) r = { error: '操作已撤回：' + bad }; }
    if (r && r.error) { d.net = JSON.parse(snap); return r; }
    d.undo.push(snap); if (d.undo.length > 120) d.undo.shift();
    d.redo = [];
    d.ver++;
    if (opts && opts.tag) this.attachPlan(opts.tag, opts.own === undefined ? true : opts.own, keyDiff(pre, d.net));
    else if (opts !== false) this.attachPlan(null, false, keyDiff(pre, d.net));
    this.invalidatePrediction();
    this.emit('draft');
    return r || {};
  };
  // 编辑某个方案：从它已经建设好的状态出发，把本次改动记为该方案的方案内容
  Game.prototype.editPlan = function (pid, fn) {
    const p = this.plansById[pid];
    if (!p || !this.draft || !this.draft.net) return { error: p ? '请先结束当前的轨道拖动' : '草案不存在，请重新打开方案面板' };
    p.touched = true;
    const notes = [];
    let lid = null;
    const r = this.edit(function (net) {
      const n = fn(net);
      if (n && n.notes) notes.push.apply(notes, n.notes);
      if (n && n.line) lid = n.line;
    }, { tag: pid, own: true });
    if (r && r.error) { if (!p.touched) p.touched = false; }
    else if (lid && p.lineId !== lid) { p.lineId = lid; notes.push('方案新建线路「' + (this.draft.net.lines[lid] ? this.draft.net.lines[lid].name : '') + '」'); }
    if (notes.length) { p.notes = p.notes || []; for (const s of notes) if (p.notes.indexOf(s) < 0) p.notes.push(s); }
    return r;
  };
  // 草案的改动归属：每次编辑记一条（方案自己的改动 / 直接在地图上的改动），并记下这次动到的对象
  Game.prototype.attachPlan = function (pid, own, keys) {
    const d = this.draft; if (!d) return;
    d.coverage.push({ plan: own ? pid : null, own: !!own, keys: keys || null });
    if (own) { const p = this.plansById[pid]; if (p) p.touched = true; }
  };
  // 拖动等连续编辑：开始时记一次撤销点
  Game.prototype.beginLive = function () { const d = this.ensureDraft(); d.liveSnap = JSON.stringify(d.net); d.livePlan = this.planActive; d.livePre = keySet(d.net); };
  Game.prototype.liveEdit = function (fn) { const d = this.ensureDraft(); fn(d.net); d.ver++; this.invalidatePrediction(); this.emit('draftLive'); };
  Game.prototype.endLive = function (changed) {
    const d = this.draft; if (!d || !d.liveSnap) return;
    if (changed) { d.undo.push(d.liveSnap); if (d.undo.length > 120) d.undo.shift(); d.redo = []; this.attachPlan(d.livePlan || this.planActive, true, d.livePre ? keyDiff(d.livePre, d.net) : null); }
    else d.net = JSON.parse(d.liveSnap);
    d.livePlan = null; d.liveSnap = null; d.livePre = null; d.ver++; this.invalidatePrediction(); this.emit('draft');
  };
  Game.prototype.undo = function () {
    const d = this.draft; if (!d || !d.undo.length) return false;
    d.redo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.undo.pop()); d.ver++;
    if (d.coverage && d.coverage.length) d.coverage.pop();
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.redo = function () {
    const d = this.draft; if (!d || !d.redo.length) return false;
    d.undo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.redo.pop()); d.ver++;
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.cancelDraft = function () {
    this.plans = []; this.plansById = Object.create(null); this.planActive = null;
    if (!this.draft) return;
    this.model.cancelPredict();
    this.draft = null;
    this.emit('draft');
  };

  // ---------------- 方案 ----------------
  // 方案 = 草案里的一组改动（新建站点 / 新建线路 / 调整既有）。草案是各方案叠加后的结果；
  // 确认某个方案时只建它自己那部分，其余方案自动去掉已被建成的部分。方案随草案一起作废。
  // 标识：'n:对象键' 为新建（车站 / 轨道 / 线路），'b:id' 为既有对象。
  Game.prototype.planIds = function () { return [null].concat(this.plans.map(function (p) { return p.id; })); };
  // 某次改动（对象键 key）的归属方案：回溯覆盖记录，看哪一条真正动过这个对象
  Game.prototype.planOwner = function (key, by) {
    const d = this.draft; if (!d || !d.coverage.length) return undefined;
    by = by === undefined || by === null ? d.coverage.length - 1 : by;
    for (let i = by; i >= 0; i--) {
      const cov = d.coverage[i];
      // keys 为 null 表示「没记录的改动」：只能解释没记录过的东西，不能接管别人建造时的具体键
      if (cov.keys ? !cov.keys[key] : cov.own) continue;
      if (cov.plan) return cov.plan;
      if (cov.grp == null) cov.grp = this.coverageGroup(key, i);
      return cov.grp;
    }
    return null;
  };
  // 直接改在地图上的改动：找到同一对象更早的改动所属方案；都没有时，归给最近一次确定的方案
  Game.prototype.coverageGroup = function (key, by) {
    const d = this.draft;
    for (let i = by - 1; i >= 0; i--) { const c = d.coverage[i]; if (c.plan) return c.plan; if (c.grp) return c.grp; }
    for (let i = by + 1; i < d.coverage.length; i++) { const c = d.coverage[i]; if (c.plan) return c.plan; }
    return this.planActive || null;
  };
  Game.prototype.planNew = function (kind, opts) {
    opts = opts || {};
    this.ensureDraft();
    const p = {
      id: 'p' + (++this.planSeq), kind: kind || 'station', name: opts.name || '',
      stations: {}, moves: {}, segs: {}, removals: {}, sites: {}, types: {}, lines: {}, lineId: null, notes: [], touched: false,
      net: null, eval: null, evalVer: -1, pend: {}, kept: {}, createdAt: this.clock.y + '年' + this.clock.m + '月',
    };
    this.plans.push(p); this.plansById[p.id] = p; this.planActive = p.id;
    return p;
  };
  Game.prototype.planDel = function (pid) {
    const p = this.plansById[pid]; if (!p) return { error: '方案不存在' };
    const d = this.draft;
    if (d) {
      // 只属于这个方案、别处也没用到的草案对象随之丢弃（否则轨道会悬空）
      const mine = function (key) {
        for (const c of d.coverage) if (c.plan && c.plan !== pid && c.keys && c.keys[key]) return false;
        return true;
      };
      for (const k in d.net.segments) if (this.planOwner(k) === pid && mine(k)) delete d.net.segments[k];
      for (const k in d.net.stations) if (this.planOwner(k) === pid && mine(k)) delete d.net.stations[k];
      for (const k in d.net.segments) { const sg = d.net.segments[k]; if (!d.net.stations[sg.a] || !d.net.stations[sg.b]) delete d.net.segments[k]; }
      d.coverage = d.coverage.filter(function (c) { return c.plan !== pid; });
      d.ver++;
    }
    this.plans = this.plans.filter(function (q) { return q.id !== pid; });
    delete this.plansById[pid];
    if (this.planActive === pid) this.planActive = this.plans.length ? this.plans[this.plans.length - 1].id : null;
    if (d) this.invalidatePrediction();
    this.emit('draft');
    return { ok: true };
  };
  Game.prototype.planRename = function (pid, name) {
    const p = this.plansById[pid]; if (!p) return { error: '方案不存在' };
    name = String(name || '').trim();
    if (name) p.name = name.slice(0, 40);
    this.emit('draft'); return { ok: true };
  };
  // 方案的改动清单：取草案与正式网络的差集，按归属方案筛出本方案的那部分。
  // 由拖动、撤销等整体改动导致的部分落到 pend 里，直到再次使用该方案时改由方案自己承担。
  Game.prototype.planOverlay = function (pid) {
    const d = this.draft; if (!d) return null;
    const p = this.plansById[pid]; if (!p) return null;
    if (p.ovVer === d.ver && p.ov) return p.ov;
    const off = this.net, t = d.net;
    const nb = d.builtKeys || Object.create(null);
    const ov = { stations: {}, lines: {}, segs: {}, removals: {}, extra: {} };
    const owner = this;
    const take = function (key, isNew) {
      const own = owner.planOwner(key); const k = (isNew ? 'n:' : 'b:') + key;
      if (own === pid) return true;
      if (own === undefined && p.pend[k]) return false;
      return !!(p.kept && p.kept[k]);
    };
    for (const k in t.stations) if (!off.stations[k] || t.stations[k] !== off.stations[k]) { if (take(k, !off.stations[k])) ov.stations[k] = true; }
    for (const k in t.lines) if (!off.lines[k] || t.lines[k].name !== off.lines[k].name || t.lines[k].color !== off.lines[k].color) { if (take(k, !off.lines[k])) ov.lines[k] = true; }
    for (const k in t.segments) if (!off.segments[k] || t.segments[k] !== off.segments[k]) { if (take(k, !off.segments[k])) ov.segs[k] = true; }
    for (const k in off.stations) if (!t.stations[k]) { if (this.planOwner(k) === pid) ov.removals[k] = true; }
    // 已经被别的方案建成、本方案还要用它（接轨、连接）的车站与轨道
    for (const k in p.kept || {}) {
      const raw = k.slice(2);
      if (k.slice(0, 2) === 'b:' && off.stations[raw]) ov.stations[raw] = true;
      if (k.slice(0, 2) === 'b:' && off.segments[raw]) ov.segs[raw] = true;
    }
    ov.id = pid;
    ov.net = this.subNet(ov);
    // 本方案的轨道连到、但目前还没建成的车站（可能是别的方案建的）：确认本方案时一并建成
    for (const k in ov.net.stations) if (t.stations[k] && !off.stations[k]) { ov.stations[k] = true; ov.extra[k] = 1; }
    // 本方案自己的轨道也要算「本方案改过」的那部分（每条新建轨道已含在 segs 里）
    ov.val = M.evaluate(ov.net, off, this.city, this.clock.y);
    // 本方案只承担自己那部分的费用：把不属于本方案的变动从改动清单里剔除（连带的车站只算新建）
    const own = function (key) { return owner.planOwner(key) === pid || (key in ov.stations); };
    ov.val.items = ov.val.items.filter(function (it) { return !it.ref || own(it.ref); });
    ov.val.total = 0; ov.val.byKind = { construction: 0, demolition: 0, upgrade: 0, relocation: 0 };
    for (const it of ov.val.items) { ov.val.total += it.amount; ov.val.byKind[it.kind] += it.amount; }
    p.net = ov.net; p.eval = ov.val; p.evalVer = d.ver;
    // 提示与「顺便改动」：方案里的具体内容 + 不属于任何方案的改动
    const lo = {};
    for (const k in ov.stations) lo[k] = 1; for (const k in ov.segs) lo[k] = 1; for (const k in ov.lines) lo[k] = 1;
    ov.conflicts = ov.val.conflicts.filter(function (c) {
      if (c.kind === 'station' && lo[c.ref]) return true;
      if (c.kind === 'seg' && (lo[c.ref] || (c.id && lo[c.id]))) return true;
      if (c.kind === 'line') { let any = false; for (const g in t.segments) if (lo[g] && t.segments[g].line === c.ref) any = true; return any; }
      return false;
    });
    ov.add = []; ov.mod = []; ov.del = [];
    // 方案的线路（用于「完成度」显示）
    ov.line = p.lineId && ov.net.lines[p.lineId] ? p.lineId : null;
    p.ov = ov; p.ovVer = d.ver;
    return ov;
  };
  // 方案的部分网络：正式网络 + 本方案自己的那部分改动（连带引用的车站，否则轨道悬空）。
  // 已建成的对象一律用正式网络里的那一份：草案里的副本只是历史，参数与引用都以正式网络为准。
  Game.prototype.subNet = function (ov) {
    const d = this.draft, off = this.net, t = d.net;
    const net = { stations: {}, segments: {}, lines: {}, nextId: t.nextId };
    for (const k in off.stations) net.stations[k] = off.stations[k];
    for (const k in off.segments) net.segments[k] = off.segments[k];
    for (const k in off.lines) net.lines[k] = off.lines[k];
    for (const k in ov.stations) if (t.stations[k] && !(ov.extra && ov.extra[k])) net.stations[k] = t.stations[k];
    for (const k in ov.segs) if (t.segments[k]) net.segments[k] = t.segments[k];
    for (const k in ov.lines) if (t.lines[k]) net.lines[k] = t.lines[k];
    // 本方案的轨道连到的车站（可能属于别的方案）：一并带上，费用里会算上它们；
    // 已是正式网络一部分的不再算（它们已建成，不属于任何一个草案里的新轨道）
    for (const k in ov.segs) {
      const sg = t.segments[k]; if (!sg) continue;
      for (const sk of [sg.a, sg.b]) if (t.stations[sk] && !off.stations[sk]) net.stations[sk] = t.stations[sk];
      if (t.lines[sg.line] && !off.lines[sg.line]) net.lines[sg.line] = t.lines[sg.line];
    }
    for (const k in ov.removals) delete net.stations[k];
    // 轨道连到的车站若已被拆掉，轨道随之作废（否则网络不完整）
    for (const k in net.segments) { const sg = net.segments[k]; if (!net.stations[sg.a] || !net.stations[sg.b]) delete net.segments[k]; }
    M.normalizeLines(net);
    return net;
  };
  Game.prototype.stationKeyByAdd = function (s) {
    const m = /车站「(.+?)」/.exec(s); if (!m) return null;
    for (const k in this.draft.net.stations) if (this.draft.net.stations[k].name === m[1]) return k;
    return null;
  };
  // 某个改动归属到某方案（供 UI 判断方案按钮是否点亮）
  Game.prototype.planIsActive = function (pid) { return this.planActive === pid; };
  Game.prototype.draftEval = function () {
    const d = this.draft; if (!d) return null;
    if (d.evalVer !== d.ver) {
      d.eval = M.evaluate(d.net, this.net, this.city, this.clock.y);
      d.evalVer = d.ver;
    }
    return d.eval;
  };
  Game.prototype.draftCompiled = function () {
    const d = this.draft; if (!d) return null;
    if (d.compVer !== d.ver) { d.compiled = M.compile(d.net, this.city); d.compVer = d.ver; }
    return d.compiled;
  };
  Game.prototype.canConfirm = function () {
    const ev = this.draftEval();
    if (!ev) return { ok: false, reason: '没有草案' };
    if (this.draft.liveSnap) return { ok: false, reason: '请先松开鼠标或结束当前拖动，再确认建设' };
    if (!ev.changed) return { ok: false, reason: '草案没有变化' };
    if (ev.conflicts.length) return { ok: false, reason: '存在 ' + ev.conflicts.length + ' 处冲突，需先解决' };
    if (!this.econ.canAffordBuild(ev.total)) return { ok: false, reason: '资金不足：需要 ' + U.fmtMoney(ev.total) + '，当前一般资金 ' + U.fmtMoney(this.econ.funds) + (this.econ.capex > 0.5 ? ' + 建设专项资金 ' + U.fmtMoney(this.econ.capex) : '') };
    if (this.jumping || this.pending) return { ok: false, reason: '正在结算，请稍候' };
    return { ok: true };
  };
  // 确认建设：pid 为空时确认整个草案，否则只确认该方案（其余方案去掉已建成的部分，继续留在草案里）
  Game.prototype.confirmDraft = function (pid) {
    const d = this.draft; if (!d) return { error: '没有草案' };
    if (!pid) {
      const can = this.canConfirm(); if (!can.ok) return { error: can.reason };
      const r = this.commitNet(d.net, '草案', this.draftEval());
      this.plans = []; this.plansById = Object.create(null); this.planActive = null;
      this.draft = null; this.emit('draft');
      return r;
    }
    const ov = this.planOverlay(pid), p = this.plansById[pid];
    if (!ov) return { error: '方案不存在' };
    const val = ov.val;
    if (!(val.changes.add.length || val.changes.mod.length || val.changes.del.length)) return { error: '该方案还没有任何改动' };
    if (val.conflicts.length) return { error: '该方案存在 ' + val.conflicts.length + ' 处冲突，需先解决' };
    if (d.liveSnap) return { error: '请先松开鼠标或结束当前拖动，再确认建设' };
    if (!this.econ.canAffordBuild(val.total)) return { error: '资金不足：需要 ' + U.fmtMoney(val.total) + '，当前一般资金 ' + U.fmtMoney(this.econ.funds) + (this.econ.capex > 0.5 ? ' + 建设专项资金 ' + U.fmtMoney(this.econ.capex) : '') };
    if (this.jumping || this.pending) return { error: '正在结算，请稍候' };
    const keep = JSON.parse(JSON.stringify(d.net));
    const prev = this.net;
    const built = {}; for (const k in ov.stations) built[k] = 1; for (const k in ov.segs) built[k] = 1;
    const r = this.commitNet(ov.net, p.name || '方案', val);
    if (!r.ok) return r;
    // 其余方案：已被建成的部分从草案里去掉；方案记过的身份转成正式网络里的键，别处引用的则改成已建成的键
    const adopt = Object.create(null);
    const rekey = Object.create(null);
    for (const k in built) {
      if (!(this.net.stations[k] || this.net.segments[k] || this.net.lines[k])) continue;
      if (keep.stations[k] || keep.segments[k]) rekey['n:' + k] = 'b:' + k;
      adopt['n:' + k] = 1;
    }
    // 建成后的对象留在草案里，只是与正式网络一致了（删掉会被求值当成拆除）
    for (const k in ov.removals) {
      delete keep.stations[k];
      if (this.net.stations[k]) adopt['b:' + k] = 1;
    }
    // 别的方案建成的对象：本方案若还要用（轨道端点或已记在 kept 里）就转成已建成的键，
    // 用不到的直接丢掉 —— 否则本方案会误以为自己要新建别人已经建好的车站
    const mov = function (pend, q) {
      const out = {};
      for (const k in pend) {
        const re = rekey[k] || k;
        out[re] = 1;
        if (k.slice(0, 2) === 'b:') { delete out[re]; continue; }
        const raw = k.slice(2);
        if (adopt[k] && q && q.ref && (q.ref['b:' + raw] || q.ref.stations[raw])) { out['b:' + raw] = 1; delete out[re]; }
        if (adopt[k]) { /* 被别的方案建成：只有本方案确实引用才保留 */ }
      }
      return out;
    };
    for (const q of this.plans) {
      if (q.id === pid) continue;
      // 先按重建后的草案算出本方案真正用到的车站与轨道
      const pn = this.subNet(q);
      const ref = { stations: {}, segs: {} };
      for (const f of ['pend', 'kept']) for (const k in q[f] || {}) { const raw = k.slice(2); if (k.slice(0, 2) === 'n:') { ref.stations[raw] = 1; } }
      for (const sk in pn.segments) { const sg = pn.segments[sk]; ref.stations[sg.a] = 1; ref.stations[sg.b] = 1; }
      q.ref = ref;
      q.pend = mov(q.pend, q);
      q.kept = mov(q.kept || {}, q);
      const pn2 = this.subNet(q);
      for (const a in adopt) {
        const raw = a.slice(2);
        if (ref.stations[raw]) q.kept[a] = 1;
      }
      for (const sk in pn2.segments) { const sg = pn2.segments[sk]; if (this.net.segments[sk]) q.kept['b:' + sk] = 1; }
      if (q.lineId && d.net.lines[q.lineId] && !this.net.lines[q.lineId]) {
        const want = d.net.lines[q.lineId].name;
        for (const id in this.net.lines) if (this.net.lines[id].name === want) { q.lineId = id; break; }
      }
      q.evalVer = -1; q.net = null; q.eval = null;
    }
    keep.nextId = d.net.nextId;
    // 剩下的改动与正式网络里已建成的对象分开编号，免得同一个 id 被当成既有对象的搬迁
    // 这次建成的对象已经进入正式网络：草案里换成正式网络里的那一份（不能删，删掉会被求值当成拆除）
    for (const k in built) {
      if (this.net.stations[k]) keep.stations[k] = this.net.stations[k]; else delete keep.stations[k];
      if (this.net.segments[k]) keep.segments[k] = this.net.segments[k]; else delete keep.segments[k];
      if (this.net.lines[k]) keep.lines[k] = this.net.lines[k]; else delete keep.lines[k];
    }
    const remap = this.rekeyDraft(keep, this.net);
    const ren = function (key) {
      const raw = key.slice(2), pfx = key.slice(0, 2);
      const nk = pfx === 'n:' ? (remap.st[raw] || remap.sg[raw]) : null;
      return nk ? 'n:' + nk : key;
    };
    // 剩下的改动归给剩下的方案：它们之间不再区分先后，各按自己用到的部分出钱（键以重编号之后的为准）
    const rest = Object.create(null), keepB = Object.create(null);
    for (const k in keep.stations) { rest[k] = 1; keepB['b:' + k] = 1; }
    for (const k in keep.segments) { rest[k] = 1; keepB['b:' + k] = 1; }
    const remapped = Object.keys(remap.st).length || Object.keys(remap.sg).length;
    const left = this.plans.filter(function (q) { return q.id !== pid; });
    let cov = [{ plan: left.length ? left[left.length - 1].id : null, own: true, keys: rest, grp: null }];
    if (remapped) {
      for (const c of d.coverage) {
        if (!c.keys) continue;
        const out = {};
        for (const k in c.keys) { const nk = ren(k); if (rest[nk.slice(2)]) out[nk] = 1; }
        c.keys = out;
      }
      for (const q of left) {
        for (const f of ['pend', 'kept']) {
          if (!q[f]) continue;
          const out = {};
          for (const k in q[f]) { const nk = ren(k); if (keepB[nk]) out[nk] = 1; }
          q[f] = out;
        }
      }
      cov = d.coverage.filter(function (c) { return c.keys && Object.keys(c.keys).length; });
      if (!cov.length) cov = [{ plan: left.length ? left[left.length - 1].id : null, own: true, keys: rest, grp: null }];
    }
    M.normalizeLines(keep);
    this.plans = this.plans.filter(function (x) { return x.id !== pid; });
    delete this.plansById[pid];
    this.planActive = this.plans.length ? this.plans[this.plans.length - 1].id : null;
    // 这次确认的只是方案，草案本身要留住（撤销点重来）
    this.draft = { net: keep, undo: [], redo: [], ver: d.ver + 1, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' }, coverage: cov };
    // 最后一个方案建完、草案里不再有东西：直接结束草案
    if (!this.plans.length && !Object.keys(keep.stations).length && !Object.keys(keep.segments).length) { this.draft = null; this.emit('draft'); return r; }
    if (!this.plans.length && !this.draftEval().changed) { this.draft = null; this.emit('draft'); return r; }
    this.invalidatePrediction();
    this.emit('draft');
    return r;
  };
  // 剩下的草案网络整体归给「剩下的方案」：它们之间的改动不再区分先后，各按自己的重叠部分算
  Game.prototype.coverageBase = function (net) { return { plan: null, own: false, keys: null, grp: this.plans.length ? this.plans[this.plans.length - 1].id : null }; };
  // 草案里「还没建成、但 id 与正式网络里的对象撞了」的键换新 id（含对象自己的 id 字段），免得被当成同一个对象。
  // 撞名的车站也要改名：求值按名称认站，同名会被当成「拆了旧站又建新站」重复计费。
  // 已建成的对象保留在草案里：其它方案可能还引用着它们（作为轨道端点），子网络会从正式网络取它们的参数。
  Game.prototype.rekeyDraft = function (net, off) {
    off = off || this.net;
    const stMap = {}, sgMap = {};
    const names = Object.create(null);
    for (const k in off.stations) names[off.stations[k].name] = 1;
    for (const k of Object.keys(net.stations)) {
      if (off.stations[k]) continue;
      const s = net.stations[k];
      const nk = M.newId(net, 's'); stMap[k] = nk;
      s.id = nk;
      if (names[s.name]) { let n = 2; while (names[s.name + '（' + n + '）']) n++; s.name = s.name + '（' + n + '）'; }
      names[s.name] = 1;
      net.stations[nk] = s; delete net.stations[k];
    }
    for (const k of Object.keys(net.segments)) {
      if (off.segments[k]) continue;
      const nk = M.newId(net, 'g'); sgMap[k] = nk;
      const sg = net.segments[k];
      sg.id = nk; sg.a = stMap[sg.a] || sg.a; sg.b = stMap[sg.b] || sg.b;
      net.segments[nk] = sg; delete net.segments[k];
    }
    return { st: stMap, sg: sgMap };
  };
  // 把一份网络按普通的建设流程并入正式网络（含扣费、拆迁、收藏名与里程碑）
  Game.prototype.commitNet = function (net, label, ev) {
    this.econ.spendBuild(ev.byKind, '地铁建设·' + label + '（' + ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改）', { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    for (const dm of ev.demolitions) this.city.demolish(dm.c, dm.frac);
    for (const id in net.stations) if (!this.net.stations[id]) net.stations[id].built = [this.clock.y, this.clock.m];
    // 新建、改建与搬迁后的位置成为新的“付费选址”，之后的免费微调以此为基准
    for (const id in net.stations) { const s = net.stations[id], o = this.net.stations[id]; if (o && !s.site) s.site = [o.x, o.y]; }
    for (const id of ev.siteReset || []) { const s = net.stations[id]; if (s) s.site = [s.x, s.y]; }
    for (const id in net.segments) if (!this.net.segments[id]) net.segments[id].built = [this.clock.y, this.clock.m];
    // 轨道的“已付费长度”：之后的免费小幅调整以此为基准累计
    for (const id in net.segments) { const v = ev.paidLen && ev.paidLen[id]; if (v != null) net.segments[id].paidLen = Math.round(v); }
    // 收藏：记下被拆除或改名对象的最新名称（读档后已拆除的收藏仍显示原名）
    const fv = this.favs; fv.names = fv.names || {};
    for (const id of fv.stations) { const s = net.stations[id] || this.net.stations[id]; if (s) fv.names[id] = s.name; }
    for (const id of fv.lines) { const L = net.lines[id] || this.net.lines[id]; if (L) fv.names[id] = L.name; }
    M.normalizeLines(net);
    for (const id in net.segments) net.segments[id].base = null;
    const summary = ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改、' + ev.changes.del.length + ' 项拆除';
    this.net = net;
    this.netVersion++;
    this.rev++;
    this.compiled = M.compile(this.net, this.city);
    this.model.cancelPredict();
    // 沿线拆迁减少了人口与就业：立即重算小区人口岗位与出行需求，不等到月度结算
    if (ev.demolitions.length) { this.model.buildZones(); this.model.buildDemand(); }
    this.model.setNetwork(this.compiled);
    this.logEvent({ tag: '建设', title: '建设完成并投入运营', desc: summary + (ev.total > 0 ? '，费用 ' + U.fmtMoney(ev.total) : '，无费用') });
    if (CM.Milestones) CM.Milestones.onNetwork(this);
    this.emit('network');
    this.emit('draft');
    this.emit('toast', { kind: 'good', text: '建设完成，已投入运营' + (ev.total > 0 ? '（' + U.fmtMoney(ev.total) + '）' : '') });
    this.emit('autosave', 'build');
    return { ok: true };
  };

  // 预测
  Game.prototype.invalidatePrediction = function (msg) {
    const d = this.draft; if (!d) return;
    d.autoVer = null;   // 票价、月份等外部条件变化时，即使草案版本没变也要允许自动重算。
    if (d.pred.state === 'running') this.model.cancelPredict();
    if (d.pred.state !== 'idle') d.pred = { state: 'stale', msg: msg || '草案已修改，预测需要重新计算', last: d.pred.result || d.pred.last };
    this.emit('prediction');
  };
  Game.prototype.requestPrediction = function () {
    const d = this.draft; if (!d) return;
    if (this.pending || this.jumping || this.model.refreshing) {
      this.invalidatePrediction('正在进行城市结算，请稍后重新计算预测');
      return;
    }
    const ev = this.draftEval();
    const C = this.draftCompiled();
    const ver = d.ver;
    const affected = Array.from(ev.affectedLines);
    const self = this;
    d.pred = { state: 'running', progress: 0, ver: ver };
    const gen = this.model.predict(C, affected, function (res) {
      if (!self.draft || self.draft.ver !== ver) return;
      res.conditions.y = self.clock.y; res.conditions.m = self.clock.m;
      self.draft.pred = { state: 'done', result: res, ver: ver };
      self.emit('prediction');
    });
    d.pred.gen = gen;
    this.emit('prediction');
  };

  // ---------------- 查询 ----------------
  Game.prototype.zoneName = function (z) {
    const m = this.model;
    const x = m.zCx[z], y = m.zCy[z];
    let best = null, bd = 1e9;
    for (const p of D.places) { const d = U.dist(x, y, p[1], p[2]); if (d < bd) { bd = d; best = p[0]; } }
    const rg = this.city.regionAt(x, y);
    return (bd < 5 ? best + '一带' : '片区') + (rg ? '（' + rg.name.replace(/（.*）/, '') + '）' : '');
  };
  // 片区早高峰拥堵：默认工作日（通勤口径）
  Game.prototype.zoneCong = function (z, dt) {
    const model = this.model, P = model.ctxs[dt === 'we' ? 'we' : 'wd'].per[0], road = model.road;
    let num = 0, den = 0;
    for (let a = 0; a < road.nA; a++) {
      if (model.arcZone[a] !== z) continue;
      const v = P.arcVol[a]; if (v <= 0) continue;
      num += v * road.arcLen[a] * (P.arcTime[a] / road.arcT0[a]); den += v * road.arcLen[a];
    }
    return den > 0 ? num / den : 1;
  };
  // 发展阶段名称：由各地图的场景数据提供（stages 为 [截止年份（不含）, 名称]，stageLast 为史料截止前的最后阶段）
  Game.prototype.stageName = function () {
    const y = this.clock.y;
    for (const s of D.stages || []) if (y < s[0]) return s[1];
    if (y <= CFG.growth.histEnd) return D.stageLast || '发展期';
    return D.fictional ? '持续发展' : '模拟未来';
  };

  // ---------------- 存档 ----------------
  Game.prototype.serialize = function () {
    return {
      meta: { gameId: this.id, name: this.name, mode: this.mode, seed: this.seed, createdAt: this.createdAt, gameVersion: CFG.GAME_VERSION, map: this.mapId || 'gz', mapVersion: (CM.MAPS[this.mapId || 'gz'] || {}).mapVersion || 1, scenario: (CM.MAPS[this.mapId || 'gz'] || {}).scenario || '', mapFp: (CM.MAPS[this.mapId || 'gz'] || {}).fp || '' },
      clock: Object.assign({}, this.clock),
      city: this.city.serialize(),
      net: this.net,
      econ: this.econ.serialize(),
      tasks: this.tasks.serialize(),
      events: this.events.slice(-300),
      history: this.history.slice(-1200),
      firedEvents: this.firedEvents,
      favs: this.favs,
      tutorial: this.tutorial || null,
      milestones: this.milestones || null,
      mapInit: this.mapInit || null,
      macro: this.macro && CM.Macro ? CM.Macro.serialize(this.macro) : null,
      traffic: this.traffic || { v: CFG.TRAFFIC_MODEL },
      draft: this.serializeDraft(),
    };
  };
  // 草案：网络、撤销栈与各方案。求值结果、编译结果、预测都是可重算的中间量，不入档。
  Game.prototype.serializeDraft = function () {
    const d = this.draft;
    if (!d) return null;
    return {
      net: d.net, undo: d.undo.slice(-40), ver: d.ver,
      coverage: d.coverage,
      plans: this.plans, planSeq: this.planSeq, planActive: this.planActive,
    };
  };
  Game.restore = function (s) {
    const g = new Game();
    const m = s.meta;
    g.id = m.gameId; g.name = m.name; g.mode = m.mode; g.seed = m.seed; g.createdAt = m.createdAt;
    g.mapId = m.map || 'gz';   // 调用前 CM.useMap 已切换到该地图
    if (s.tutorial) g.tutorial = s.tutorial;
    g.clock = Object.assign({}, s.clock);
    g.city = new CM.City();
    g.city.generate(g.seed, CFG.START.y);
    g.city.restore(s.city, g.clock.y);
    // 交通模型版本：1.8 及更早的存档为 1（典型工作日、通勤与其他两类出行），载入时升级到当前模型
    const tv = (s.traffic && s.traffic.v) || 1, upgrade = tv < CFG.TRAFFIC_MODEL;
    // 台北松山机场（v1.9 起可地下建设）：旧存档中该区域仍为未开放，读档时开放（机场照常运营，用地不开发）
    let airportOpened = null;
    if (D.airport && D.airport.buildable) {
      const k = g.city.regions.findIndex(function (r) { return r.id === 'airport'; });
      if (k >= 0 && !g.city.regionOpen[k] && g.city.regions[k].open != null && g.city.regions[k].open <= g.clock.y) { g.city.openRegion(k, g.clock.y, g.clock.m); airportOpened = g.city.regions[k]; }
    }
    g.model = new CM.Model(g.city);
    g.model.setYear(g.clock.y + (g.clock.m - 1) / 12);
    g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
    g.model.buildZones(); g.model.buildDemand();
    g.net = s.net;
    g.compiled = M.compile(g.net, g.city);
    g.model.setNetwork(g.compiled);
    g.econ = CM.Economy.restore(s.econ);
    g.model.fare = g.econ.fare;
    g.tasks = CM.Tasks.restore(s.tasks);
    g.events = s.events || []; g.history = s.history || []; g.firedEvents = s.firedEvents || {};
    g.favs = { stations: (s.favs && s.favs.stations) || [], lines: (s.favs && s.favs.lines) || [], names: (s.favs && s.favs.names) || {} };
    g.mapInit = s.mapInit || null;
    g.milestones = s.milestones || null;
    g.model.solveNow(2);
    if (CM.Milestones) CM.Milestones.backfill(g);
    // 城市经济：有数据则恢复；1.7 及更早的存档（或数据不完整）从当前状态接入，不补造过去的记录，不改变已有资金与债务。
    // 接入失败时本局不启用经济模拟，原存档不受影响
    g.macro = null;
    if (CM.Macro && CM.Macro.enabled()) {
      try { CM.Macro.attach(g, s.macro || null); }
      catch (e) {
        console.error(e);
        try { g.macro = null; CM.Macro.attach(g, null); g.macroNote = '存档中的城市经济数据无法识别，已从当前状态重新接入'; }
        catch (e2) { console.error(e2); g.macro = null; g.econ.fisc = null; g.econ.quoteFn = null; g.macroError = '城市经济数据未能初始化（' + (e2 && e2.message || e2) + '），本局暂不启用；原存档未受影响'; }
      }
      if (g.macro && !s.macro) g.macroNote = '城市经济自 ' + g.clock.y + ' 年 ' + g.clock.m + ' 月起接入：此前的经济数据未记录，不作补造';
    }
    // 交通模型升级：保留原有建设、资金、债务、历史结算与任务进度；已结算的历史不重算。升级当月设过渡保护（见 inTransition）
    if (upgrade) {
      g.traffic = { v: CFG.TRAFFIC_MODEL, from: m.gameVersion || '1.8.0', at: [g.clock.y, g.clock.m, g.clock.d], until: g.ym() + 1 };
      for (const t of g.tasks.active) if (t.type === 'ridership' && !t.basis) t.basis = 'wd';   // 进行中的客流任务沿用发布时的口径（典型工作日）
      if (g.macro && CM.Macro && CM.Macro.rebaseTE) { try { CM.Macro.rebaseTE(g); } catch (e) { console.error(e); } }
      g.logEvent({ tag: '版本', title: '交通模型升级（v' + CFG.GAME_VERSION + '）', desc: '存档来自 v' + g.traffic.from + '。居民出行改为通勤、上学、购物、医疗、旅游休闲与枢纽接驳六类，重要设施单独参与计算，工作日与周末分别模拟；地面铁路影响步行与道路通行。原有建设、资金、债务、历史结算与任务进度全部保留，此前的月度记录按旧口径（典型工作日）保存、不重算；升级当月满意度不因统计口径变化而下降，任务不判失败。' });
      g.backupFailed = s.__backupFailed || null;
      g.upgradeNote = s.__backupFailed ? '存档已在内存中升级到 v' + CFG.GAME_VERSION + ' 交通模型；升级前备份未能建立（' + s.__backupFailed + '），不会自动保存，原存档保持不变' :
        '存档已升级到 v' + CFG.GAME_VERSION + ' 交通模型（升级前的原存档已另存为「升级前备份」，可在存档列表中载入或导出）';
    } else g.traffic = Object.assign({ v: CFG.TRAFFIC_MODEL }, s.traffic);
    if (airportOpened) g.logEvent({ tag: '规则', title: '新区域开放：' + airportOpened.name, desc: (D.airport.name || '机场') + '照常运营，用地不开发；范围内可以地下设站与地下穿越（v1.9 起）。' });
    g.restoreDraft(s.draft);
    return g;
  };
  // 草案没有版本号字段：缺草案的旧存档按「没有草案」处理
  Game.prototype.restoreDraft = function (sd) {
    this.draft = null; this.plans = []; this.plansById = Object.create(null); this.planSeq = 0; this.planActive = null;
    if (!sd || !sd.net) return;
    this.plans = (sd.plans || []).filter(function (p) { return p && p.id; });
    this.plansById = Object.create(null);
    for (const p of this.plans) { this.plansById[p.id] = p; p.net = null; p.eval = null; p.evalVer = -1; p.ref = null; }
    this.planSeq = sd.planSeq || 0;
    this.planActive = sd.planActive && this.plansById[sd.planActive] ? sd.planActive : (this.plans.length ? this.plans[this.plans.length - 1].id : null);
    const ver = sd.ver || 1;
    this.draft = {
      net: sd.net, undo: sd.undo || [], redo: [], ver: ver, evalVer: -1, eval: null,
      compiled: null, compVer: -1, pred: { state: 'idle' }, coverage: sd.coverage || [],
    };
  };
})(window.CM);
