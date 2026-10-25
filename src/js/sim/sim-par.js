'use strict';
// 交通分配的多核并行：把每个起点的出行需求计算（sim.js 里的 odOrigin）按小区分片，
// 交给多个 Web Worker 同时计算，再在主线程把统计量合并回本次迭代。
// Worker 里的 odOrigin 由 sim.js 用 Function.prototype.toString 注入，与单线程跑的是同一份源码，
// 保证两条路径的算法完全一致（只有累加顺序按分片不同，浮点尾数会有 1e-15 级差异）。
// 不随迭代变化的部分（OD 表、小区、设施、接驳表……）每个 Worker 只发一次，每次求解只发会变的时耗与参数。
// 环境不支持 Worker 时 ready() 返回 false，调用方回退到原来的单线程循环。
(function (CM) {
  // 每次求解都要把会变的输入发给每一片，其中 skT/skK 是 Z×Z（Z=720 时各约 2 MB），
  // gtS/tmS/kmS 是 N×N（车站数）。片数一多，结构化克隆就成了主要开销：
  // 实测传输随片数线性上涨，而分片计算量按片数下降，所以上限不能只按核数放。
  // 每片还要各留一份 carDem（Z×Z）与十余个输出数组，且 WebKit 的 ArrayBuffer 归还很慢。
  // 片数上限另有设置项（计算设置里的步进线程），这里只兜底。
  // 线程数上限：每片要各存一份 skT/skK（Z²）和十几组输出数组，传输也按片数线性涨，
  // 超过这个数基本只剩内存和克隆开销，算得并不更快
  const MAXT = 10;
  // 这些名字必须与 sim.js 里 K 的键名完全一致，否则主线程合并时取不到目标数组（静默丢结果）
  const OUT = ['totStat', 'pT', 'pM', 'hasCar', 'zTrips', 'zMetro', 'zAccess', 'desTot', 'desMetro', 'zDest', 'zDestM', 'fIn', 'fInM', 'fOut', 'fOutM', 'fP', 'DS'];
  const DYN = ['co', 'cr', 'gtS', 'tmS', 'kmS', 'skT', 'skK', 'facW', 'facWe', 'odOk'];
  const STAT = ['Z', 'NZ', 'N', 'facW', 'facWe', 'odOk', 'kmPerCell', 'cpk', 'park', 'vot', 'carAccess', 'walkW', 'occ', 'theta', 'fareFlat', 'accOk',
    'perMin', 'capSh', 'capLz', 'hostZ', 'nx', 'ny', 'blocks', 'zJ'];
  const ODT = ['odStart', 'odDest', 't0', 't1', 't2', 't3', 't4', 't5'];
  let kernel = null, demKernel = null, bufKernel = null, growKernel = null, dumpKernel = null, slotKeys = '';
  let src = null, pool = [], nW = 0, token = 0, statKey = '', ranges = null, dead = false, skHeld = {};
  const held = {};
  let demZ = 0, demRanges = null, odAlloc = null;
  let threads = 2;
  const pend = new Map();

  function workerSrc() {
    const keys = JSON.stringify(OUT);
    return buildSrc(keys);
  }

  function buildSrc(keys) {
    return 'var INF=1e30;' +
      'var NPK=6,HW=0,SH=2,LZ=4,PK=["hw","sc","sh","md","lz","hb"];' +
      'var U={dist:function(ax,ay,bx,by){var dx=bx-ax,dy=by-ay;return Math.sqrt(dx*dx+dy*dy);}};' +
      'var odOrigin=(' + kernel + ');' +
      'var demandOrigin=(' + demKernel + ');' +
      'var odBuffer=(' + bufKernel + ');' +
      'var odGrow=(' + growKernel + ');' +
      'var odDump=(' + dumpKernel + ');' +
      'var OUT=' + keys + ',ST=null,SK={};' +
      'function alloc(K){var Z=K.Z,NZ=K.NZ,N=K.N,B=K.B;' +
      'K.pT=new Float64Array(K.pTlen);K.pM=new Float64Array(K.pTlen);K.cO=new Float64Array(K.pTlen);K.cR=new Float64Array(K.pTlen);K.totStat=new Float64Array(14);' +
      'K.hasCar=new Uint8Array(Z);K.zTrips=new Float64Array(Z);K.zMetro=new Float64Array(Z);K.zAccess=new Float64Array(Z);' +
      'K.desTot=new Float64Array(B);K.desMetro=new Float64Array(B);K.zDest=new Float64Array(6*Z);K.zDestM=new Float64Array(6*Z);' +
      'K.fIn=new Float64Array(K.NF);K.fInM=new Float64Array(K.NF);K.fOut=new Float64Array(K.NF);K.fOutM=new Float64Array(K.NF);K.fP=new Float64Array(K.NF*K.pTlen);' +
      'K.DS=new Float32Array(N*N);K.choices=new Int8Array(NZ*NZ).fill(-2);' +
      // odOrigin 按绝对行号写 carDem[ho*Z+hd]，所以这里得给整块，不能只给本片那几行
      'K.carDem=new Float64Array(Z*Z);}' +
      // 需求生成：每个 Worker 只算自己那段起点，输出自己的缓冲与每起点记录数
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
      'self.onmessage=function(e){var m=e.data;if(m.t==="stat"){ST=m.stat;return;}' +
      'if(m.t==="demand"){var d=demand(m.D,m.from,m.to);var tr=[];' +
      'tr.push(d.dest.buffer);for(var q=0;q<6;q++)tr.push(d.t[q].buffer);tr.push(d.tot.buffer);tr.push(d.cnts.buffer);' +
      'self.postMessage({t:"done",id:m.id,out:d},tr);return;}' +
      'var K={},k;for(k in ST)K[k]=ST[k];for(k in m.dyn)K[k]=m.dyn[k];' +
      'var sk=SK[m.task]||(SK[m.task]={t:null,k:null});' +
      'if(K.skT){sk.t=K.skT;sk.k=K.skK;}else if(sk.t){K.skT=sk.t;K.skK=sk.k;}' +
      'else{self.postMessage({t:"done",id:m.id,out:null,e:[]});return;}' +
      'alloc(K);for(var i=m.from;i<m.to;i++)odOrigin(K,i);' +
      // 每片只打包自己算过的那几个小区，结果由主线程按区间并进那组数组。
      'var o=odBuffer(Math.max(64,(m.to-m.from)*OUT.length*32+64));' +
      'for(var i=m.from;i<m.to;i++){if(o.cap-o.n<(m.to-i)*8)o=odGrow(o,o.n,Math.max(o.cap*2,o.n+(m.to-i)*OUT.length*64));odDump(K,i,o);}' +
      'var tr=[o.dest.buffer];for(var q=0;q<6;q++)tr.push(o.t[q].buffer);' +
      'o.carDem=K.carDem;tr.push(K.carDem.buffer);' +
      'self.postMessage({t:"done",id:m.id,o:o},tr);};';
  }

  // 片数按设置项「步进线程」来，1–16
  function wantW() {
    let n = +threads || 0;
    if (!(n > 0)) {
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      n = Math.max(1, cores - 1);
    }
    return Math.max(1, Math.min(MAXT, n | 0));
  }

  function boot() {
    if (dead || src || !kernel) return false;
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) { dead = true; return false; }
    try { src = workerSrc(); } catch (e) { dead = true; return false; }
    const want = wantW();
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      for (let i = 0; i < want; i++) {
        const w = new Worker(url);
        w.onmessage = onMsg;
        // 片里抛错时这条 worker 就废了：把挂在它身上的等待全部放开（传 null），
        // 让调用方看到失败并回退串行，否则整轮求解会一直卡在等结果。
        w.onerror = function (ev) {
          if (ev && ev.message) console.error('[SimPar] worker 错误:', ev.message, 'line', ev.lineno);
          dead = true;
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
      dead = true;
      for (const w of pool) { try { w.terminate(); } catch (e2) {} }
      pool = []; nW = 0;
      return false;
    } finally {
      if (url) { try { URL.revokeObjectURL(url); } catch (e3) {} }
    }
    return nW > 0;
  }

  // 零号片换回来的是整套快照；其余片给的是按小区装好的记录。
  // 需求表那边直接拼在原缓冲上，所以只需把每片的片段按起点偏移挂上去。
  function onMsg(e) {
    const m = e.data;
    if (!m || m.t !== 'done') return null;
    const p = pend.get(m.id);
    if (!p) return null;
    pend.delete(m.id);
    if (p.dest) {
      // 需求表：片里给的缓冲起点是 0，主线程要的是拼进总表后的位置
      const at = p.lo * p.per;
      m.o.dest = p.dest.subarray(at);
      for (let q = 0; q < 6; q++) m.o.t[q] = p.t[q].subarray(at);
    }
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
        // 至少给后面每片留一个起点；起点不足时只能按顺序排到底
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
  // 所以用一个随每次重建递增的标记把内容变化也纳入 key，避免沿用旧切点。
  let odStamp = 0, odLast = null;
  function keyOf(K, od) {
    if (K.odStart !== odLast) { odLast = K.odStart; odStamp++; }
    return [K.Z, K.NZ, K.N, K.B, K.odStart.length, K.t0.length, od ? (od.key || '') : '', od ? od.F : 0, odStamp].join('|');
  }

  // 零号片换来的一整套快照直接顶替；其余片带回的是按小区装好的记录，按区间写进这组数组。
  function writeInto(dst, o) {
    const key = slotKeys.split(',');
    for (let k = 0; k < o.n;) {
      const name = key[o.dest[k]], f0 = o.dest[k + 1], n = o.dest[k + 2] - o.dest[k + 1];
      k += 3;
      const b = dst[name];
      if (b && b.set) b.set(o.t[0].subarray(k, k + n), f0);
      else if (b) { const s = o.t[0].subarray(k, k + n); for (let i = 0; i < n; i++) if (s[i]) b[f0 + i] = 1; }
      k += n;
    }
  }

  // 主线程开启一次并行求解：K 的输出数组先清零，各 Worker 只算自己那片小区，
  // 回来的数组用 transfer 移交，收到就直接顶替原来的数组。返回 Promise，供 jump 的推进驱动等待。
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
        const msg = { t: 'run', id: wid, task: tk || '', dyn: dyn, from: part.lo, to: part.hi };
        try { pool[w].postMessage(msg); }
        catch (e) { pend.delete(wid); res(null); }
      }).then(function (r) { return r ? { lo: part.lo, hi: part.hi, out: r.out } : null; }));
    }
    if (!active) return null;
    return Promise.all(waits).then(function (list) {
      // 有任意一片失败就整轮作废，调用方回退串行重算
      for (const r of list) if (!r) return null;
      const merged = {};
      for (const k of OUT) merged[k] = K[k];
      for (const r of list) {
        writeInto(merged, r.out);
        // carDem 每片都带回整块，只取本片那几行，按绝对行号写回
        if (r.out && r.out.carDem && K.carDem) K.carDem.set(r.out.carDem.subarray(r.lo * Z, r.hi * Z), r.lo * Z);
      }
      return merged;
    });
  }

  // 需求表生成：各片各算自己那段起点，回来后按起点顺序拼成一块新缓冲。
  // 主线程手边那块复用的缓冲比拼好的总表还大，就地拼反而不划算，所以另外分一块刚好够用的。
  // 任何一片失败都返回 null，调用方回退串行。
  function demand(D) {
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
        try { pool[w].postMessage({ t: 'demand', id: wid, D: D, from: part.lo, to: part.hi }); }
        catch (e) { pend.delete(wid); res(null); }
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
      list = null;
      return { buf: buf, start: start, dest: buf.dest.subarray(0, ti), t: buf.t.map(function (a) { return a.subarray(0, ti); }), tot: tot };
    });
  }

  // 主线程按同一份 odBuffer 源码分配需求缓冲，保证与 Worker 里的结构完全一致
  function newOd(cap) {
    if (!odAlloc) odAlloc = new Function('cap', 'return (' + bufKernel + ')(cap);');
    return odAlloc(cap);
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
        demZ = 0; demRanges = null; skHeld = {}; odLast = null; odStamp++;
        pend.clear();
      }
    },
    demand: function (D) {
      const p = demand(D);
      return p || null;
    },
    ready: function () {
      if (!kernel) return false;
      if (!src && !dead) boot();
      else if (src && !pend.size && nW !== wantW()) { this.stop(); boot(); }
      return !!src && nW > 0 && !dead;
    },
    run: function (K, Z, od) { return run(K, Z, od); },
    count: function () { return nW; },
    // 当前实际会用到的线程数：设置里没指定时按核数算，设置界面拿它当滑条初值
    want: function () { return wantW(); },
    // 改片数：Worker 池按新片数重建。正在算的这轮不打断（片数一变，在途的请求就对不上了），
    // 等它自己结束；主线程一旦有空就会调用 ready()，那时按新片数建池。
    setThreads: function (n) {
      n = Math.max(1, Math.min(MAXT, (+n | 0) || 2));
      if (n === threads) return true;
      threads = n;
      if (!src) return true;
      if (pend.size) return false;
      this.stop();
      boot();
      return nW > 0;
    },
    // 释放 Worker（空闲休眠时调用）：仍有求解在等结果时不动，避免请求永远悬着
    stop: function () {
      if (pend.size) return false;
      for (const w of pool) { try { w.terminate(); } catch (e) {} }
      pool = []; nW = 0; src = null; statKey = ''; ranges = null; demZ = 0; demRanges = null; skHeld = {};
      odLast = null; odStamp++;   // 切点表已作废，不能让它和旧记录的取值撞上
      return true;
    }
  };
})(window.CM);
