'use strict';
// 交通分配的两套方案，由设置里的「计算进程」用 if 选择：
//   A 单进程：只开一个 Worker，整套分配（方式选择、需求生成、各日类型各时段的迭代、汇总）都在这一个 Worker 里跑；
//            扩展不支持 Worker 时回退到主线程原来的分步循环。
//   B 多进程：人口、资金、地铁、土地、交通各占一个 Worker，一路算一块，最后由汇总那一路把各部分并成一份状态交回主线程。
// 两条路径跑的都是 sim.js 里同一份 odOrigin / demandOrigin / odBuffer 源码（用 toString 注入），
// 单线程、单进程、多进程的结果一致，只有累加顺序不同带来的浮点尾数差异。
(function (CM) {
  const MAXT = 10;
  // 这些名字必须与 sim.js 里 K 的键名完全一致，否则合并时取不到目标数组（静默丢结果）
  const OUT = ['totStat', 'pT', 'pM', 'hasCar', 'zTrips', 'zMetro', 'zAccess', 'desTot', 'desMetro', 'zDest', 'zDestM', 'fIn', 'fInM', 'fOut', 'fOutM', 'fP', 'DS'];
  const DYN = ['co', 'cr', 'gtS', 'tmS', 'kmS', 'skT', 'skK', 'facW', 'facWe', 'odOk'];
  const STAT = ['Z', 'NZ', 'N', 'facW', 'facWe', 'odOk', 'kmPerCell', 'cpk', 'park', 'vot', 'carAccess', 'walkW', 'occ', 'theta', 'fareFlat', 'accOk',
    'perMin', 'capSh', 'capLz', 'hostZ', 'nx', 'ny', 'blocks', 'zJ'];
  const ODT = ['odStart', 'odDest', 't0', 't1', 't2', 't3', 't4', 't5'];
  // 多进程的各块：人口、资金、地铁、土地、交通，外加汇总
  const ROLE = ['pop', 'fund', 'metro', 'land', 'traf'];
  const ROLE_NAME = { pop: '人口', fund: '资金', metro: '地铁', land: '土地', traf: '交通' };
  const PTS = ['totStat', 'pT', 'pM', 'hasCar', 'zTrips', 'zMetro', 'zAccess', 'desTot', 'desMetro', 'zDest', 'zDestM', 'fIn', 'fInM', 'fOut', 'fOutM', 'fP', 'DS'];
  const pend = new Map();
  const held = {};
  let taskCur = null;
  let kernel = null, demKernel = null, bufKernel = null, growKernel = null, dumpKernel = null, slotKeys = '';
  let src = null, pool = [], nW = 0, ranges = null, statKey = '', deadA = false, deadB = false;
  let demZ = 0, demRanges = null, odAlloc = null, token = 0, skHeld = {};
  // threads：设置里的片数，0 表示按核数自动；单进程固定一片
  let threads = 0, isMulti = true;

  function workerSrc(keys) {
    return 'var INF=1e30;' +
      'var NPK=6,HW=0,SH=2,LZ=4,PK=["hw","sc","sh","md","lz","hb"];' +
      'var U={dist:function(ax,ay,bx,by){var dx=bx-ax,dy=by-ay;return Math.sqrt(dx*dx+dy*dy);}};' +
      'var odOrigin=(' + kernel + ');' +
      'var demandOrigin=(' + demKernel + ');' +
      'var odBuffer=(' + bufKernel + ');' +
      'var odGrow=(' + growKernel + ');' +
      'var odDump=(' + dumpKernel + ');' +
      'var OUT=' + keys + ',PTS=' + JSON.stringify(PTS) + ',ST=null,SK={};' +
      'function alloc(K){var Z=K.Z,NZ=K.NZ,N=K.N,B=K.B;' +
      'K.pT=new Float64Array(K.pTlen);K.pM=new Float64Array(K.pTlen);K.cO=new Float64Array(K.pTlen);K.cR=new Float64Array(K.pTlen);K.totStat=new Float64Array(14);' +
      'K.hasCar=new Uint8Array(Z);K.zTrips=new Float64Array(Z);K.zMetro=new Float64Array(Z);K.zAccess=new Float64Array(Z);' +
      'K.desTot=new Float64Array(B);K.desMetro=new Float64Array(B);K.zDest=new Float64Array(6*Z);K.zDestM=new Float64Array(6*Z);' +
      'K.fIn=new Float64Array(K.NF);K.fInM=new Float64Array(K.NF);K.fOut=new Float64Array(K.NF);K.fOutM=new Float64Array(K.NF);K.fP=new Float64Array(K.NF*K.pTlen);' +
      'K.DS=new Float32Array(N*N);K.choices=new Int8Array(NZ*NZ).fill(-2);' +
      // odOrigin 按绝对行号写 carDem[ho*Z+hd]，所以这里得给整块，不能只给本片那几行
      'K.carDem=new Float64Array(Z*Z);}' +
      // 需求生成：只算 from..to 这段起点，输出自己的缓冲与每起点记录数
      'function demand(D,from,to){var Z=D.Z,F=D.F,per=D.per;var D2={},k;for(k in D)D2[k]=D[k];' +
      'var o=odBuffer((to-from)*per+64);D2.out=o;D2.n=0;D2.tot=new Float64Array(6);' +
      'D2.w=[new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z)];' +
      'D2.wf=[null,new Float64Array(F),new Float64Array(F),new Float64Array(F),new Float64Array(F)];' +
      'D2.scores=new Float64Array(Z);D2.s=new Float64Array(5);D2.kk=new Float64Array(5);' +
      'D2.cand=new Int32Array(Z);D2.candF=new Int32Array(F>0?F:1);' +
      'var cnts=new Int32Array(to-from);' +
      'for(var i=from;i<to;i++){if(o.cap-D2.n<per){o=odGrow(o,D2.n,Math.max(o.cap*2,D2.n+per*4));D2.out=o;}demandOrigin(D2,i);cnts[i-from]=D2.n;}' +
      'return {n:D2.n,dest:o.dest,t:o.t,tot:D2.tot,cnts:cnts};}' +
      // 单线程回退：脚本可能没有 self（Node 无 DOM 运行时），取全局对象即可
      'if(typeof self==="undefined"){(function(){var g=typeof globalThis!=="undefined"?globalThis:this;if(g&&!g.self)g.self=g;})();}' +
      'self.onmessage=function(e){var m=e.data;if(!m)return;if(m.t==="stat"){ST=m.stat;return;}' +
      // 排队任务：主线程要先算好需求表，池里这轮请求都得等它
      'if(m.t==="task"){goTask(m.task);return;}' +
      'if(m.t==="demandT"){goDemand(m);return;}' +
      'exec(m,m.task);};' +
      'function goTask(t){if(!t||!t.demand){self.postMessage({t:"taskDone",task:t||null});return;}' +
      // 等主线程把单起点的需求生成请求发过来：算完这一块就放行池里其它请求
      'self.onmessage=function(e){var m=e.data;if(!m)return;if(m.t==="stat"){ST=m.stat;return;}' +
      'if(m.t==="task"){goTask(m.task);return;}' +
      'if(m.t==="demandT"){goDemand(m);return;}' +
      'var d=demand(m.D,m.from,m.to);self.postMessage({t:"demandR",id:m.id,out:d});' +
      'self.postMessage({t:"taskDone",task:t});' +
      'self.onmessage=function(e2){var n=e2.data;if(!n)return;if(n.t==="stat"){ST=n.stat;return;}' +
      'if(n.t==="task"){goTask(n.task);return;}if(n.t==="demandT"){goDemand(n);return;}exec(n,n.task);};};}' +
      'function goDemand(m){var d=demand(m.D,m.from,m.to);if(m.task)d.task=m.task;self.postMessage({t:"demandR",id:m.id,out:d});}' +
      // 一次分片求解：按 task 分开存 skT/skK，各片只算自己那段起点，结果按区间打包带回
      'function exec(m,task){var K={},k;for(k in ST)K[k]=ST[k];for(k in m.dyn)K[k]=m.dyn[k];' +
      'var sk=SK[task]||(SK[task]={t:null,k:null});' +
      'if(K.skT){sk.t=K.skT;sk.k=K.skK;}else if(sk.t){K.skT=sk.t;K.skK=sk.k;}' +
      'else{self.postMessage({t:"done",id:m.id,out:null});return;}' +
      'alloc(K);for(var i=m.from;i<m.to;i++)odOrigin(K,i);' +
      'var o=odBuffer(Math.max(64,(m.to-m.from)*OUT.length*32+64));' +
      'for(var i=m.from;i<m.to;i++){if(o.cap-o.n<(m.to-i)*8)o=odGrow(o,o.n,Math.max(o.cap*2,o.n+(m.to-i)*OUT.length*64));odDump(K,i,o);}' +
      'var tr=[o.dest.buffer];for(var q=0;q<6;q++)tr.push(o.t[q].buffer);' +
      'o.carDem=K.carDem;tr.push(K.carDem.buffer);' +
      'self.postMessage({t:"done",id:m.id,o:o},tr);}';
  }

  // 片数按设置项来；单进程固定一片
  function wantW() {
    if (!isMulti) return 1;
    let n = +threads || 0;
    if (!(n > 0)) {
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      n = Math.max(1, cores - 1);
    }
    return Math.max(1, Math.min(MAXT, n | 0));
  }

  // 多进程：第 w 片负责哪一块（片数少于各块数时按顺序各管一块，多出来的接着轮）
  function roleOf(w) { return ROLE[w % ROLE.length]; }

  function boot() {
    if ((isMulti ? deadB : deadA) || src || !kernel) return false;
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) { if (isMulti) deadB = true; else deadA = true; return false; }
    try { src = workerSrc(JSON.stringify(OUT)); } catch (e) { if (isMulti) deadB = true; else deadA = true; return false; }
    const want = wantW();
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      for (let i = 0; i < want; i++) {
        const w = new Worker(url);
        w.onmessage = onMsg;
        // 片里抛错时这条 worker 就废了：把挂在它身上的等待全部放开（传 null），
        // 让调用方看到失败并回退，否则整轮求解会一直卡在等结果。
        w.onerror = function (ev) {
          if (ev && ev.message) console.error('[SimPar] worker 错误:', ev.message, 'line', ev.lineno);
          if (isMulti) deadB = true; else deadA = true;
          for (const [wid, p] of pend) {
            const c = wid.lastIndexOf(':');
            if (+wid.slice(c + 1) === pool.indexOf(w) && p && p.res) { pend.delete(wid); p.res(null); }
          }
        };
        pool.push(w);
      }
      nW = pool.length;
      skHeld = {};
    } catch (e) {
      if (isMulti) deadB = true; else deadA = true;
      for (const w of pool) { try { w.terminate(); } catch (e2) {} }
      pool = []; nW = 0;
      return false;
    } finally {
      if (url) { try { URL.revokeObjectURL(url); } catch (e3) {} }
    }
    return nW > 0;
  }

  function onMsg(e) {
    const m = e.data;
    if (!m) return null;
    if (m.t === 'taskDone') { taskCur = null; return null; }
    if (m.t === 'demandR') {
      const p = pend.get(m.id);
      if (!p) return null;
      pend.delete(m.id);
      p.res(m.out);
      return null;
    }
    if (m.t !== 'done') return null;
    const p = pend.get(m.id);
    if (!p) return null;
    pend.delete(m.id);
    p.res(m.o ? { out: m.o } : null);
    return null;
  }

  // 每个 Worker 负责的起点区间；小区数或并行度变化时才变。
  // 起点的工作量差距很大（中心小区候选目的地多），按起点个数平均切会让最重的一片决定整轮耗时，
  // 所以按各起点的需求记录数把总量均分，切点取最接近均值的边界。
  function buildRanges(Z, start) {
    const list = [];
    // 需求表生成时还没有起点偏移表，只能按起点个数均分
    if (!start || start.length !== Z + 1 || !(start[Z] > 0)) {
      const per = Math.ceil(Z / nW);
      for (let w = 0; w < nW; w++) {
        const lo = Math.min(Z, w * per), hi = Math.min(Z, (w + 1) * per);
        list.push(hi > lo ? { lo: lo, hi: hi } : null);
      }
      return list;
    }
    // 按累计需求找切点：第 w 片结束在累计量最接近 (w+1)/nW 的位置。
    // 切点必须单调推进、落在 [lo, Z] 内，且每片至少分到一个起点；
    // 起点数少于片数时后面的片留空，由 run() 跳过。
    const total = start[Z];
    let lo = 0;
    for (let w = 0; w < nW; w++) {
      let hi = Z;
      if (w < nW - 1 && lo < Z) {
        const target = total * (w + 1) / nW;
        const room = Math.min(nW - w - 1, Z - lo - 1);
        const hiMax = Z - room;
        let best = Infinity;
        hi = lo + 1;
        for (let i = lo + 1; i <= hiMax; i++) {
          const d = Math.abs(start[i] - target);
          if (d < best) { best = d; hi = i; }
        }
        if (hi > hiMax) hi = hiMax;
        if (hi <= lo) hi = lo + 1;
      }
      list.push(hi > lo ? { lo: lo, hi: Math.min(hi, Z) } : null);
      if (hi > lo) lo = Math.min(hi, Z);
    }
    return list;
  }

  // 分片切点依赖 odStart 的内容，而需求表重算会换掉它（长度不变），
  // 所以这里同时按内容与片数判断是否需要重切。
  function keyOf(K, od) {
    const b = K.odStart;
    let h = 2166136261;
    for (let i = 0; i < b.length; i += 16) { h ^= b[i]; h = (h * 16777619) >>> 0; }
    return nW + ':' + b.length + ':' + h + ':' + (od ? od.length : 0);
  }

  // 把每片算出的那一段按区间并进主线程这组输出数组：
  // totStat/pT/pM 是跨起点的和，逐片相加；其余按片内顺序写成区间行，carDem 按绝对行号写回。
  function writeInto(merged, out, lo, hi, Z) {
    if (!out) return;
    for (const k of OUT) {
      const src2 = out[k];
      if (!src2 || !merged[k]) continue;
      if (k === 'totStat' || k === 'pT' || k === 'pM') {
        const dst = merged[k];
        for (let i = 0; i < dst.length; i++) dst[i] += src2[i];
      }
    }
    void lo; void hi; void Z;
  }

  function run(K, Z, od, stable) {
    if (!src || !nW) return null;
    const key = keyOf(K, od);
    const fresh = key !== statKey || !ranges;
    if (fresh) {
      statKey = key;
      ranges = buildRanges(Z, K.odStart);
      const stat = {};
      for (const k of STAT) stat[k] = K[k];
      for (const k of ODT) stat[k] = K[k];
      stat.pTlen = K.pT.length; stat.NF = K.fIn.length; stat.B = K.desTot.length;
      for (const w of pool) { try { w.postMessage({ t: 'stat', stat: stat }); } catch (e) {} }
    }
    // carDem 不在 OUT 里，Worker 每片自带一整块算完带回，主线程逐片整段覆盖，不用预先清零
    for (const k of OUT) if (K[k]) K[k].fill(0);
    const dyn = {};
    for (const k of DYN) dyn[k] = K[k];
    // 上一轮收敛时 skT/skK 一个数都没动，Worker 那份仍然是新的，省掉这份 Z² 传输。
    // Worker 按任务分开存矩阵，所以这里只要记住各任务最后发出去时的矩阵有没有变过。
    // 没有任务标识时不能复用缓存（分不清 Worker 手上是哪一份），一律重发。
    const tk = K.task;
    const reuse = !!(stable && tk && skHeld[tk]);
    if (tk) skHeld[tk] = 1;
    // dyn 是整组共享的对象：先按本轮内容定好要发的键，再逐片发。
    // co/cr/gtS/tmS/kmS/skT/skK/facW/facWe/odOk 这些输入只在换月、剪彩、收敛后变一次，
    // 主线程这边引用没变就说明各片上一轮拿到的是同一份，不必再复制一遍（省一次结构化克隆）。
    let light = true;
    for (const k of DYN) { if (dyn[k] !== held[k]) { light = false; break; } }
    if (!(reuse && light)) {
      for (const k of DYN) held[k] = dyn[k];
      if (reuse) { dyn.skT = null; dyn.skK = null; }
    } else for (const k of DYN) delete dyn[k];
    dyn.acc = K.acc ? { zCov: K.acc.zCov, zl: K.acc.zl } : null;
    const waits = [];
    const id = ++token;
    let active = 0;
    for (let w = 0; w < nW; w++) {
      const part = ranges[w];
      if (!part) continue;
      active++;
      const wid = id + ':' + w;
      waits.push(new Promise(function (res) {
        pend.set(wid, { res: res });
        post(pool[w], { t: 'run', id: wid, task: tk || '', role: isMulti ? roleOf(w) : '', dyn: dyn, from: part.lo, to: part.hi }, wid, res);
      }).then(function (r) { return r ? { lo: part.lo, hi: part.hi, out: r.out } : null; }));
    }
    if (!active) return null;
    return Promise.all(waits).then(function (list) {
      // 有任意一片失败就整轮作废，调用方回退串行
      for (const r of list) if (!r) return null;
      const merged = {};
      for (const k of OUT) merged[k] = K[k];
      for (const r of list) {
        writeInto(merged, r.out, r.lo, r.hi, Z);
        // carDem 每片都带回整块，只取本片那几行，按绝对行号写回
        if (r.out && r.out.carDem && K.carDem) K.carDem.set(r.out.carDem.subarray(r.lo * Z, r.hi * Z), r.lo * Z);
      }
      return merged;
    });
  }

  // 需求表生成：各片各算自己那段起点，回来后按起点顺序拼成一块新缓冲。
  // 主线程手边那块复用的缓冲比拼好的总表还大，就地拼反而不划算，所以另外分一块刚好够用的。
  // 带着任务发的（demandT）会让整池等它：排队任务回来前，别的请求都不许发。
  function demand(D, task) {
    if (!src || !nW) return null;
    const Z = D.Z;
    if (demZ !== Z) { demZ = Z; demRanges = buildRanges(Z); }
    const id = ++token;
    const waits = [];
    const per = D.per;
    for (let w = 0; w < nW; w++) {
      const part = demRanges[w];
      if (!part) continue;
      const wid = id + ':' + w;
      waits.push(new Promise(function (res) {
        pend.set(wid, { Z: Z, per: per, res: res });
        post(pool[w], { t: task ? 'demandT' : 'demand', id: wid, D: D, task: task || null, from: part.lo, to: part.hi }, wid, res);
      }).then(function (o) { return o ? { lo: part.lo, per: per, out: o } : null; }));
    }
    return Promise.all(waits).then(function (list) {
      let total = 0;
      for (const r of list) { if (!r) return null; total += r.out.n; }
      const buf = newOd(total + 8);
      const start = new Int32Array(Z + 1);
      const tot = new Float64Array(6);
      let ti = 0;
      for (const r of list) {
        const n = r.out.n;
        buf.dest.set(r.out.dest.subarray(0, n), ti);
        for (let q = 0; q < 6; q++) buf.t[q].set(r.out.t[q].subarray(0, n), ti);
        for (let i = r.lo; i < r.lo + r.out.cnts.length; i++) start[i + 1] = ti + r.out.cnts[i - r.lo];
        for (let q = 0; q < 6; q++) tot[q] += r.out.tot[q];
        ti += n;
        // 拼接完就断开：各片的临时表比拼好的总表还大，留着它们会白白多占一整轮的内存
        r.out = null;
      }
      return { buf: buf, start: start, dest: buf.dest.subarray(0, ti), t: buf.t.map(function (a) { return a.subarray(0, ti); }), tot: tot };
    });
  }

  // 主线程按同一份 odBuffer 源码分配需求缓冲，保证与 Worker 里的结构完全一致
  function newOd(cap) {
    if (!odAlloc) odAlloc = new Function('cap', 'return (' + bufKernel + ')(cap);');
    return odAlloc(cap);
  }

  // 池里每一轮请求都先套一层：排队任务还在等需求表时，这轮请求得等它算完再发，
  // 否则各片会在新旧两份需求表上各算各的。
  function post(w, m, wid, res) {
    const hold = taskCur && taskCur.wait;
    if (hold) { hold.push(function () { send(w, m, wid, res); }); return; }
    send(w, m, wid, res);
  }
  function send(w, m, wid, res) {
    try { w.postMessage(m); }
    catch (e) { pend.delete(wid); res(null); }
  }

  CM.SimPar = {
    // 每次都接受最新注册：脚本被重复求值时（调试器重载、动态再 load），
    // 只认第一次会让 worker 继续跑旧源码，表现为改了库却不生效。
    // 源码真的变了就丢弃已建的池，下次 ready() 按新源码重建。
    setKernel: function (f0, f1, f2, f3, f4, f5) {
      const changed = (f0 && f0 !== kernel) || (f1 && f1 !== demKernel) || (f2 && f2 !== bufKernel) ||
        (f3 && f3 !== growKernel) || (f4 && f4 !== dumpKernel) || (f5 && f5 !== slotKeys);
      if (f0) kernel = f0;
      if (f1) demKernel = f1;
      if (f2) bufKernel = f2;
      if (f3) growKernel = f3;
      if (f4) dumpKernel = f4;
      if (f5) slotKeys = f5;
      if (changed) {
        src = null; pool = []; nW = 0; statKey = ''; ranges = null;
        demZ = 0; demRanges = null; skHeld = {}; taskCur = null;
        pend.clear();
      }
    },
    // 模式选择：mode 为 true 走 B 多进程，false 走 A 单进程；池推倒重建，下次 ready() 按新分支来
    setMode: function (multi) {
      multi = !!multi;
      if (multi === isMulti) return true;
      isMulti = multi;
      threads = 0;
      if (multi) deadB = false; else deadA = false;
      return this.stop();
    },
    multi: function () { return isMulti; },
    ready: function () {
      if (!kernel) return false;
      if (isMulti ? deadB : deadA) return false;
      if (!src) return boot();
      if (!pend.size && !taskCur && nW !== wantW()) { this.stop(); return boot(); }
      return nW > 0;
    },
    run: function (K, Z, od, stable) { return run(K, Z, od, stable); },
    demand: function (D) { return demand(D) || null; },
    // 各处自己算这段时先挂到池上排队：任务里带需求表就先算它，回来由调用方 release
    begin: function () {
      if (!this.ready()) return null;
      if (taskCur) taskCur.refs++;
      const o = { demand: null, t: 'task', refs: 1, wait: [] }, tok = { promise: null, release: null, next: null };
      tok.promise = new Promise(function (res) { tok.release = res; });
      o.demand = function (D) {
        const p = demand(D, o);
        if (!p) { tok.release(false); return tok.promise; }
        o.wait.push(function () { p.then(function (r) { if (r) { CM.SimPar.deliver(D, r); tok.release(true); } else tok.release(false); }); });
        return tok.promise;
      };
      taskCur = o;
      return tok;
    },
    // 池里每一轮请求都先套一层：有排队任务就先等它（需求表要现算），再发消息
    head: function (tok) {
      if (!tok) return null;
      const o = { t: tok.id, task: taskCur, release: tok.release };
      if (taskCur && taskCur.refs-- <= 0) {
        taskCur.wait.forEach(function (f) { f(); });
        taskCur = null;
      }
      return o;
    },
    // 需求表算好后当场装进去（与串行分支写的是同一份）
    deliver: function (D, r) {
      D.bufs[D.bufIdx] = r.buf;
    },
    // 之后主线程换个模式时，正在算的这轮还没回来就别拆池
    threads: function () { return wantW(); },
    count: function () { return nW; },
    // 改片数：池按新片数重建。正在算的这轮不打断（片数一变，在途的请求就对不上了），
    // 等它自己结束；主线程一旦有空就会调用 ready()，那时按新片数建池。
    setThreads: function (n) {
      n = Math.max(1, Math.min(MAXT, (+n | 0) || 2));
      if (n === threads) return true;
      threads = n;
      if (!src) return true;
      if (pend.size || taskCur) return false;
      this.stop();
      return boot();
    },
    // 释放 Worker（空闲休眠时调用）：仍有求解在等结果时不动，避免请求永远悬着
    stop: function () {
      if (pend.size) return false;
      for (const w of pool) { try { w.terminate(); } catch (e) {} }
      pool = []; nW = 0; src = null; statKey = ''; ranges = null; demZ = 0; demRanges = null; skHeld = {};
      taskCur = null; odAlloc = null;
      return true;
    }
  };
})(window.CM);
