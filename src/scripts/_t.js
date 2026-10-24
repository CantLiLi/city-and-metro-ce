'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const load = ['util.js', 'config.js', 'news.js', 'geo_gz.js', 'geo.js', 'data_gz.js', 'data_tutorial.js', 'maps.js', 'city.js', 'metro.js', 'sim.js', 'economy.js', 'macro.js', 'game.js'];
const ctx = { console, Date, JSON, Math, Set, Map, Object, Array, String, Number,
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, requestAnimationFrame: () => 0,
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }) } };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of load) vm.runInContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), ctx, { filename: f });
const CM = ctx.CM, M = CM.Metro;
const g = CM.Game.create({ name: 't', mode: 'normal', seed: 1 });
console.log('create ok. stations=', Object.keys(g.net.stations).length, 'money=', Math.round(g.econ.cash !== undefined ? g.econ.cash : NaN));

// --- 方案 A：新建 3 个车站 ---
const A = g.planNew('station');
console.log('plan A', A.id, A.kind, 'active=', g.planActive === A.id);
const ids = [];
for (let i = 0; i < 3; i++) {
  g.edit(function (net) { ids.push(M.addStation(net, 2000 + i * 400, 2000 + i * 400, { size: 'M', type: 'underground' }, g.city)); }, { tag: g.planActive, own: true });
}
let ov = g.planOverlay(A.id);
console.log('A ownership:', Object.keys(ov).map(k => k + '=' + ov[k]).join(' '));
let ev = g.planOverlay(A.id).val;
console.log('A eval total=', Math.round(ev.total), 'items=', ev.items.length, 'conflicts=', ev.conflicts.length);

// --- 方案 B：新建线路，连接 A 的站点 ---
const B = g.planNew('line');
console.log('plan B', B.id, 'active=', g.planActive === B.id);
g.edit(function (net) {
  const lid = M.newLine(net);
  const st = ids.slice();
  for (let i = 0; i + 1 < st.length; i++) M.addSegment(net, lid, st[i], st[i + 1], [], 'underground');
  return { line: lid };
}, { tag: g.planActive, own: true });
const B2 = g.plansById[B.id];
console.log('B.lineId=', B2.lineId);
ov = g.planOverlay(A.id);
console.log('after B, A owns:', Object.keys(ov).length, 'keys');
const ovB = g.planOverlay(B.id);
console.log('B owns:', Object.keys(ovB).map(k => k + '=' + ovB[k]).join(' '));
const evB = g.planOverlay(B.id).val;
console.log('B eval total=', Math.round(evB.total), 'changed=', evB.changed, 'items=', evB.items.map(i => i.label + ':' + Math.round(i.amount)).join(' | '));
