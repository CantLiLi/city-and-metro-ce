'use strict';
// 详情页面：建设预测、车站、线路、道路、片区、指标、日期、财政、任务、存档、帮助
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA, M = CM.Metro;
  const h = U.h;
  const UI = CM.UI;
  const ICON = { chev: CM.ICON.chev, loc: CM.ICON.locate };
  UI.prototype.predictionBlock = function () {
    const g = this.g(), self = this, d = g.draft;
    const box = h('div', { class: 'sec open' });
    box.appendChild(h('div', { class: 'sec-h', style: { cursor: 'default' } }, '效果预测', h('span', { class: 'sum' }, '仅供参考')));
    const inner = h('div', { class: 'inner', style: { padding: '0 2px 10px' } });
    box.appendChild(inner);
    if (!d) return box;
    const p = d.pred;
    const runBtn = function (label) { return h('button', { class: 'btn sm', onclick: function () { g.requestPrediction(); } }, label); };
    if (p.state === 'idle') {
      inner.append(h('div', { class: 'note' }, '在草案静止约 1 秒后自动计算，或手动开始。预测基于当前城市状态比较建线前后的出行选择与道路交通。'), h('div', { style: { marginTop: '6px' } }, runBtn('计算效果预测')));
      return box;
    }
    if (p.state === 'running') {
      const bar = h('i', { style: { width: '5%' } });
      inner.append(h('div', { class: 'row small muted', style: { marginBottom: '6px' } }, h('span', { class: 'spinner', style: { width: '14px', height: '14px', borderWidth: '2px' } }), '预测计算中（不扣费，不改变正式客流）…'), h('div', { class: 'progress' }, bar));
      this.live.push(function () { const st = g.model.predState; bar.style.width = Math.round(U.clamp(st ? st.progress : 0.05, 0.05, 1) * 100) + '%'; });
      return box;
    }
    const res = p.state === 'done' ? p.result : (p.last || null);
    if (p.state === 'stale') inner.append(h('div', { class: 'callout warn' }, p.msg || '草案已修改，预测需要重新计算'), h('div', { style: { margin: '4px 0 8px' } }, runBtn('重新计算')));
    if (!res) return box;
    const dim = p.state === 'stale';
    const wrap = h('div', { style: { opacity: dim ? 0.5 : 1 } });
    inner.appendChild(wrap);
    if (!res.valid) { wrap.appendChild(h('div', { class: 'callout warn' }, '无法形成有效预测：' + (res.reason || '草案中没有有效的地铁行程。'))); }
    else {
      const B = res.base, Dr = res.draft;
      const dlt = function (a, b, d0, unit, betterUp) { const x = b - a; if (Math.abs(x) < Math.pow(10, -d0) / 2) return ['±0' + (unit || ''), 'muted']; return [U.fmtSigned(x, d0, unit || ''), (x > 0) === betterUp ? 'good' : 'bad']; };
      const g1 = h('div', { class: 'stat-grid' });
      let x;
      x = dlt(B.metro, Dr.metro, 0, '', true); g1.appendChild(this.stat('日均地铁客运量', U.fmtPeople(Dr.metro) + ' 人次', '较当前 ' + U.fmtSigned((Dr.metro - B.metro) / 1e4, 1, ' 万'), x[1]));
      x = dlt(B.metroShare * 100, Dr.metroShare * 100, 1, ' 个百分点', true); g1.appendChild(this.stat('地铁分担率', U.fmtPct(Dr.metroShare), x[0], x[1]));
      x = dlt(B.commute, Dr.commute, 1, ' 分钟', false); g1.appendChild(this.stat('平均通勤时间', U.fmtNum(Dr.commute, 1) + ' 分钟', x[0], x[1]));
      x = dlt(B.cong, Dr.cong, 3, '', false); g1.appendChild(this.stat('道路拥堵指数（全日）', Dr.cong.toFixed(3), x[0], x[1]));
      x = dlt(B.car, Dr.car, 0, '', false); g1.appendChild(this.stat('汽车出行（人次/日）', U.fmtPeople(Dr.car), '转移 ' + U.fmtPeople(Math.max(0, B.car - Dr.car)) + ' 人次', x[1]));
      x = dlt(B.fare, Dr.fare, 0, '', true); g1.appendChild(this.stat('票务收入（日）', U.fmtMoney(Dr.fare / 10000), U.fmtSigned((Dr.fare - B.fare) / 10000, 1, ' 万元'), x[1]));
      wrap.appendChild(g1);
      if (res.lines.length) {
        wrap.appendChild(this.sec('pr-lines', '相关线路客流（日上车人次）', '', function () {
          const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, '线路'), h('th', null, '当前'), h('th', null, '草案')));
          for (const l of res.lines) t.appendChild(h('tr', null, h('td', null, h('span', { class: 'swatch', style: { background: l.color, marginRight: '6px' } }), l.name), h('td', null, U.fmtPeople(l.before)), h('td', null, U.fmtPeople(l.after))));
          return t;
        }, true));
      }
      wrap.appendChild(this.sec('pr-roads', '道路影响（早高峰饱和度）', res.roads.length ? res.roads.length + ' 条变化' : '变化不明显', function () {
        const bx = h('div');
        if (!res.roads.length) bx.appendChild(h('div', { class: 'note' }, '早高峰主要道路饱和度变化不明显。新增地铁不保证道路拥堵一定改善。'));
        for (const r of res.roads) bx.appendChild(h('div', { class: 'chg small' }, h('span', null, r.name), h('span', { class: 'num ' + (r.delta < 0 ? 'good' : 'bad') }, r.vc0.toFixed(2) + ' → ' + r.vc1.toFixed(2))));
        if (res.roadsWorse.length) { bx.appendChild(h('div', { class: 'small bad', style: { marginTop: '6px' } }, '可能加重的道路：')); for (const r of res.roadsWorse) bx.appendChild(h('div', { class: 'chg small' }, h('span', null, r.name), h('span', { class: 'num bad' }, r.vc0.toFixed(2) + ' → ' + r.vc1.toFixed(2)))); }
        return bx;
      }, true));
    }
    const c = res.conditions;
    const fare = '全网统一票价 ' + c.fare.flat + ' 元/次';
    wrap.appendChild(this.sec('pr-cond', '预测条件与说明', '', function () {
      return h('div', { class: 'note' }, '比较对象：当前正式网络 vs 草案网络；城市状态：' + c.y + '年' + c.m + '月（相同人口、岗位与出行需求）；时间范围：典型工作日全天（早高峰、平峰、晚高峰、夜间）；票价：' + fare + '；运力：系统按预测客流自动调整。预测仅供参考，不扣费、不改变正式客流；投运后的实际结果由模拟产生，并在车站与线路详情中单独显示。');
    }));
    return box;
  };

  // ======================== 页面：车站 ========================
  // 控件每次都读取最新草案（草案变化后页面自动刷新）；已建状态与草案状态分别说明
  UI.prototype.page_station = function (id) {
    const g = this.g(), self = this;
    const net = g.draft ? g.draft.net : g.net;
    const s = net.stations[id];
    if (!s) return null;
    const latest = function () { return (g.draft ? g.draft.net : g.net).stations[id]; };
    const el = h('div');
    const official = g.net.stations[id];
    const desc = function (x) { return CFG.metro.sizeName[x.size] + ' · ' + CFG.metro.typeName[x.type]; };
    const lines = M.stationLines(net, id).map(function (l) { return net.lines[l]; }).filter(Boolean);
    el.appendChild(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '8px' } }, lines.length ? lines.map(function (l) { return h('span', { class: 'tag', style: { background: l.color + '22', color: l.color } }, '● ' + l.name); }) : h('span', { class: 'tag' }, '未接入线路'), lines.length > 1 ? h('span', { class: 'tag xfer' }, '⇄ 换乘站') : null, h('span', { class: 'tag' }, desc(s)), !official ? h('span', { class: 'tag info' }, '草案中（未建成）') : null, h('span', { class: 'grow' }), this.favBtn('stations', id)));
    if (official && (official.size !== s.size || official.type !== s.type || official.name !== s.name || U.dist(official.x, official.y, s.x, s.y) > 0.004)) {
      const moved = U.dist(official.x, official.y, s.x, s.y) * CFG.CELL_M;
      el.appendChild(h('div', { class: 'draft-diff' }, h('span', { class: 'dd-k' }, '已建'), h('span', null, official.name + ' · ' + desc(official)), h('span', { class: 'dd-arrow' }, '→'), h('span', { class: 'dd-k draft' }, '草案'), h('span', null, s.name + ' · ' + desc(s) + (moved > 1 ? ' · 移动 ' + Math.round(moved) + ' m' : ''))));
    }
    const C = g.model.net ? g.model.net.C : null;
    const k = C && official ? C.sIndex.get(id) : undefined;
    const serviced = k !== undefined && !!C.serviced[k];
    if (serviced && g.model.stDaily) {
      const sd = g.model.stDaily;
      const grid = h('div', { class: 'stat-grid' });
      const sIn = this.stat('日进站', '—'), sOut = this.stat('日出站', '—'), sX = this.stat('日换乘', '—'), sP = this.stat('当前小时负荷', '—');
      grid.append(sIn, sOut, sX, sP);
      el.appendChild(grid);
      const cap = CFG.metro.stationCap[C.stations[k].size];
      this.live.push(function () {
        sIn.setV(U.fmtPeople(sd.inn[k]) + ' 人次', '典型工作日'); sOut.setV(U.fmtPeople(sd.out[k]) + ' 人次', '典型工作日'); sX.setV(U.fmtPeople(sd.xfer[k]) + ' 人次', '站内换乘');
        const W = g.model.weights(g.clock.minute);
        const f = g.model.stFlowAt(k, W, 'stIn') + g.model.stFlowAt(k, W, 'stOut') + g.model.stFlowAt(k, W, 'stXfer');
        sP.setV(U.fmtPct(f / cap, 0), U.fmtInt(f) + ' / ' + U.fmtInt(cap) + ' 人次/时', f / cap > 1 ? 'bad' : (f / cap > 0.8 ? 'warn' : 'muted'));
      });
      const diag = this.crowdBlock(id, k);
      if (diag) el.appendChild(diag);
      el.appendChild(this.sec('st-xfer', '换乘关系', '', function () {
        const b = h('div');
        if (lines.length > 1) b.appendChild(h('div', { class: 'small' }, '站内换乘：' + lines.map(function (l) { return l.name; }).join('、')));
        const acc = g.model.net.acc;
        const xs = acc.transfers.filter(function (t) { return t.a === k; });
        if (xs.length) for (const t of xs) { const o = C.stations[t.b]; b.appendChild(h('div', { class: 'small clickable', style: { padding: '3px 4px' }, onclick: function () { self.select({ kind: 'station', id: o.id }); } }, '站外换乘：步行 ' + Math.round(t.m) + ' m（约 ' + Math.ceil(t.m / CFG.walk.mPerMin) + ' 分钟）至「' + o.name + '」')); }
        if (lines.length <= 1 && !xs.length) b.appendChild(h('div', { class: 'note' }, '暂无换乘。站外换乘需要两座运营车站之间存在 ' + CFG.walk.transferMaxM + ' m 以内的可步行道路。'));
        return b;
      }, true));
      el.appendChild(this.sec('st-cover', '步行覆盖', '', function () { return self.coverBlock(s, k, false); }));
      el.appendChild(this.sec('st-ops', '运营与费用', '', function () {
        const oi = g.econ.opsIndex(g.clock.y);
        return self.kv([['车站容量', U.fmtInt(cap) + ' 人次/小时'], ['日运营费用', U.fmtMoney(CFG.ops.stationDaily[C.stations[k].size] * oi)], ['建成时间', official.built ? official.built[0] + '年' + official.built[1] + '月' : '—'], ['高峰小时客流', U.fmtInt(sd.peak[k]) + ' 人次']]);
      }));
    } else if (official && k !== undefined) {
      el.appendChild(this.callout('warn', 'warn', '该车站尚未接入运营线路，不提供服务：不计入地铁覆盖，也不产生客流和票款。把它连接到线路并确认建设后生效。'));
      el.appendChild(this.sec('st-cover', '潜在步行覆盖（接入线路后）', '', function () { return self.coverBlock(s, k, true); }));
    } else if (official) {
      el.appendChild(h('div', { class: 'note' }, '客流数据计算中…'));
    } else {
      el.appendChild(h('div', { class: 'callout info' }, '这是草案中的新车站，确认建设后立即投入运营并产生客流数据。'));
    }
    // 编辑操作（进入草案）
    el.appendChild(this.sec('st-edit', '修改车站', '', function () {
      const b = h('div');
      const nameIn = h('input', { type: 'text', value: s.name, maxlength: 16 });
      const rename = function () { const v = nameIn.value.trim(), c = latest(); if (!v || !c || v === c.name) return; g.edit(function (n) { n.stations[id].name = v; }); self.toast('已在草案中更名为「' + v + '」', 'info'); };
      nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
      b.appendChild(h('div', { class: 'field' }, h('label', null, '站名'), h('div', { class: 'row' }, nameIn, h('button', { class: 'btn sm', onclick: rename }, '更名'))));
      b.appendChild(h('div', { class: 'field' }, h('label', null, '车站规模'), self.sizeCards({
        type: s.type, cur: s.size, base: official ? official.size : null, rebuild: !!official && official.type !== s.type,
        onPick: function (sz) { const c = latest(); if (c && c.size !== sz) g.edit(function (n) { n.stations[id].size = sz; }); },
      })));
      const tc = h('div', { class: 'seg-ctl' });
      for (const t of ['underground', 'surface', 'elevated']) tc.appendChild(h('button', { class: s.type === t ? 'on' : '', onclick: function () { const c = latest(); if (c && c.type !== t) g.edit(function (n) { n.stations[id].type = t; }); } }, CFG.metro.typeName[t], official && official.type === t && s.type !== t ? h('small', null, '（已建）') : null));
      b.appendChild(h('div', { class: 'field' }, h('label', null, '车站形式' + (official ? '（改建按新建计费；选回已建形式即撤销改建）' : '')), tc));
      // 绘线入口：端点站延长、中间站绘制支线
      const acts = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } });
      for (const l of lines) {
        const tp = M.lineTopo(net, l.id);
        if (tp.topo === 'loop' || tp.topo === 'invalid' || !tp.adj || !tp.adj.get(id)) continue;
        const deg = tp.adj.get(id).length;
        acts.appendChild(h('button', { class: 'btn sm', onclick: function () { self.startDraw(id, l.id, deg >= 2); } }, h('span', { class: 'dot', style: { background: l.color } }), deg >= 2 ? '绘制 ' + l.name + ' 支线' : '延长 ' + l.name));
      }
      acts.appendChild(h('button', { class: 'btn sm', onclick: function () { self.startDraw(id, 'new'); } }, '新建线路'));
      b.appendChild(h('div', { class: 'field' }, h('label', null, '从此站绘线'), acts));
      b.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', onclick: function () { self.tools.setTool('edit'); self.select({ kind: 'station', id: id }); } }, '移动车站'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm danger', onclick: function () { self.demolish({ kind: 'station', id: id }); } }, '拆除')));
      const imp = self.demolishImpact({ kind: 'station', id: id });
      if (imp && imp.lines.length) b.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '拆除影响：' + imp.lines.join('；')));
      b.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '所有修改先进入建设草案，确认后生效。'));
      return b;
    }, !official || !!g.draft));
    el.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm ghost', onclick: function () { self.flyTo(s.x, s.y, 30); } }, h('span', { html: ICON.loc.replace('<svg', '<svg width="14" height="14"') }), '定位')));
    return { title: s.name + ' 站', el: el, highlightLine: null };
  };
  // 步行覆盖（沿实际道路）；potential：未通车站接入线路后的潜在覆盖
  UI.prototype.coverBlock = function (s, k, potential) {
    const g = this.g(), acc = g.model.net.acc, tree = acc.trees[k];
    if (!tree) return h('div', { class: 'callout warn' }, '车站周边暂无可步行到达的道路，暂无覆盖。');
    const vm = new Map(); for (let q = 0; q < tree.verts.length; q++) vm.set(tree.verts[q], tree.dist[q]);
    const city = g.city, VW = city.VW, ci = Math.floor(s.x), cj = Math.floor(s.y);
    const sums = [0, 0, 0], jobs = [0, 0, 0];
    for (let j = Math.max(0, cj - 6); j <= Math.min(city.H - 1, cj + 6); j++) for (let i = Math.max(0, ci - 6); i <= Math.min(city.W - 1, ci + 6); i++) {
      const v0 = j * VW + i;
      let m = Infinity; for (const v of [v0, v0 + 1, v0 + VW, v0 + VW + 1]) { const dd = vm.get(v); if (dd !== undefined && dd < m) m = dd; }
      m += CFG.walk.cellExtraM;
      const c = j * city.W + i;
      for (let q = 0; q < 3; q++) if (m <= (q + 1) * 5 * CFG.walk.mPerMin) { sums[q] += city.pop[c]; jobs[q] += city.jobs[c]; }
    }
    return h('div', null, this.kv([['步行 5 分钟内', U.fmtPeople(sums[0]) + ' 人 · ' + U.fmtPeople(jobs[0]) + ' 岗位'], ['步行 10 分钟内', U.fmtPeople(sums[1]) + ' 人 · ' + U.fmtPeople(jobs[1]) + ' 岗位'], ['步行 15 分钟内', U.fmtPeople(sums[2]) + ' 人 · ' + U.fmtPeople(jobs[2]) + ' 岗位']]),
      h('div', { class: 'note', style: { marginTop: '6px' } }, (potential ? '仅为预览：车站未通车前不计入任何覆盖统计。' : '') + '按实际道路步行距离计算（含街道到建筑的平均距离），河流与断路会阻隔。'));
  };
  // 拥挤诊断：区分车站容量不足与列车运力不足，给出对应的处理入口
  UI.prototype.crowdBlock = function (id, k) {
    const g = this.g(), self = this, model = g.model, mnet = model.net, C = mnet.C, sd = model.stDaily, mc = CFG.metro;
    const st = C.stations[k], cap = mc.stationCap[st.size], stR = sd.peak[k] / cap;
    const ord = ['S', 'M', 'L'], next = function (sz) { return ord[Math.min(2, ord.indexOf(sz) + 1)]; };
    const trains = [];
    for (const r of C.stationRoutes[k]) {
      const rt = C.routes[r], re = mnet.rideEdge[r], n = rt.stIdx.length;
      let worst = null;
      for (const p of [0, 2]) {
        const P = model.live.per[p], capH = P.freq[r] * rt.cap;
        if (!(capH > 0)) continue;
        for (let q = 0; q < re.length; q++) {
          const leg = q >> 1, a = rt.stIdx[leg], b = rt.stIdx[(leg + 1) % n];
          if (a !== k && b !== k) continue;
          const lf = P.load[re[q]] / capH;
          if (!worst || lf > worst.lf) worst = { lf: lf, load: P.load[re[q]], capH: capH, leg: leg, a: a, b: b, p: p, freq: P.freq[r] };
        }
      }
      if (worst && worst.lf > 1) trains.push({ rt: rt, w: worst });
    }
    if (stR <= 0.8 && !trains.length) return null;
    const box = h('div', { class: 'diag' }, h('div', { class: 'diag-h' }, CM.icon('warn'), '拥挤诊断'));
    const item = function (level, title, text, actions) { box.appendChild(h('div', { class: 'diag-item lv-' + level }, h('b', null, title), h('div', { class: 'small' }, text), actions.filter(Boolean).length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginTop: '6px' } }, actions.filter(Boolean)) : null)); };
    const divert = h('button', { class: 'btn sm ghost', onclick: function () { self.showDiversion(st); } }, '查看可分流方向');
    if (stR > 0.8) {
      const up = st.size !== 'L' ? h('button', { class: 'btn sm primary', onclick: function () { g.edit(function (n) { if (n.stations[id]) n.stations[id].size = next(st.size); }); self.toast('已在草案中把「' + st.name + '」升级为' + mc.sizeName[next(st.size)] + '车站', 'info'); } }, '升级为' + mc.sizeName[next(st.size)] + '车站') : null;
      item(stR > 1 ? 'bad' : 'warn', stR > 1 ? '车站容量不足' : '车站接近饱和', '高峰小时进出站与换乘约 ' + U.fmtInt(sd.peak[k]) + ' 人次，' + mc.sizeName[st.size] + '车站能力 ' + U.fmtInt(cap) + ' 人次/时（' + U.fmtPct(stR, 0) + '）。' + (stR > 1 ? '乘客在闸机、楼梯与换乘通道排队，进出站变慢。' : '') + (st.size === 'L' ? '已是大型车站，只能通过新线路分流。' : ''), [up, divert]);
    }
    for (const t of trains) {
      const rt = t.rt, w = t.w, A = C.stations[w.a], B = C.stations[w.b];
      const minCars = rt.cars, limiting = rt.stIds.filter(function (sid) { return mc.carsBySize[C.stations[C.sIndex.get(sid)].size] === minCars; });
      const atMax = w.freq >= mc.fMax - 0.5;
      const helpsHere = limiting.indexOf(id) >= 0;
      const segRef = rt.segRefs[w.leg];
      const locate = h('button', { class: 'btn sm', onclick: function () { self.flyTo((A.x + B.x) / 2, (A.y + B.y) / 2, Math.max(self.R.cam.zoom, 20)); if (segRef) self.select({ kind: 'seg', id: segRef.id }); } }, '定位瓶颈区间');
      const lengthen = minCars < 8 ? h('button', { class: 'btn sm primary', onclick: function () {
        g.edit(function (n) { for (const sid of limiting) if (n.stations[sid]) n.stations[sid].size = next(n.stations[sid].size); });
        self.toast('已在草案中升级 ' + limiting.length + ' 座车站，' + rt.line.name + ' 可加长到 ' + mc.carsBySize[next(C.stations[C.sIndex.get(limiting[0])].size)] + ' 节编组', 'info');
      } }, '加长编组：升级 ' + limiting.length + ' 座' + mc.sizeName[C.stations[C.sIndex.get(limiting[0])].size] + '车站') : null;
      item('bad', '列车运力不足 · ' + rt.label, A.name + '—' + B.name + ' 区间' + (w.p === 0 ? '早' : '晚') + '高峰断面约 ' + U.fmtInt(w.load) + ' 人/时，超过运力 ' + U.fmtInt(w.capH) + ' 人/时（' + U.fmtNum(w.freq, 1) + ' 列/时' + (atMax ? '，已达发车上限' : '') + '，' + minCars + ' 节编组）。' +
        (minCars < 8 ? '编组受沿线最小车站限制，' + (helpsHere ? '本站是限制编组的车站之一，需与其余 ' + (limiting.length - 1) + ' 座同时升级。' : '只升级本站不能解决，需要升级限制编组的车站。') : '已是最长编组，只能修建平行线路分流。'), [locate, lengthen, divert]);
    }
    return box;
  };
  // 可分流方向：打开出行方向图层（只看地铁）并定位到车站
  UI.prototype.showDiversion = function (st) {
    this.R.layerOpt.flow = 'metro';
    this.setLayer('flow');
    this.flyTo(st.x, st.y, Math.min(this.R.cam.zoom, 16));
    this.toast('出行方向图层：经过「' + st.name + '」一带的粗蓝色流向，是修建平行线路分流的候选方向', 'info');
  };
  // 从车站开始绘线：延长线路、绘制支线或新建线路
  UI.prototype.startDraw = function (sid, lid, branch) {
    const g = this.g(), T = this.tools, net = g.draft ? g.draft.net : g.net, s = net.stations[sid];
    if (!s) return;
    T.setTool('line');
    T.lineChoice = lid; T.chain = sid; T.bends = [];
    T.lineLock = true;
    this.renderToolOpts();
    const ln = lid !== 'new' ? net.lines[lid] : null;
    this.toast(ln ? (branch ? '从「' + s.name + '」绘制 ' + ln.name + ' 支线' : '从「' + s.name + '」延长 ' + ln.name) + '：点击车站或空地连线，右键结束' : '从「' + s.name + '」开始新建线路：点击车站或空地连线', 'info');
  };

  // ======================== 页面：线路 ========================
  UI.prototype.page_line = function (key) {
    const g = this.g(), self = this;
    const parts = String(key).split('|'), lid = parts[0], segId = parts[1];
    const net = g.draft ? g.draft.net : g.net;
    const line = net.lines[lid];
    if (!line) return null;
    const el = h('div');
    const tp = M.lineTopo(net, lid);
    const segs = M.lineSegs(net, lid);
    let len = 0; for (const s of segs) len += M.segGeom(net, s, g.city).lenM;
    el.appendChild(h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } }, h('span', { class: 'swatch', style: { background: line.color, width: '22px', height: '8px' } }), h('span', { class: 'tag' }, M.TOPO_NAME[tp.topo]), h('span', { class: 'tag' }, U.fmtKm(len)), h('span', { class: 'tag' }, tp.stations.length + ' 站'), !g.net.lines[lid] ? h('span', { class: 'tag info' }, '草案中') : null, h('span', { class: 'grow' }), this.favBtn('lines', lid)));
    if (tp.topo === 'path' || tp.topo === 'branch') el.appendChild(h('div', { class: 'note', style: { marginBottom: '6px' } }, '拖动地图上线路端点的「+」手柄可直接延长；在车站详情中可从中间站绘制支线。'));
    if (tp.topo === 'invalid') el.appendChild(h('div', { class: 'callout bad' }, tp.reason));
    // 运营
    const mnet = g.model.net;
    const routes = mnet ? mnet.C.routes.map(function (r, i) { return [r, i]; }).filter(function (a) { return a[0].lineId === lid; }) : [];
    if (routes.length && g.net.lines[lid]) {
      const W = function () { return g.model.weights(g.clock.minute); };
      const daily = g.model.stDaily;
      let board = 0; if (daily) for (const r of routes) board += daily.routeBoard[r[1]];
      const grid = h('div', { class: 'stat-grid' });
      grid.append(this.stat('日客运量（上车）', U.fmtPeople(board) + ' 人次', '典型工作日'));
      const oi = g.econ.opsIndex(g.clock.y);
      let ckm = 0;
      for (const r of routes) for (let p = 0; p < 4; p++) ckm += g.model.live.per[p].freq[r[1]] * 2 * r[0].lenM / 1000 * r[0].cars * (p === 3 ? 5 : g.model.pHours[p]);
      grid.append(this.stat('日运营费用', U.fmtMoney(ckm * CFG.ops.carKmCost * oi), '列车 ' + U.fmtInt(ckm) + ' 车厢公里'));
      el.appendChild(grid);
      for (const it of routes) {
        const r = it[0], ri = it[1];
        el.appendChild(this.sec('ln-r-' + r.label, r.label, '', function () {
          const b = h('div');
          const rows = h('div');
          const upd = function () {
            const w = W(); const f = g.model.freqAt(ri, w);
            const re = mnet.rideEdge[ri];
            let mx = 0; for (let q = 0; q < re.length; q++) mx = Math.max(mx, g.model.edgeLoadAt(re[q], w));
            const capH = f * r.cap;
            // 配车：全日各时段所需列车的最大值，以及本时段的依据（站数、站距、客流）
            let fleet = 0; for (let p = 0; p < 4; p++) fleet = Math.max(fleet, Math.ceil(r.cycleSec * g.model.live.per[p].freq[ri] / 3600));
            const ns = r.stIdx.length, sp = r.lenM / 1000 / Math.max(1, r.loop ? ns : ns - 1);
            const floor = CM.Model.serviceFloor(r, w.p0), byLoad = mx / (r.cap * CFG.metro.targetLF);
            rows.innerHTML = '';
            rows.appendChild(self.kv([
              ['当前发车', f > 0 ? U.fmtNum(f, 1) + ' 列/小时（间隔 ' + U.fmtNum(60 / f, 1) + ' 分钟）' : '停运（06:00–24:00 运营）'],
              ['运行列车', f > 0 ? Math.ceil(r.cycleSec / (3600 / f)) + ' 列（周转 ' + Math.round(r.cycleSec / 60) + ' 分钟）' : '—'],
              ['配属列车', fleet + ' 列（全日各时段所需的最大值）'],
              ['配车依据', ns + ' 站 · 平均站距 ' + U.fmtNum(sp, 1) + ' km → 最低 ' + U.fmtNum(floor, 1) + ' 列/时；客流需要 ' + U.fmtNum(byLoad, 1) + ' 列/时' + (byLoad > floor ? '（按客流）' : '（按服务水平）')],
              ['列车编组', r.cars + ' 节（受沿线最小车站限制），定员 ' + U.fmtInt(r.cap) + ' 人'],
              ['单向运力', f > 0 ? U.fmtInt(capH) + ' 人/小时' : '—'],
              ['最大断面客流', U.fmtInt(mx) + ' 人/小时', capH > 0 && mx > capH ? 'bad' : ''],
              ['满载率', capH > 0 ? U.fmtPct(mx / capH, 0) : '—', capH > 0 && mx > capH ? 'bad' : ''],
            ]));
          };
          upd(); self.live.push(upd);
          b.appendChild(rows);
          b.appendChild(h('div', { class: 'small muted', style: { margin: '8px 0 2px' } }, '当前小时各区间断面客流（上行/下行）'));
          const chart = h('div');
          const drawChart = function () { chart.innerHTML = ''; chart.appendChild(self.loadChart(r, ri, W())); };
          drawChart(); self.live.push(function () { if (Math.random() < 0.25) drawChart(); });
          b.appendChild(chart);
          b.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '列车数由系统自动调配：车站越多、站距越小的城区线基础班次越密，站距大的郊区线较疏，每条线路至少 2 列；客流超过时按最大断面客流加车（最小间隔 2 分钟）。达到上限后体现为拥挤，需要升级车站以加长编组或修建平行线路分流。'));
          return b;
        }, routes.length === 1));
      }
    } else if (!g.net.lines[lid]) {
      el.appendChild(h('div', { class: 'callout info' }, '这是草案中的新线路，确认建设后立即投入运营。'));
    }
    // 车站列表
    el.appendChild(this.sec('ln-st', '车站', tp.stations.length + ' 座', function () {
      const b = h('div');
      const order = tp.routes.length ? tp.routes[0].st.concat(tp.routes.slice(1).map(function (r) { return r.st.filter(function (s) { return tp.routes[0].st.indexOf(s) < 0; }); }).flat()) : tp.stations;
      for (const sid of order) { const s = net.stations[sid]; if (!s) continue; b.appendChild(h('div', { class: 'small clickable', style: { padding: '4px' }, onclick: function () { self.select({ kind: 'station', id: sid }); } }, '● ' + s.name + '  ', h('span', { class: 'faint' }, CFG.metro.sizeName[s.size]))); }
      return b;
    }));
    // 选中区段
    const seg = segId ? net.segments[segId] : null;
    if (seg) {
      const geo = M.segGeom(net, seg, g.city);
      el.appendChild(this.sec('ln-seg', '选中区段：' + net.stations[seg.a].name + '—' + net.stations[seg.b].name, '', function () {
        const b = h('div');
        b.appendChild(self.kv([['长度', U.fmtKm(geo.lenM)], ['建设方式', CFG.metro.typeName[seg.type]], geo.waterM > 1 ? ['跨江', (seg.type === 'underground' ? '越江隧道 ' : '跨江桥梁 ') + U.fmtKm(geo.waterM)] : null, geo.hillM > 1 ? ['山体隧道', U.fmtKm(geo.hillM)] : null, ['最小曲线半径', isFinite(geo.minRadiusM) ? Math.round(geo.minRadiusM) + ' m' : '直线']]));
        const tc = h('div', { class: 'seg-ctl', style: { marginTop: '8px' } });
        for (const t of ['underground', 'surface', 'elevated']) {
          const cost = M.trackCost(geo, t, g.clock.y);
          tc.appendChild(h('button', { class: seg.type === t ? 'on' : '', 'data-tip': '约 ' + U.fmtMoney(cost), onclick: function () { const c = (g.draft ? g.draft.net : g.net).segments[segId]; if (c && c.type !== t) g.edit(function (n) { n.segments[segId].type = t; }); } }, CFG.metro.typeName[t]));
        }
        b.appendChild(h('div', { class: 'field' }, h('label', null, '改变建设方式（按新建计费；跨江：地下=隧道，地面/高架=桥梁）'), tc));
        b.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'btn sm', onclick: function () { self.tools.setTool('edit'); self.select({ kind: 'seg', id: segId }); } }, '调整线形'),
          h('button', { class: 'btn sm danger', onclick: function () { self.demolish({ kind: 'seg', id: segId }); } }, '拆除区段')));
        const imp = self.demolishImpact({ kind: 'seg', id: segId });
        if (imp && imp.lines.length) b.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '拆除影响：' + imp.lines.join('；')));
        return b;
      }, true));
    }
    // 线路信息
    el.appendChild(this.sec('ln-edit', '线路名称与颜色', '', function () {
      const b = h('div');
      const nameIn = h('input', { type: 'text', value: line.name, maxlength: 14 });
      const colors = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', margin: '6px 0' } });
      for (const c of D.lineColorsNice) colors.appendChild(h('button', { title: c, style: { width: '22px', height: '22px', borderRadius: '6px', border: c === line.color ? '2px solid #1f2630' : '1px solid #ddd', background: c, cursor: 'pointer' }, onclick: function () { g.edit(function (n) { n.lines[lid].color = c; }); } }));
      b.append(h('div', { class: 'field' }, h('label', null, '名称'), h('div', { class: 'row' }, nameIn, h('button', { class: 'btn sm', onclick: function () { const v = nameIn.value.trim(); if (v) g.edit(function (n) { n.lines[lid].name = v; }); } }, '保存'))), colors);
      b.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn sm danger', onclick: function () { g.edit(function (n) { for (const s of M.lineSegs(n, lid)) delete n.segments[s.id]; delete n.lines[lid]; }); self.select(null); self.toast('已在草案中拆除 ' + line.name + ' 全部轨道（车站保留，可单独拆除）', 'info'); } }, '拆除整条线路')));
      return b;
    }));
    // 批量修改：本线全部车站或轨道
    el.appendChild(this.sec('ln-batch', '批量修改', '', function () {
      return h('div', null, h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
        h('button', { class: 'btn sm', onclick: function () { self.setMulti({ stations: tp.stations.slice(), segs: [] }); } }, '选中本线全部车站（' + tp.stations.length + '）'),
        h('button', { class: 'btn sm', onclick: function () { self.setMulti({ stations: [], segs: segs.map(function (s) { return s.id; }) }); } }, '选中本线全部轨道（' + segs.length + '）')),
        h('div', { class: 'note', style: { marginTop: '6px' } }, '也可以在地图上按住 Ctrl（或 Shift）点击多座车站或多段轨道进行多选。'));
    }));
    return { title: line.name, el: el, highlightLine: lid };
  };
  UI.prototype.loadChart = function (r, ri, W) {
    const g = this.g(), mnet = g.model.net, re = mnet.rideEdge[ri];
    const n = r.segRefs.length;
    const up = [], dn = [];
    let mx = 1;
    for (let k = 0; k < n; k++) { const a = g.model.edgeLoadAt(re[2 * k], W), b = g.model.edgeLoadAt(re[2 * k + 1], W); up.push(a); dn.push(b); mx = Math.max(mx, a, b); }
    const f = g.model.freqAt(ri, W), cap = f * r.cap;
    if (cap > mx) mx = cap;
    const Wd = 300, H = 90, bw = Wd / Math.max(1, n);
    let svg = '<svg viewBox="0 0 ' + Wd + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="none">';
    svg += '<line x1="0" y1="' + H / 2 + '" x2="' + Wd + '" y2="' + H / 2 + '" stroke="#ccd" stroke-width="1"/>';
    for (let k = 0; k < n; k++) {
      const hu = up[k] / mx * (H / 2 - 4), hd = dn[k] / mx * (H / 2 - 4);
      const cu = cap > 0 && up[k] > cap ? '#d63031' : r.color, cd = cap > 0 && dn[k] > cap ? '#d63031' : r.color;
      svg += '<rect x="' + (k * bw + 1) + '" y="' + (H / 2 - hu) + '" width="' + Math.max(1, bw - 2) + '" height="' + hu + '" fill="' + cu + '" opacity="0.85"/>';
      svg += '<rect x="' + (k * bw + 1) + '" y="' + H / 2 + '" width="' + Math.max(1, bw - 2) + '" height="' + hd + '" fill="' + cd + '" opacity="0.55"/>';
    }
    if (cap > 0) { const y1 = H / 2 - cap / mx * (H / 2 - 4), y2 = H / 2 + cap / mx * (H / 2 - 4); svg += '<line x1="0" y1="' + y1 + '" x2="' + Wd + '" y2="' + y1 + '" stroke="#d63031" stroke-dasharray="4 3" stroke-width="1"/><line x1="0" y1="' + y2 + '" x2="' + Wd + '" y2="' + y2 + '" stroke="#d63031" stroke-dasharray="4 3" stroke-width="1"/>'; }
    svg += '</svg>';
    const first = g.compiled.stations[r.stIdx[0]], last = g.compiled.stations[r.stIdx[r.stIdx.length - 1]];
    return h('div', null, h('div', { html: svg }), h('div', { class: 'row between tiny muted' }, h('span', null, first ? first.name : ''), h('span', null, '红色虚线 = 当前运力'), h('span', null, last ? last.name : '')));
  };

  // ======================== 页面：批量修改 ========================
  // 多选车站统一升级、多选轨道统一建设方式：先预览合计费用与新增冲突，再作为一步加入草案（可整批撤销）
  UI.prototype.page_multi = function () {
    const g = this.g(), self = this, mu = this.multi;
    if (!mu || (!mu.stations.size && !mu.segs.size)) return null;
    const net = g.draft ? g.draft.net : g.net, mc = CFG.metro, ord = ['S', 'M', 'L'];
    const st = Array.from(mu.stations).filter(function (id) { return net.stations[id]; });
    const sg = Array.from(mu.segs).filter(function (id) { return net.segments[id]; });
    const el = h('div');
    el.appendChild(h('div', { class: 'note' }, '已选 ' + st.length + ' 座车站、' + sg.length + ' 段轨道（地图上以蓝色标出）。按住 Ctrl 或 Shift 点击地图可继续添加或移除。'));
    const chips = h('div', { class: 'chips' });
    const chip = function (label, color, onRemove) { return h('span', { class: 'chip' }, color ? h('span', { class: 'dot', style: { background: color } }) : null, label, h('button', { class: 'chip-x', 'data-tip': '移出多选', onclick: onRemove }, '×')); };
    for (const id of st) chips.appendChild(chip(net.stations[id].name, null, function () { self.toggleMulti('station', id); }));
    for (const id of sg) { const s = net.segments[id], L = net.lines[s.line]; chips.appendChild(chip((L ? L.name + ' ' : '') + net.stations[s.a].name + '—' + net.stations[s.b].name, L ? L.color : null, function () { self.toggleMulti('seg', id); })); }
    el.appendChild(chips);
    // 混合属性
    const count = function (arr, key, names) { const m = {}; for (const x of arr) m[x[key]] = (m[x[key]] || 0) + 1; return Object.keys(m).map(function (k) { return names[k] + ' ' + m[k]; }).join(' · '); };
    if (st.length) el.appendChild(h('div', { class: 'small', style: { marginTop: '8px' } }, '车站规模：' + count(st.map(function (id) { return net.stations[id]; }), 'size', mc.sizeName)));
    if (sg.length) el.appendChild(h('div', { class: 'small' }, '轨道建设方式：' + count(sg.map(function (id) { return net.segments[id]; }), 'type', mc.typeName)));
    const pv = h('div');
    const preview = function (label, fn, nChanged) {
      pv.innerHTML = '';
      if (!nChanged) { pv.appendChild(h('div', { class: 'callout info' }, label + '：所选对象均已满足，无需修改。')); return; }
      const clone = M.clone(net); fn(clone);
      const ev0 = g.draft ? g.draftEval() : { total: 0, conflicts: [] };
      const ev1 = M.evaluate(clone, g.net, g.city, g.clock.y);
      const fresh = ev1.conflicts.filter(function (c) { return !ev0.conflicts.some(function (o) { return o.msg === c.msg; }); });
      const box = h('div', { class: 'batch-pv' }, h('b', null, label + '（' + nChanged + ' 项）'),
        self.kv([['本次批量费用', U.fmtMoney(Math.max(0, ev1.total - ev0.total))], ['草案合计', U.fmtMoney(ev1.total)], ['新增冲突', fresh.length ? fresh.length + ' 处' : '无', fresh.length ? 'bad' : 'good']]));
      for (const c of fresh.slice(0, 6)) box.appendChild(h('div', { class: 'small bad', style: { padding: '2px 0' } }, '· ' + c.msg));
      box.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: function () { pv.innerHTML = ''; } }, '取消'),
        h('button', { class: 'btn sm primary', onclick: function () { const r = g.edit(fn); if (r && r.error) { self.toast(r.error, 'bad'); return; } self.toast('已把「' + label + '」加入草案（可一次撤销）', 'good'); } }, '加入草案')));
      pv.appendChild(box);
    };
    if (st.length) {
      el.appendChild(h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, '统一车站规模（只升级，较大的车站保持不变）'),
        h('div', { class: 'seg-ctl' }, ord.slice(1).map(function (sz) {
          const n = st.filter(function (id) { return ord.indexOf(net.stations[id].size) < ord.indexOf(sz); }).length;
          return h('button', { onclick: function () { preview('统一升级为' + mc.sizeName[sz] + '车站', function (nn) { for (const id of st) { const s = nn.stations[id]; if (s && ord.indexOf(s.size) < ord.indexOf(sz)) s.size = sz; } }, n); } }, '至少' + mc.sizeName[sz] + '（' + n + '）');
        }))));
    }
    if (sg.length) {
      el.appendChild(h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, '统一轨道建设方式（按新建计费）'),
        h('div', { class: 'seg-ctl' }, ['underground', 'surface', 'elevated'].map(function (t) {
          const n = sg.filter(function (id) { return net.segments[id].type !== t; }).length;
          return h('button', { onclick: function () { preview('统一改为' + mc.typeName[t], function (nn) { for (const id of sg) if (nn.segments[id]) nn.segments[id].type = t; }, n); } }, mc.typeName[t] + '（' + n + '）');
        }))));
    }
    el.appendChild(pv);
    el.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm ghost', onclick: function () { self.clearMulti(); } }, '清空多选')));
    return { title: '批量修改', el: el };
  };

  // ======================== 页面：道路 / 片区 ========================
  UI.prototype.page_road = function (id) {
    const g = this.g(), model = g.model, road = model.road, L = road.links[id];
    if (!L) return null;
    const self = this;
    const el = h('div');
    const name = g.city.roadNames[L.name] || (L.cls === 2 ? '次干道' : '道路');
    const clsName = ['', '支路', '次干道', '主干道', '快速路'][L.cls];
    el.appendChild(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'tag' }, clsName), L.bridge ? h('span', { class: 'tag info' }, '桥梁/隧道') : null, h('span', { class: 'tag' }, U.fmtKm(L.lenM))));
    const grid = h('div', { class: 'stat-grid' });
    const s0 = this.stat('方向 A 流量', '—'), s1 = this.stat('方向 B 流量', '—');
    grid.append(s0, s1);
    el.appendChild(grid);
    const upd = function () {
      const W = model.weights(g.clock.minute);
      for (let d = 0; d < 2; d++) {
        const a = 2 * L.id + d, v = model.arcVolAt(a, W), x = v / model.cap(a), r = model.arcRatioAt(a, W);
        (d ? s1 : s0).setV(U.fmtInt(v) + ' 辆/时', '饱和度 ' + x.toFixed(2) + ' · 车速 ' + Math.round(CFG.road.speed[L.cls] / Math.min(8, r)) + ' km/h', x > 1 ? 'bad' : (x > 0.8 ? 'warn' : 'muted'));
      }
    };
    upd(); this.live.push(upd);
    el.appendChild(this.kv([['单向通行能力', U.fmtInt(model.cap(2 * L.id)) + ' 辆/小时'], ['自由流速度', CFG.road.speed[L.cls] + ' km/h']]));
    el.appendChild(h('div', { class: 'small muted', style: { margin: '10px 0 2px' } }, '全天饱和度变化（典型工作日，两方向较大者）'));
    const vals = [];
    for (let hr = 0; hr < 24; hr++) { const W = model.weights(hr * 60 + 30); vals.push(Math.max(model.arcVolAt(2 * L.id, W), model.arcVolAt(2 * L.id + 1, W)) / model.cap(2 * L.id)); }
    el.appendChild(this.spark(vals, { color: '#e8642c', ref: 1, labels: ['0 时', '12 时', '24 时'] }));
    el.appendChild(h('div', { class: 'note', style: { marginTop: '8px' } }, '饱和度 = 小时流量 ÷ 通行能力。道路由系统建设与发展；地铁可吸引汽车出行转移，从而改变道路流量。'));
    return { title: name, el: el };
  };
  UI.prototype.page_zone = function (z) {
    const g = this.g(), model = g.model, self = this;
    const el = h('div');
    const acc = model.net ? model.net.acc : null;
    const P = model.live.per[0];
    el.appendChild(this.kv([
      ['范围', '约 1 km × 1 km 交通小区'],
      ['常住人口', U.fmtPeople(model.zPop[z])], ['就业岗位', U.fmtPeople(model.zJobs[z])],
      ['地铁覆盖（步行 15 分钟）', acc ? U.fmtPct(acc.zCov[z]) : '0%'],
      ['早高峰出发地铁占比', P.zTrips[z] > 0 ? U.fmtPct(P.zMetro[z] / P.zTrips[z]) : '—'],
      ['早高峰道路拥堵指数', g.zoneCong(z).toFixed(2)],
    ]));
    const x = model.zCx[z], y = model.zCy[z];
    const rg = g.city.regionAt(x, y);
    if (rg) el.appendChild(h('div', { class: 'note', style: { marginTop: '8px' } }, '所属区域：' + rg.name + (g.city.regionOpen[g.city.regions.indexOf(rg)] ? '（已开放）' : '（尚未开放，参考 ' + rg.open + ' 年）')));
    el.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm ghost', onclick: function () { self.locateZone(z); } }, '定位')));
    return { title: g.zoneName(z), el: el };
  };

  // ======================== 页面：指标 ========================
  UI.prototype.page_metric = function (key) {
    const g = this.g(), d = g.model.daily || {}, self = this;
    const el = h('div');
    const hist = g.history;
    const defs = {
      pop: { title: '人口', val: function () { return U.fmtPeople(g.city.totals().pop); }, series: function (r) { return r.pop; }, def: '地图范围内的常住人口。', scope: '统计范围：全图（约 30 km × 24 km）；更新：每月城市发展结算；2020 年前为参考统计的估算，之后为模拟。', factors: ['历史人口增长参考曲线', '区域开放（时间与人口共同决定）', '地铁覆盖率提高可吸引更多人口（最多约 +6%）', '各街区的可达性、地铁车站邻近度与规划用地'] },
      share: { title: '地铁分担率', val: function () { return U.fmtPct(d.metroShare || 0); }, series: function (r) { return r.share; }, pct: true, def: '采用地铁的完整出行次数 ÷（汽车 + 地铁完整出行总次数）。换乘不重复计为新出行。', scope: '时间窗口：典型工作日全天（各时段汇总）；首版仅模拟汽车与地铁两种方式。', factors: ['起终点步行接驳时间（沿道路计算）', '候车时间（由发车间隔决定）与换乘次数', '车厢拥挤与车站拥挤', '票价与居民时间价值', '汽车出行时间（道路拥堵）与停车费用'] },
      cong: { title: '道路拥堵指数', val: function () { return (d.cong || 1).toFixed(2) + '（全日） / ' + (d.congAM || 1).toFixed(2) + '（早高峰）'; }, series: function (r) { return r.cong; }, def: '道路实际行驶时间 ÷ 自由流行驶时间，按车公里加权汇总。1.0 表示畅通，1.5 以上明显拥堵。', scope: '统计范围：全图主要道路；顶栏显示当前游戏时刻的数值，此处为典型工作日汇总。', factors: ['人口与出行需求增长', '汽车拥有水平（随年代上升）', '地铁对汽车出行的吸引（不按固定比例下降）', '道路与桥梁的系统建设'] },
      commute: { title: '平均通勤时间', val: function () { return U.fmtNum(d.commute || 0, 1) + ' 分钟'; }, series: function (r) { return r.commute; }, def: '家—工作出行的门到门平均时间。', scope: '包含步行接驳、候车、乘车、换乘、停车取车；时间窗口：典型工作日早晚通勤。', factors: ['道路拥堵', '地铁线路的直达性与换乘便利', '居住与就业分布（城市扩张会拉长通勤）'] },
      sat: { title: '居民满意度', val: function () { return Math.round(g.econ.sat) + ' / 100'; }, series: function (r) { return r.sat; }, def: '综合交通服务、票价与任务结果的满意度评分（0–100）。', scope: '每月更新，每月向目标值靠近 25%；影响政府拨款系数（经营挑战）。', factors: [] },
    };
    const def = defs[key];
    if (!def) return null;
    el.appendChild(h('div', { style: { fontSize: '22px', fontWeight: 700, margin: '4px 0 8px' } }, this.liveText(def.val)));
    if (key === 'share' && d.ready) {
      el.appendChild(this.kv([['日均出行（汽车+地铁）', U.fmtPeople(d.trips) + ' 人次'], ['其中地铁', U.fmtPeople(d.metro) + ' 人次'], ['步行 15 分钟可达地铁的人口', U.fmtPct(d.coverage)], ['平均票价', d.metro > 0 ? U.fmtNum(d.avgFare, 2) + ' 元' : '—']]));
    }
    if (key === 'cong') {
      const W = g.model.weights(g.clock.minute);
      el.appendChild(this.kv([['当前时刻', g.model.cityCongAt(W).toFixed(2)], ['汽车行驶里程（日）', U.fmtPeople(d.vkt) + ' 车公里']]));
    }
    if (key === 'sat' && g.econ.satFactors) {
      const sf = g.econ.satFactors;
      const t = h('div');
      t.appendChild(h('div', { class: 'chg small' }, h('span', null, '基准'), h('span', { class: 'num' }, '+' + sf.base)));
      for (const f of sf.factors) t.appendChild(h('div', { class: 'chg small' }, h('span', null, f.label), h('span', { class: 'num ' + (f.v >= 0 ? 'good' : 'bad') }, U.fmtSigned(f.v, 1))));
      t.appendChild(h('div', { class: 'chg small' }, h('b', null, '目标值'), h('b', { class: 'num' }, Math.round(sf.target))));
      el.appendChild(this.sec('m-satf', '构成因素（上月）', '', function () { return t; }, true));
    }
    el.appendChild(h('div', { class: 'note', style: { margin: '2px 0 6px' } }, def.def));
    el.appendChild(this.sec('m-about', '统计口径与影响因素', '', function () { const b = h('div', { class: 'note' }, def.scope); for (const f of def.factors) b.appendChild(h('div', { class: 'small', style: { padding: '2px 0', color: 'var(--text)' } }, '· ' + f)); return b; }, false, 'info'));
    if (hist.length > 1) {
      el.appendChild(this.sec('m-trend', '变化趋势', '近 ' + Math.min(120, hist.length) + ' 个月', function () {
        const arr = hist.slice(-120);
        return h('div', null, self.spark(arr.map(def.series), { color: '#1e6fd9', labels: [arr[0].y + '年' + arr[0].m + '月', '', arr[arr.length - 1].y + '年' + arr[arr.length - 1].m + '月'] }));
      }, true));
    }
    return { title: def.title, el: el };
  };
  UI.prototype.spark = function (vals, o) {
    o = o || {};
    const W = 300, H = 56;
    let mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (o.ref !== undefined) { mn = Math.min(mn, 0); mx = Math.max(mx, o.ref * 1.1); }
    if (mx - mn < 1e-9) { mx = mn + 1; }
    const pts = vals.map(function (v, i) { return (i / Math.max(1, vals.length - 1) * W).toFixed(1) + ',' + (H - 4 - (v - mn) / (mx - mn) * (H - 8)).toFixed(1); }).join(' ');
    let svg = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    if (o.ref !== undefined) { const y = H - 4 - (o.ref - mn) / (mx - mn) * (H - 8); svg += '<line x1="0" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="#d63031" stroke-dasharray="4 3" stroke-width="1"/>'; }
    svg += '<polyline points="' + pts + '" fill="none" stroke="' + (o.color || '#1e6fd9') + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
    const box = h('div', { html: svg });
    if (o.labels) box.appendChild(h('div', { class: 'row between tiny muted' }, o.labels.map(function (l) { return h('span', null, l); })));
    return box;
  };

  // ======================== 页面：日期与城市 ========================
  UI.prototype.page_date = function () {
    const g = this.g(), self = this, city = g.city;
    const el = h('div');
    el.appendChild(h('div', { style: { fontSize: '18px', fontWeight: 700 } }, this.liveText(function () { return g.clock.y + '年' + g.clock.m + '月' + g.clock.d + '日 ' + U.fmtClock(g.clock.minute); })));
    el.appendChild(h('div', { class: 'row', style: { margin: '6px 0 10px' } }, h('span', { class: 'tag' }, g.stageName()), g.clock.y > CFG.growth.histEnd ? h('span', { class: 'tag sim' }, '模拟未来') : h('span', { class: 'tag hist' }, '参考历史'),
      this.liveText(function () { return CFG.periods[g.model.hourPeriod[Math.floor(g.clock.minute / 60) % 24]].name; }, 'tag info')));
    el.appendChild(this.sec('dt-time', '时间与时段', '', function () {
      return h('div', { class: 'note' }, '1× 速度下游戏中一天约 ' + Math.round(CFG.time.secPerHour * 24) + ' 秒。时段：早高峰 7–9 时、日间平峰、晚高峰 17–19 时、夜间；地铁运营 06:00–24:00。暂停时可以建设、预测和调整票价（默认规则，待确认）。跳月/跳年会逐日结算票款与运营费用，并处理每月的拨款、城市发展、区域开放与任务。');
    }));
    el.appendChild(this.sec('dt-regions', '区域开放', '', function () {
      const b = h('div');
      city.regions.forEach(function (rg, k) {
        if (rg.scenic) return;
        const open = city.regionOpen[k], dt = city.regionOpenDate[k];
        const cx = rg.cx != null ? rg.cx : 60, cy = rg.cy != null ? rg.cy : 48;
        b.appendChild(h('div', { class: 'list-item clickable', onclick: function () { self.locateRegion(k); } },
          h('span', { class: 'tag ' + (open ? 'good' : '') }, open ? '已开放' : '未开放'),
          h('div', { class: 'grow small' }, rg.name, h('div', { class: 'tiny muted' }, open ? (dt ? dt[0] + '年' + dt[1] + '月开放' : '') : '参考 ' + rg.open + ' 年' + (rg.pop ? '；人口达 ' + U.fmtPeople(rg.pop) + ' 时可提前 3 年内开放' : '')))));
      });
      return b;
    }));
    el.appendChild(this.sec('dt-events', '城市发展记录', g.events.length + ' 条', function () {
      const b = h('div');
      const tagCls = { '史实': 'hist', '估算': 'est', '模拟': 'sim', '任务': 'info', '建设': 'good', '经营': 'bad' };
      for (const e of g.events.slice().reverse().slice(0, 120)) b.appendChild(h('div', { class: 'list-item' }, h('span', { class: 'tag ' + (tagCls[e.tag] || '') }, e.tag), h('div', { class: 'grow small' }, h('div', null, e.title), e.desc ? h('div', { class: 'tiny muted' }, e.desc) : null), h('span', { class: 'tiny faint' }, e.y + '.' + e.m)));
      return b;
    }, true));
    el.appendChild(this.sec('dt-data', '数据来源与真实性', '', function () { return self.dataNote(); }));
    return { title: '日期与城市发展', el: el };
  };
  UI.prototype.dataNote = function () {
    return h('div', { class: 'note' },
      h('div', null, h('span', { class: 'tag hist' }, '真实地理'), ' 珠江水系与湖泊、道路与桥梁、铁路、公园与山林、行政区（街道）边界、地名与地标场地均来自 OpenStreetMap（© OpenStreetMap 贡献者，ODbL），按 250 m 网格投影。'),
      h('div', { style: { marginTop: '6px' } }, h('span', { class: 'tag hist' }, '史实参考'), ' 主要道路与桥梁的通车年份、地标落成年份、区域开发年份、历史参考任务（参考广州地铁各线开通年份）。未列出年份的道路随所在区域开放出现。'),
      h('div', { style: { marginTop: '6px' } }, h('span', { class: 'tag est' }, '估算'), ' 1990 年人口与就业分布、1990–2020 年人口增长曲线、出行率、时间价值、汽车拥有水平、造价与运营费用。'),
      h('div', { style: { marginTop: '6px' } }, h('span', { class: 'tag sim' }, '模拟'), ' 2020 年之后的人口增长、新道路与区域开发、居民出行选择、道路拥堵、客流与财政结果。'),
      h('div', { style: { marginTop: '6px' } }, '本游戏仅模拟汽车与地铁等已约定内容，不包含完整现实交通系统，模拟结果不得作为真实广州交通规划预测。'));
  };

  // ======================== 页面：财政 ========================
  UI.prototype.page_finance = function () {
    const g = this.g(), E = g.econ, self = this;
    const el = h('div');
    const free = E.isFree();
    const grid = h('div', { class: 'stat-grid' });
    const sF = this.stat('当前资金', '—'), sG = this.stat('本月拨款', '—'), sR = this.stat('本月票款', '—'), sO = this.stat('本月运营费用', '—');
    grid.append(sF, sG, sR, sO);
    el.appendChild(grid);
    const upd = function () {
      const c = E.cur;
      sF.setV(free ? '不限' : U.fmtMoney(E.funds), free ? '自由建造' : (E.funds < 0 ? '负余额' : ''), E.funds < 0 ? 'bad' : 'muted');
      sG.setV(U.fmtMoney(c.grant), free ? '自由建造不发放' : '每月初发放');
      sR.setV(U.fmtMoney(c.fare), c.days + ' 天累计');
      sO.setV(U.fmtMoney(c.ops), c.days + ' 天累计');
    };
    upd(); this.live.push(upd);
    el.appendChild(this.sec('fi-fare', '票价', UI.fmtFare(E.fare.flat), function () { return self.fareEditor(); }, true, 'ticket'));
    el.appendChild(this.sec('fi-month', '收支明细', g.clock.y + '年' + g.clock.m + '月', function () {
      const c = E.cur, oi = E.opsIndex(g.clock.y);
      let st = 0; for (const s of g.compiled.stations) st += CFG.ops.stationDaily[s.size] * oi;
      const box = h('div', null, self.kv([['期初资金', free ? '—' : U.fmtMoney(c.start)], ['拨款', '+ ' + U.fmtMoney(c.grant)], ['票款', '+ ' + U.fmtMoney(c.fare)], ['任务奖励', '+ ' + U.fmtMoney(c.reward)], ['建设与拆迁', '− ' + U.fmtMoney(c.construction + c.demolition + c.upgrade + c.relocation)], ['运营', '− ' + U.fmtMoney(c.ops)]]),
        h('div', { class: 'note', style: { marginTop: '6px' } }, '每日运营费用约 ' + U.fmtMoney(((g.model.daily && g.model.daily.carKm) || 0) * CFG.ops.carKmCost * oi + st) + '（列车运行 + ' + g.compiled.stations.length + ' 座车站），票款与运营费用逐日结算。'));
      if (E.ledger.length) {
        const t = h('table', { class: 'tbl', style: { marginTop: '8px' } }, h('tr', null, h('th', null, '月份'), h('th', null, '收入'), h('th', null, '支出'), h('th', null, '期末')));
        for (const r of E.ledger.slice(-12).reverse()) t.appendChild(h('tr', null, h('td', null, r.y + '.' + r.m), h('td', null, U.fmtYi(r.grant + r.fare + r.reward, 2)), h('td', null, U.fmtYi(r.construction + r.demolition + r.upgrade + r.relocation + r.ops, 2)), h('td', { class: r.end < 0 ? 'bad' : '' }, free ? '—' : U.fmtYi(r.end, 1))));
        box.append(h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, '最近 12 个月（亿元）'), t);
      }
      return box;
    }, false, 'coin'));
    if (!free) {
      el.appendChild(this.sec('fi-rule', '拨款与失败条件', '', function () {
        const b = h('div');
        b.appendChild(h('div', { class: 'small' }, '下月拨款预计 ' + U.fmtMoney(E.grantFor(g.clock.y, g.clock.m))));
        for (const f of E.grantFactors(g.clock.y, g.clock.m)) b.appendChild(h('div', { class: 'chg small' }, h('span', null, f.label), h('span', { class: 'num' }, '×' + f.f.toFixed(2))));
        const lim = CFG.economy.debtLimit * E.costIndex(g.clock.y);
        b.appendChild(self.kv([['连续负余额', E.negMonths + ' / ' + CFG.economy.negMonthsLimit + ' 个月', E.negMonths ? 'warn' : ''], ['负债下限', U.fmtMoney(lim)], ['满意度低于 ' + CFG.economy.satFail, E.lowSatMonths + ' / ' + CFG.economy.satFailMonths + ' 个月', E.lowSatMonths ? 'warn' : '']]));
        b.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '拨款随满意度（×0.6–1.4）与任务结果变化。允许短期亏损；长期负余额、低于负债下限或满意度长期过低会导致挑战失败。'));
        return b;
      }, false, 'info'));
    }
    return { title: '财政与票价', el: el };
  };
  // 票价：全网统一票价，单个滑块。拖动时更新金额与影响估算，松手后应用并重新计算客流
  UI.fmtFare = function (v) { return '¥' + (v % 1 ? v.toFixed(1) : String(v)) + '/次'; };
  UI.prototype.fareEditor = function () {
    const g = this.g(), E = g.econ, self = this, R = CFG.fareRange;
    const box = h('div', { class: 'fare-ed' });
    const val = h('div', { class: 'fare-v' });
    const slider = h('input', { type: 'range', min: R.min, max: R.max, step: R.step, value: E.fare.flat, 'aria-label': '全网统一票价' });
    const effect = h('div');
    const vot = U.interp(CFG.choice.vot, g.clock.y);
    const show = function (v) {
      val.textContent = UI.fmtFare(v);
      const d = g.model.daily || {}, riders = d.metro || 0;
      const sat = CM.Economy.fareSatEffect(v, g.clock.y);
      effect.innerHTML = '';
      effect.appendChild(self.kv([
        ['当前日票务收入', riders > 0 ? U.fmtMoney((d.fare || 0) / 10000) + '（' + U.fmtPeople(riders) + ' 人次）' : '暂无客流'],
        v !== E.fare.flat && riders > 0 ? ['按新票价估算', '约 ' + U.fmtMoney(riders * v / 10000) + ' / 日（未计入客流变化）'] : null,
        ['满意度影响', sat < -0.05 ? U.fmtSigned(sat, 1) + ' 分（票价负担，上限 −9）' : '无负担（票价不超过时间价值的 35%）', sat < -4 ? 'bad' : (sat < -0.05 ? 'warn' : 'good')],
      ]));
    };
    slider.addEventListener('input', function () { show(+slider.value); });
    slider.addEventListener('change', function () {
      const v = +slider.value;
      if (v === E.fare.flat) return;
      E.fare = { mode: 'flat', flat: v }; g.model.fare = E.fare; g.model.sinceChange = 0; g.touch();
      g.logEvent({ tag: '经营', title: '调整票价', desc: '全网统一票价 ' + v + ' 元/次' });
      self.toast('票价已调整为 ' + UI.fmtFare(v) + '，居民出行选择正在重新计算', 'good');
      self.markUnsaved();
      show(v);
    });
    show(E.fare.flat);
    box.append(h('div', { class: 'fare-top' }, val, h('span', { class: 'tiny muted' }, '全网统一 · 换乘不另收费')),
      h('div', { class: 'fare-slider' }, h('span', { class: 'tiny muted' }, '¥' + R.min), slider, h('span', { class: 'tiny muted' }, '¥' + R.max)),
      this.sec('fi-fare-fx', '票务收入与满意度影响', '', function () {
        return h('div', null, effect, h('div', { class: 'note', style: { marginTop: '6px' } }, '票价越高，乘车意愿越低、票务收入与满意度负担越高。' + g.clock.y + ' 年居民时间价值约 ' + vot.toFixed(1) + ' 元/小时（估算）。松手后居民出行选择将在数秒内重新计算。'));
      }, false, 'info'));
    return box;
  };

  // ======================== 页面：任务 ========================
  UI.prototype.page_tasks = function () {
    const g = this.g(), T = g.tasks, self = this, ch = g.econ.mode === 'challenge';
    const el = h('div');
    if (!ch) el.appendChild(h('div', { class: 'callout info' }, '自由建造模式：任务仅供参考，未完成不会产生后果。'));
    const ym = g.ym();
    const card = function (t, done) {
      const ev = t.progress || T.evaluate(t, g);
      const left = U.ymIndex(t.deadline[0], t.deadline[1]) - ym;
      const b = h('div', { style: { padding: '10px 0', borderBottom: '1px solid var(--line)' } });
      b.appendChild(h('div', { class: 'row' }, h('span', { class: 'tag ' + (t.kind === 'hist' ? 'hist' : 'info') }, t.kind === 'hist' ? '历史参考' : '动态任务'), h('b', { class: 'grow' }, t.title)));
      b.appendChild(h('div', { class: 'note', style: { margin: '4px 0' } }, t.desc));
      if (!done) {
        b.appendChild(h('div', { class: 'progress', style: { margin: '6px 0 4px' } }, h('i', { style: { width: Math.round(U.clamp(ev.value, 0, 1) * 100) + '%' } })));
        b.appendChild(h('div', { class: 'tiny muted' }, ev.text));
        b.appendChild(h('div', { class: 'tiny', style: { marginTop: '4px' } }, '截止 ' + t.deadline[0] + '年' + t.deadline[1] + '月（' + (left > 0 ? '剩 ' + left + ' 个月' : '本月到期') + '）' + (t.sustain ? '；需连续满足 ' + t.sustain + ' 个月' : '') + '；进度每月初评估'));
        b.appendChild(h('div', { class: 'tiny', style: { marginTop: '2px' } }, ch ? '奖励：拨款 ' + U.fmtMoney(t.reward) + '、满意度 +4；未完成：12 个月拨款 ×' + CFG.economy.failGrantFactor + '、满意度 ' + CFG.economy.failSat : '自由模式：无奖励与后果'));
        const locs = [];
        if (t.anchors) for (const a of t.anchors) locs.push(h('button', { class: 'btn sm ghost', onclick: function () { self.locatePoint(a.x, a.y, a.name, a.r || 2); } }, '⊙ ' + a.name));
        if (t.zone !== undefined) locs.push(h('button', { class: 'btn sm ghost', onclick: function () { self.locateZone(t.zone); } }, '⊙ 定位片区（' + g.zoneName(t.zone).replace(/^片区（(.*)）$/, '$1').replace(/（.*）/, '') + '）'));
        if (t.station) { const s = g.net.stations[t.station]; if (s) locs.push(h('button', { class: 'btn sm ghost', onclick: function () { self.locatePoint(s.x, s.y, s.name, 0.8); } }, '⊙ ' + s.name)); }
        if (locs.length) b.appendChild(h('div', { class: 'row', style: { flexWrap: 'wrap', marginTop: '4px', gap: '2px' } }, locs));
      } else {
        b.appendChild(h('div', { class: 'tiny ' + (t.status === 'done' ? 'good' : 'bad') }, (t.status === 'done' ? '已完成' : '未完成') + '（' + t.closedAt[0] + '年' + t.closedAt[1] + '月）'));
      }
      return b;
    };
    if (!T.active.length) el.appendChild(h('div', { class: 'note' }, '暂无进行中的任务。历史参考任务按年份发布，动态任务根据城市状态每 6 个月生成。'));
    for (const t of T.active) el.appendChild(card(t, false));
    el.appendChild(this.sec('tk-done', '已完成', T.done.length + ' 项', function () { const b = h('div'); for (const t of T.done.slice().reverse()) b.appendChild(card(t, true)); if (!T.done.length) b.appendChild(h('div', { class: 'note' }, '暂无')); return b; }));
    el.appendChild(this.sec('tk-failed', '未完成', T.failed.length + ' 项', function () { const b = h('div'); for (const t of T.failed.slice().reverse()) b.appendChild(card(t, true)); if (!T.failed.length) b.appendChild(h('div', { class: 'note' }, '暂无')); return b; }));
    el.appendChild(this.sec('tk-rule', '任务说明', '', function () { return h('div', { class: 'note' }, '历史参考任务参考广州地铁的实际发展时间，但不要求按真实线路走向建设，只需满足目标描述。动态任务根据当前拥堵、覆盖、车站拥挤与客流情况生成。单个任务失败不会直接结束游戏。'); }));
    return { title: '任务', el: el };
  };

  // ======================== 页面：存档 ========================
  UI.prototype.page_saves = function () {
    const g = this.g(), self = this;
    const el = h('div');
    const s = this.save;
    const saved = this.isSaved();
    el.appendChild(h('div', { class: 'callout ' + (s.state === 'error' ? 'bad' : (saved ? 'good' : 'info')) }, s.state === 'error' ? '最近一次保存失败：' + s.msg + '。建议立即「导出当前进度」作为备份。' : this.saveStatusText() + (s.at ? '，保存于 ' + new Date(s.at).toLocaleString('zh-CN') : '') + (saved ? '' : '。')));
    el.appendChild(this.kv([['进度名称', g.name], ['游戏模式', g.mode === 'free' ? '自由建造' : '经营挑战'], ['游戏日期', g.clock.y + '年' + g.clock.m + '月' + g.clock.d + '日']]));
    el.appendChild(h('div', { class: 'row', style: { margin: '10px 0', flexWrap: 'wrap' } },
      h('button', { class: 'btn sm primary', onclick: function () { self.manualSave(); } }, '手动保存'),
      h('button', { class: 'btn sm', onclick: function () { try { CM.Save.exportGame(g); self.toast('已导出存档文件', 'good'); } catch (e) { self.toast('导出失败：' + e.message, 'bad'); } } }, '导出当前进度'),
      h('button', { class: 'btn sm', onclick: function () { self.showSaveManager(true); } }, '存档管理')));
    const games = CM.Save.list();
    const mine = games.find(function (x) { return x.gameId === g.id; });
    el.appendChild(this.sec('sv-list', '本进度的存档', mine ? mine.slots.length + ' 个' : '0 个', function () {
      const b = h('div');
      if (!mine) { b.appendChild(h('div', { class: 'note' }, '尚无存档。')); return b; }
      for (const sl of mine.slots) b.appendChild(self.slotRow(sl, true));
      return b;
    }, true));
    el.appendChild(this.sec('sv-note', '关于本地保存', '', function () {
      return h('div', { class: 'note' }, '游戏无需账号，进度保存在当前浏览器的本地存储（' + CM.Save.backend() + '）中：每月自动保存，并在建设完成后保存；自动存档在两个位置轮换写入。本地保存不会跨设备同步；清除浏览器数据会删除存档。更换电脑或浏览器时，请导出存档文件，再在新设备上导入。全部存档约 ' + (CM.Save.usage() / 1024 / 1024).toFixed(1) + ' MB。');
    }));
    return { title: '存档', el: el };
  };
  UI.prototype.slotRow = function (sl, inGame) {
    const self = this;
    const d = sl.date || [0, 0, 0];
    return h('div', { class: 'slot' },
      h('div', { class: 'info' }, h('div', { class: 't' }, sl.label + (sl.kind === 'auto' ? '' : '')), h('div', { class: 'tiny muted' }, '游戏日期 ' + d[0] + '年' + d[1] + '月' + d[2] + '日 · ' + (sl.mode === 'free' ? '自由建造' : '经营挑战') + ' · ' + sl.stations + ' 站 · 保存于 ' + new Date(sl.savedAt).toLocaleString('zh-CN'))),
      h('button', { class: 'btn sm', onclick: function () { self.loadSlot(sl.slotId); } }, '载入'),
      h('button', { class: 'btn sm ghost', title: '导出为文件', onclick: function () { CM.Save.exportSlot(sl.slotId).catch(function (e) { self.toast('导出失败：' + e.message, 'bad'); }); } }, '导出'),
      inGame && sl.kind === 'manual' && sl.gameId === (self.g() && self.g().id) ? h('button', { class: 'btn sm ghost', title: '用当前进度覆盖此存档', onclick: function () { self.confirm('覆盖存档？', '将用当前进度覆盖「' + sl.label + '」（' + d[0] + '年' + d[1] + '月）。', '覆盖', function () { self.manualSave(sl.slotId, sl.label); }); } }, '覆盖') : null,
      h('button', { class: 'btn sm ghost danger', onclick: function () { self.confirm('删除存档？', '「' + sl.label + '」将被永久删除，无法恢复。', '删除', function () { CM.Save.remove(sl.slotId); self.toast('已删除存档', 'info'); self.rerenderPage(); if (self.screenRefresh) self.screenRefresh(); }, true); } }, '删除'));
  };

  // ======================== 页面：帮助 ========================
  UI.prototype.page_help = function () {
    const el = h('div');
    const rows = [['鼠标左键拖动 / WASD / 方向键', '平移地图'], ['滚轮 / + −', '缩放'], ['V / B / L / E / X', '选择 / 建站 / 绘线 / 修改 / 拆除'], ['Shift + 点击（绘线）', '添加转弯点'], ['右键 / Enter（绘线）', '结束本次绘线（下次从线路端点开始会自动延长该线路）'], ['Backspace', '撤销转弯点或草案上一步'], ['Ctrl+Z / Ctrl+Y（或 Ctrl+Shift+Z）', '撤销 / 重做草案'], ['Ctrl + Enter', '确认建设草案'], ['Ctrl / Shift + 点击（选择、修改）', '多选车站或轨道，批量修改'], ['拖动线路端点的「+」', '直接延长所选线路'], ['空格', '暂停 / 继续（进入游戏时默认暂停）'], ['1 / 2 / 3', '1× / 3× / 8× 速度'], ['T / U', '切换 2D·2.5D / 地下视图'], ['G', '城市统计'], ['K', '线路示意图（可平滑缩放、导出 PNG）'], ['点击行驶中的列车', '跟随这列车；H 隐藏 / 显示界面，Esc 或拖动地图退出'], ['/', '搜索车站、线路、道路、区域与地名'], ['N', '切换浅色 / 深色模式'], ['M', '开关音效'], ['F', '显示全图'], ['Esc', '结束绘线 → 退出工具 → 收起面板']];
    const t = h('table', { class: 'tbl' });
    for (const r of rows) t.appendChild(h('tr', null, h('td', null, h('kbd', null, r[0])), h('td', { style: { textAlign: 'left' } }, r[1])));
    el.appendChild(t);
    el.appendChild(h('h3', null, '玩法提示'));
    el.appendChild(h('div', { class: 'note' }, '界面：左上为日期与时间控制（暂停、速度、+1 月、+1 年）；右上为关键指标与任务、统计、设置、菜单；左侧切换视图与图层；底部为建设工具；左下为缩放。'));
    el.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '1. 打开「人口密度」「道路拥堵」「出行方向」图层，找到出行集中的走廊。2. 用「绘线」连接主要起终点，车站间距 0.8–1.5 km 较常见。3. 查看右侧费用与效果预测，无冲突后确认建设，线路立即投入运营。4. 观察车站客流与道路变化，再升级车站、延长线路或建设换乘。绕行严重、换乘不便、过度拥挤或票价过高的线路吸引力有限。'));
    return { title: '操作说明', el: el };
  };
  UI.prototype.page_data = function () { return { title: '数据说明', el: h('div', null, this.dataNote()) }; };
})(window.CM);
