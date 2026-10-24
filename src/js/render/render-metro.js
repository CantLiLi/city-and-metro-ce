'use strict';
// 地铁：轨道与车站的整层位图缓存、平移贴图，以及轨道建设方式的装饰绘制
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;
  const UNDER_DEPTH = CM.RENDER_CONST.UNDER_DEPTH;

  Renderer.prototype.lineWidthPx = function () { return U.clamp(this.z * 0.1, 2.8, 9); };
  Renderer.prototype.segScreen = function (cs, under, out) {
    const pts = cs.g.pts, hs = cs.h, n = pts.length;
    // 缓存键每帧（及地下视图进度变化时）只拼一次
    if (this._ssFrame !== this.frame || this._ssUnder !== under) { this._ssFrame = this.frame; this._ssUnder = under; this._ssKey = this.M.join(',') + ':' + this.z + ':' + this.px + ':' + this.py + ':' + under + ':' + this.hs; }
    const key = this._ssKey;
    let cached = !out && this.segScreens.get(cs);
    if (cached && cached.key === key) return cached.arr;
    const arr = out || (cached ? cached.arr : new Float32Array(n * 2));
    const uw = U.smooth(under);
    const ty = cs.seg.type;
    for (let i = 0; i < n; i++) {
      let h = hs[i];
      if (h < 0) h = h * uw * UNDER_DEPTH;
      const M = this.M, z = this.z;
      arr[i * 2] = this.px + (M[0] * pts[i][0] + M[1] * pts[i][1]) * z;
      arr[i * 2 + 1] = this.py + (M[2] * pts[i][0] + M[3] * pts[i][1]) * z - h * this.hs;
    }
    if (!out) this.segScreens.set(cs, { key: key, arr: arr });
    return arr;
  };
  // 地铁整层位图缓存：轨道、车站、换乘连线只在相机 / 线网 / 主题变化时重描一次，其余帧贴位图。
  // 线网大了以后每帧重描几十万点是主要开销，这里把它降到一次 drawImage；平移时按位移复用旧位图，
  // 并把缓存的屏幕坐标一起平移，隔太久或移得太远再补一帧清晰图。
  Renderer.prototype.dropMetroLayer = function () {
    const m = this.metroLayer;
    if (m && m.cv) { m.cv.width = 1; m.cv.height = 1; }
    this.metroLayer = null;
  };
  Renderer.prototype.metroLayerKey = function (g, ui) {
    // 位图按折线缓存实际使用的格点（px/py/dpr）作键：换成叠层的满分辨率格点后，
    // 主画布的 dpr 每次都不同，拿它当键会让位图每帧作废、退回逐帧重描。
    // z / hs / 画布偏移由调用方另外比对
    return [this.w, this.h, this.ldpr, this.M.join(','), this.themeName,
      U.smooth(this.cam.under).toFixed(3), this.layer, (this.layerFade || 0).toFixed(2),
      this.tEase > 0.05 ? 1 : 0, (ui && ui.highlightLine) || '', this.detail.tier, g.city.version, g.netVersion || 0,
      g.model && g.model.version ? g.model.version : 0].join('|');
  };
  // 把地铁位图按位移贴到叠层画布上，只贴视口那一块：位图比方口大一圈（余量），
  // 整幅贴上去等于每帧白合成视口外的部分（叠层画布刚被 metroCtx 清过，所以直接用整块贴）
  Renderer.prototype.blitMetro = function (cv, dx, dy, mx, my) {
    const ctx = this.lctx, d = this.ldpr || 1, w = this.w, h = this.h;
    mx = mx || 0; my = my || 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cv, (mx - dx) * d, (my - dy) * d, w * d, h * d, 0, 0, Math.round(w * d), Math.round(h * d));
  };
  // 地铁层位图的四周余量：平移时靠它整块贴回，位移超出余量才重描。
  // 贴图只合成视口那一块，余量不再增加每帧填充率，只花内存，所以给得宽一些（两成），
  // 一次拖动往往滑不到余量边缘；上限 14e6 像素守住内存，高分屏这里会自动收窄。
  Renderer.prototype.metroMargin = function () {
    let mx = Math.max(64, Math.round(this.w * 0.22)), my = Math.max(64, Math.round(this.h * 0.22));
    const d = this.ldpr || 1, cap = 14e6, pix = (this.w + 2 * mx) * (this.h + 2 * my) * d * d;
    if (pix > cap) { const k = Math.sqrt(cap / pix); mx = Math.max(40, Math.floor(mx * k)); my = Math.max(40, Math.floor(my * k)); }
    return { mx: mx, my: my };
  };
  // 位图按位移贴着用时，屏幕坐标缓存也要跟着平移（只是加法，比重投影几十万点便宜得多）。
  // 逐点折线缓存 segPx 存的是路线点，z 固定时平移量相同；车站点位 stPx 是屏幕坐标，要按 z 放大回去
  Renderer.prototype.shiftMetroPx = function (dx, dy, z) {
    if (this.segPx) this.segPx.forEach(function (arr) { for (let i = 0; i < arr.length; i += 2) { arr[i] += dx; arr[i + 1] += dy; } });
    const k = (z || this.z) / this.z;
    if (this.stPx) for (const p of this.stPx) if (p) { p.x += dx * k; p.y += dy * k; p.cx += dx * k; p.cy += dy * k; }
  };
  Renderer.prototype.stH = function (s, under) {
    let hh = CFG.metro.height[s.type];
    if (hh < 0) hh = hh * under * UNDER_DEPTH;
    return hh;
  };
  // 区段排序表 + 视野内区段：整层重描用，线网版本变了才重建排序表
  Renderer.prototype.metroIndex = function (C, v) {
    if (!this.metroOrder || this.metroOrder.C !== C) {
      const order = [], rank = { underground: 0, surface: 1, elevated: 2 };
      C.segs.forEach(function (cs) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of cs.g.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        order.push({ cs: cs, bbox: [x0, y0, x1, y1] });
      });
      order.sort(function (a, b) { return rank[a.cs.seg.type] - rank[b.cs.seg.type]; });
      this.metroOrder = { C: C, order: order, grid: CM.Geo.buckets(order, 8, this.game.city.W, this.game.city.H) };
    }
    const indexed = this.metroOrder;
    return { indexed: indexed, visible: new Set(CM.Geo.query(indexed.grid, v.x0 - 6, v.y0 - 6, v.x1 + 6, v.y1 + 6)) };
  };
  Renderer.prototype.metroLayerDraw = function (ui) {
    const g = this.game;
    const draft = g.draft ? g.draftCompiled() : null;
    const planOv = draft && g.planActive && g.plansById[g.planActive] ? g.planOverlay(g.planActive) : null;
    const C = draft || g.compiled;
    this.drawnC = C;
    // 地铁直接画在满分辨率的叠层画布上，跟主画布的降分辨率脱钩；主画布不再碰这一层。
    // 返回值的 canvas 给依赖地铁投影（segPx / stPx）的图层接着往同一层上画
    const mc = this.metroCtx();
    // 草案编辑与方案预览带逐帧动画（走动虚线、脉冲强调），直接走完整路径
    if (draft || planOv) {
      this.dropMetroLayer();
      this.drawMetroStatic(mc, ui, C, true, 0, true);
      this.drawMetroSel(ui, C);
      return mc;
    }
    const core = this.metroLayerKey(g, ui);
    // 整块回贴等于把位图又采样了一遍：只允许在「像素对像素」时做，否则线条会被反复软化，
    // 位图刚建好的那一帧（full 只差 px/py 的极小数）就直接用矢量路径画，画出来是干净的
    const ox = this.lpx, oy = this.lpy;
    const full = core + '|' + this.z + '|' + this.hs + '|' + ox + '|' + oy;
    const m = this.metroLayer;
    if (m && m.cv && m.core === core && m.full === full && m.ox === ox && m.oy === oy) {
      this.blitMetro(m.cv, 0, 0, m.mx, m.my);
      this.drawMetroSel(ui, C);
      return mc;
    }
    // 平移：位移还在位图余量内就整块贴着走（屏幕坐标缓存同步平移），超出余量重新出图。
    // 平移量取整到设备像素：贴图才能像素对像素，否则每帧都重采样一次，线条会越贴越虚
    if (m && m.cv && m.core === core && m.z === this.z && !m.pxStale) {
      const bx = Math.round((this.lpx - m.ox) * (this.ldpr || 1)) / (this.ldpr || 1);
      const by = Math.round((this.lpy - m.oy) * (this.ldpr || 1)) / (this.ldpr || 1);
      if (Math.abs(bx) <= m.mx && Math.abs(by) <= m.my) {
        const dx = bx - (m.dx || 0), dy = by - (m.dy || 0);
        if (dx || dy) { this.shiftMetroPx(dx, dy, m.z); m.dx = bx; m.dy = by; }
        this.metroOx = this.lpx; this.metroOy = this.lpy;
        this.blitMetro(m.cv, bx, by, m.mx, m.my);
        this.drawMetroSel(ui, C);
        return mc;
      }
    }
    this.buildMetroLayer(ui, C, core, ox, oy, full);
    this.drawMetroSel(ui, C);
    return mc;
  };
  // 重描一整层地铁位图并贴回
  Renderer.prototype.buildMetroLayer = function (ui, C, core, ox, oy, full) {
    const m = this.metroLayer, mg = this.metroMargin();
    const d = this.ldpr || 1;
    const cw = Math.round((this.w + 2 * mg.mx) * d), ch = Math.round((this.h + 2 * mg.my) * d);
    const cv = m && m.cv && m.cv.width === cw && m.cv.height === ch ? m.cv : makeCanvas(cw, ch);
    const x = cv.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, cw, ch);
    x.setTransform(d, 0, 0, d, mg.mx * d, mg.my * d);
    // 位图里的内容按整设备像素的偏移投影：贴回时位移也是整格，两步都不重采样，线条才不会发虚
    this.drawMetroStatic(x, ui, C, false, Math.max(mg.mx, mg.my));
    this.metroOx = ox; this.metroOy = oy;
    this.metroLayer = { core: core, full: full, cv: cv, ox: ox, oy: oy, z: this.z, mx: mg.mx, my: mg.my, dx: 0, dy: 0 };
    // 这一帧已经付过整层重描的代价：同一帧不要再重建标注位图，两笔重活撞一起就是一次明显的掉帧
    this._metroBuiltFrame = this.frame;
    this.blitMetro(cv, 0, 0, mg.mx, mg.my);
  };
  // 地铁层画在叠层画布（#labels）上：先清空整层，文字层的内容由 drawLabels 接着画
  Renderer.prototype.metroCtx = function () { return this.labelCtx(); };
  // 选中高亮每帧单独画：位图缓存里放不了会呼吸的脉冲环
  Renderer.prototype.drawMetroSel = function (ui, C) {
    const sel = ui && ui.selection;
    if (!sel) return;
    const ctx = this.lctx;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (sel.kind === 'seg') {
      const arr = this.segPx && this.segPx.get(sel.id);
      const seg = this.game.net && this.game.net.segments ? this.game.net.segments[sel.id] : null;
      if (!arr || !seg) return;
      const line = C.net.lines[seg.line];
      ctx.globalAlpha = 0.35; ctx.strokeStyle = line ? line.color : '#888';
      ctx.lineWidth = this.lineWidthPx() + 8;
      this.strokeArr(ctx, arr);
      ctx.globalAlpha = 1;
    } else if (sel.kind === 'station') {
      let p = null;
      if (this.stPx) for (const sp of this.stPx) if (sp && sp.id === sel.id) { p = sp; break; }
      if (!p) return;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
      ctx.strokeStyle = 'rgba(30,136,229,' + (0.5 + 0.4 * pulse).toFixed(3) + ')';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  Renderer.prototype.drawMetroStatic = function (ctx, ui, C, animated, pad) {
    const g = this.game;
    const draft = animated ? g.draft : null;
    const under = U.smooth(this.cam.under), t = this.tEase;
    const lw = this.lineWidthPx();
    // 画进位图留白里的东西也要算进可见范围，否则平移贴回时余量那圈是空的
    const pd = (pad || 0) / this.z, v0 = this.view;
    const v = pd > 0 ? { x0: v0.x0 - pd, y0: v0.y0 - pd, x1: v0.x1 + pd, y1: v0.y1 + pd } : v0;
    const hlLine = ui && ui.highlightLine;
    // 当前方案的改动：属于它的对象正常显示并描一圈强调色，其余草案内容压暗
    const planOv = animated && g.draft && g.planActive && g.plansById[g.planActive] ? g.planOverlay(g.planActive) : null;
    const lyrDim = this.layer === 'cong' || this.layer === 'flow' ? 1 - 0.65 * (this.layerFade || 0) : 1;   // 拥堵、出行方向图层下淡化地铁
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (!this.segPx) this.segPx = new Map(); else this.segPx.clear();
    // 草案中被删除的正式轨道（虚影）
    if (draft) {
      g.compiled.segs.forEach((cs, id) => {
        if (C.segs.has(id)) return;
        let inBase = false;
        C.segs.forEach(function (d) { if (d.seg.base && d.seg.base.indexOf(id) >= 0) inBase = true; });
        if (inBase) return;
        const arr = this.segScreen(cs, under);
        ctx.strokeStyle = 'rgba(214,48,49,0.55)'; ctx.lineWidth = lw; ctx.setLineDash([lw * 1.2, lw * 1.2]);
        this.strokeArr(ctx, arr); ctx.setLineDash([]);
      });
    }
    const idx = this.metroIndex(C, v), indexed = idx.indexed, visible = idx.visible;
    // 越江隧道：所有可见区段合成一条路径、每帧只描一次（大型线网不随区段数增加描边次数）；
    // 被高亮线路淡化的区段仍在各自绘制时单独描边
    this._tunBatch = false;
    if (this.z >= 12 && under < 0.5) {
      const wp = new Path2D(), add = function (p, arr, r) { p.moveTo(arr[r[0] * 2], arr[r[0] * 2 + 1]); for (let i = r[0] + 1; i <= r[1]; i++) p.lineTo(arr[i * 2], arr[i * 2 + 1]); };
      let anyW = false;
      for (let q = 0; q < indexed.order.length; q++) {
        if (!visible.has(q)) continue;
        const cs = indexed.order[q].cs, s = cs.seg, bb = indexed.order[q].bbox;
        if (!C.net.lines[s.line] || (hlLine && hlLine !== s.line)) continue;
        if (bb[2] < v.x0 - 6 || bb[0] > v.x1 + 6 || bb[3] < v.y0 - 6 || bb[1] > v.y1 + 6) continue;
        const d = this.segDeco(cs);
        if (!d.water.length) continue;
        const arr = this.segScreen(cs, under);
        for (const r of d.water) if (cs.h[(r[0] + r[1]) >> 1] < -DECO_FLAT) { add(wp, arr, r); anyW = true; }
      }
      if (anyW) { ctx.lineCap = 'butt'; ctx.globalAlpha = (1 - 2 * under) * lyrDim; ctx.strokeStyle = S.TH.trk.tunnelWater; ctx.lineWidth = lw + 4.5; ctx.stroke(wp); ctx.lineCap = 'round'; ctx.globalAlpha = 1; }
      this._tunBatch = true;
    }
    for (let q = 0; q < indexed.order.length; q++) {
      if (!visible.has(q)) continue;
      const cs = indexed.order[q].cs;
      const s = cs.seg;
      const line = C.net.lines[s.line];
      if (!line) continue;
      // 粗略裁剪
      const A = C.net.stations[s.a], B = C.net.stations[s.b];
      const bb = indexed.order[q].bbox;
      if (bb[2] < v.x0 - 6 || bb[0] > v.x1 + 6 || bb[3] < v.y0 - 6 || bb[1] > v.y1 + 6) continue;
      const arr = this.segScreen(cs, under);
      this.segPx.set(s.id, arr);
      const col = line.color;
      let alpha = 1, width = lw;
      if (s.type === 'underground') { alpha = U.lerp(0.92, 1, under); width = lw * U.lerp(0.95, 1.05, under); }
      else if (under > 0) alpha = U.lerp(1, 0.35, under);
      if (hlLine && hlLine !== s.line) alpha *= 0.3;
      const inPlan = planOv ? !!planOv.segs[s.id] : null;
      if (planOv && !inPlan) alpha *= 0.42;
      alpha *= lyrDim;
      this.drawTrack(ctx, cs, arr, col, alpha, width, under, t, this._tunBatch && !(hlLine && hlLine !== s.line));
      if (inPlan) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
        ctx.globalAlpha = 0.55 + 0.35 * pulse;
        ctx.strokeStyle = S.TH.stInter; ctx.lineWidth = width + 5; this.strokeArr(ctx, arr);
        ctx.globalAlpha = 1;
      }
      // 草案标记
      if (draft) {
        const o = g.net.segments[s.id], na = g.net.stations[s.a], nb = g.net.stations[s.b];
        const changed = !o || o.type !== s.type || JSON.stringify(o.pts) !== JSON.stringify(s.pts) || !na || !nb || na.x !== A.x || na.y !== A.y || nb.x !== B.x || nb.y !== B.y;
        if (changed) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = Math.max(1.2, width * 0.3); ctx.setLineDash([5, 5]);
          ctx.lineDashOffset = -this.time * 12;
          this.strokeArr(ctx, arr); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
      }
      ctx.globalAlpha = 1;
    }
    // 站外换乘：两座不同线路的运营车站之间可步行换乘（虚线连接，两站都按换乘站标示）
    const xfer = xferInfo(g, C), xLinks = xfer.links;
    const stH = (s) => this.stH(s, under);
    if (xLinks.length) {
      ctx.strokeStyle = S.TH.stInter; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(2, lw * 0.45); ctx.setLineDash([3, 4]); ctx.lineCap = 'round';
      ctx.beginPath();
      for (const l of xLinks) { const A = C.stations[l[0]], B = C.stations[l[1]], pa = this.P(A.x, A.y, stH(A)), pb = this.P(B.x, B.y, stH(B)); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // 车站
    drawStations.call(this, ctx, C, v, under, stH, xfer, hlLine, lyrDim, planOv, draft);
  };

  // 每个编译后的区段只计算一次装饰数据（采样下标）：越水区间、地下 / 地面 / 高出地面各段、桥墩与铁路交叉。
  // 远景（缩放 < 12）与地下视图沿用原有画法；中近景按轨面高度分段绘制，每帧只做描边，不重算几何。
  const DECO_BURIED = -0.035, DECO_FLAT = 0.004;   // 轨面低于约 1/3 埋深视为地下段
  function decoRuns(n, test) {
    const out = []; let s = -1;
    for (let i = 0; i < n; i++) {
      if (test(i)) { if (s < 0) s = i; } else if (s >= 0) { out.push([Math.max(0, s - 1), i]); s = -1; }
    }
    if (s >= 0) out.push([Math.max(0, s - 1), n - 1]);
    return out;
  }
  // 轨道装饰分段的持久化：算一次要遍历采样点查水域、找铁路交叉，存到磁盘下次开局直接命中
  function decoHash(h, v) { return Math.imul(h ^ (v | 0), 16777619) >>> 0; }
  Renderer.prototype.segDecoKey = function (cs) {
    const s = cs.seg, city = this.game.city, pts = s.pts || [];
    let h = 2166136261;
    h = decoHash(h, (city.uid || 0) |
      ((city.terrainVer || 0) << 8));
    h = decoHash(h, cs.g.pts.length);
    h = decoHash(h, s.type === 'elevated' ? 3 : s.type === 'underground' ? 5 : 7);
    for (let i = 0; i < pts.length; i++) {
      h = decoHash(h, Math.round(pts[i][0] * 4));
      h = decoHash(h, Math.round(pts[i][1] * 4));
    }
    return 'sd' + CM.Cache.version + ':' + s.id + ':' + h.toString(36);
  };
  function decoEncode(d) {
    return JSON.stringify({
      tv: d.tv, piers: d.piers, rails: d.rails, raised: d.raised ? 1 : 0,
      water: d.water, buried: d.buried, ground: d.ground, high: d.high, ramp: d.ramp,
      wet: Array.prototype.slice.call(d.wet),
    });
  }
  function decoDecode(o, tv) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.wet)) return null;
    return {
      tv: tv, wet: Uint8Array.from(o.wet), piers: o.piers || [], rails: o.rails || [], raised: !!o.raised,
      water: o.water || [], buried: o.buried || [], ground: o.ground || [], high: o.high || [], ramp: o.ramp || [],
    };
  }
  // 换城市 / 读档后先把磁盘上存过的装饰数据拉回来，避免首次铺开时逐段现算
  Renderer.prototype.prewarmDeco = function () {
    const g = this.game, C = g && g.compiled;
    if (!C || !C.segs || !CM.Cache) return;
    const list = [];
    C.segs.forEach((cs) => { if (!this.segDecos.get(cs)) list.push(cs); });
    if (!list.length) return;
    const keys = list.map((cs) => this.segDecoKey(cs));
    const tv = (g.city.uid || 0) * 4096 + (g.city.terrainVer || 0);
    CM.Cache.getMany(keys).then((items) => {
      if (this.game !== g) return;
      for (let i = 0; i < list.length; i++) {
        const text = items[keys[i]];
        if (!text || this.segDecos.get(list[i])) continue;
        let o = null;
        try { o = JSON.parse(text); } catch (e) { continue; }
        const d = decoDecode(o, tv);
        if (d) this.segDecos.set(list[i], d);
      }
    }, function () { });
  };
  Renderer.prototype.segDeco = function (cs) {
    const city = this.game.city, tv = (city.uid || 0) * 4096 + (city.terrainVer || 0);
    let d = this.segDecos.get(cs);
    if (d && d.tv === tv) return d;
    const pts = cs.g.pts, cum = cs.g.cum, hs = cs.h, n = pts.length;
    const wet = new Uint8Array(n);
    for (let i = 0; i < n; i++) wet[i] = city.waterDistAt(pts[i][0], pts[i][1]) < 0 ? 1 : 0;
    const elevH = CFG.metro.height.elevated;
    // 桥墩：高出地面的部分约每 50 m 一座，水中约每 100 m
    const piers = []; let next = -1, raised = false;
    for (let i = 0; i < n; i++) if (hs[i] > DECO_FLAT * 3) { raised = true; if (cum[i] >= next) { piers.push(i); next = cum[i] + (wet[i] ? 0.4 : 0.2); } }
    // 与运营中铁路的交叉：取铁路在交叉点的走向
    const rails = [];
    for (const kind of ['railSurf', 'railVia']) for (const p of cs.g[kind] || []) {
      const f = CM.Geo.rail[p[2]]; let ang = 0, best = Infinity;
      if (f && f.p) for (let q = 0; q + 3 < f.p.length; q += 2) { const dd = U.distToSeg(p[0], p[1], f.p[q], f.p[q + 1], f.p[q + 2], f.p[q + 3]); if (dd < best) { best = dd; ang = Math.atan2(f.p[q + 3] - f.p[q + 1], f.p[q + 2] - f.p[q]); } }
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const dx = pts[i][0] - p[0], dy = pts[i][1] - p[1], dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; bi = i; } }
      rails.push({ i: bi, x: p[0], y: p[1], ang: ang, via: kind === 'railVia' });
    }
    d = {
      tv: tv, wet: wet, piers: piers, raised: raised, rails: rails,
      water: decoRuns(n, function (i) { return wet[i] === 1; }),
      buried: decoRuns(n, function (i) { return hs[i] < DECO_BURIED; }),
      ground: decoRuns(n, function (i) { return Math.abs(hs[i]) <= DECO_FLAT; }),
      high: decoRuns(n, function (i) { return hs[i] > DECO_FLAT; }),
      ramp: decoRuns(n, function (i) { return hs[i] > DECO_FLAT && hs[i] < elevH - DECO_FLAT; }),
    };
    this.segDecos.set(cs, d);
    if (CM.Cache) CM.Cache.put(this.segDecoKey(cs), decoEncode(d));
    return d;
  };
  function strokeRange(ctx, arr, r) {
    ctx.beginPath(); ctx.moveTo(arr[r[0] * 2], arr[r[0] * 2 + 1]);
    for (let i = r[0] + 1; i <= r[1]; i++) ctx.lineTo(arr[i * 2], arr[i * 2 + 1]);
    ctx.stroke();
  }
  // 屏幕折线的平行线（像素偏移，正值在前进方向左侧）：栏杆、挡墙
  function strokeOffset(ctx, arr, r, off) {
    const n = arr.length / 2;
    ctx.beginPath();
    for (let i = r[0]; i <= r[1]; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = arr[b * 2] - arr[a * 2], dy = arr[b * 2 + 1] - arr[a * 2 + 1], l = Math.hypot(dx, dy) || 1;
      const x = arr[i * 2] + dy / l * off, y = arr[i * 2 + 1] - dx / l * off;
      if (i === r[0]) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  function arrAngle(arr, i) {
    const n = arr.length / 2, a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    return Math.atan2(arr[b * 2 + 1] - arr[a * 2 + 1], arr[b * 2] - arr[a * 2]);
  }
  // batched：隧道外廓与越江隧道已在 drawMetroStatic 中合并描边
  Renderer.prototype.drawTrack = function (ctx, cs, arr, col, alpha, width, under, t, batched) {
    const s = cs.seg, z = this.z;
    if (z < 12 || under >= 0.5) {
      // 远景与地下视图：原有画法（衬边 + 线路色 + 地面虚线 / 地下点线）
      if (s.type === 'elevated' && t > 0.05) this.drawRaisedBase(ctx, cs, arr, alpha, width, t, null);
      ctx.globalAlpha = alpha;
      if (s.type !== 'underground' || under > 0.5) { ctx.strokeStyle = s.type === 'elevated' ? S.TH.elevCase : S.TH.lineCase; ctx.lineWidth = width + 2.5; this.strokeArr(ctx, arr); }
      ctx.strokeStyle = col; ctx.lineWidth = width; this.strokeArr(ctx, arr);
      if (s.type === 'surface') { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1, width * 0.22); ctx.setLineDash([width, width]); this.strokeArr(ctx, arr); ctx.setLineDash([]); }
      if (s.type === 'underground' && under < 0.5 && !this.game.preview) { ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = Math.max(1, width * 0.18); ctx.setLineDash([2, width * 1.6]); this.strokeArr(ctx, arr); ctx.setLineDash([]); }
      ctx.globalAlpha = 1;
      return;
    }
    // 近景细节（枕木、栏杆、挡墙）只在缩放 ≥ 24 且自动细节未降档时绘制；负载升高时与其他中远景细节一起省略
    const d = this.segDeco(cs), K = S.TH.trk, hs = cs.h, near = z >= 24 && this.detail.tier < 2;
    const fade = 1 - 2 * under;
    // 高出地面部分：2.5D 投影阴影与桥墩，2D 向右下偏移的阴影（偏移量随轨面高度变化，引桥逐渐抬升）
    if (d.raised) this.drawRaisedBase(ctx, cs, arr, alpha, width, t, d);
    // 越水：桥面（地面 / 高架）或越江隧道（地下）
    for (const r of d.water) {
      const mid = (r[0] + r[1]) >> 1;
      if (hs[mid] < -DECO_FLAT) { if (!batched) { ctx.globalAlpha = alpha * fade; ctx.strokeStyle = K.tunnelWater; ctx.lineWidth = width + 4.5; strokeRange(ctx, arr, r); } }
      else { ctx.globalAlpha = alpha; ctx.strokeStyle = K.deck; ctx.lineWidth = width + 6; strokeRange(ctx, arr, r); }
    }
    ctx.lineCap = 'butt';
    // 地面：道床与枕木
    if (d.ground.length) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = K.ballast; ctx.lineWidth = width + 3.5;
      for (const r of d.ground) strokeRange(ctx, arr, r);
      if (near) { ctx.strokeStyle = K.sleeper; ctx.setLineDash([1.3, Math.max(2.4, width * 0.55)]); for (const r of d.ground) strokeRange(ctx, arr, r); ctx.setLineDash([]); }
    }
    // 高出地面：留出与下方线路交叉的间隙，再画桥面衬边
    if (d.high.length) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = S.TH.lineCase; ctx.lineWidth = width + 5;
      for (const r of d.high) strokeRange(ctx, arr, r);
      ctx.strokeStyle = S.TH.elevCase; ctx.lineWidth = width + 2.5;
      for (const r of d.high) strokeRange(ctx, arr, r);
    }
    ctx.lineCap = 'round';
    // 线路本色：地下段略透明
    ctx.strokeStyle = col; ctx.lineWidth = width;
    if (d.buried.length === 1 && d.buried[0][0] === 0 && d.buried[0][1] === arr.length / 2 - 1) { ctx.globalAlpha = alpha * U.lerp(0.82, 1, under); this.strokeArr(ctx, arr); }
    else {
      ctx.globalAlpha = alpha; this.strokeArr(ctx, arr);
      if (d.buried.length) { ctx.globalAlpha = alpha * 0.25 * fade; ctx.strokeStyle = S.TH.lineCase; ctx.lineWidth = width * 0.5; for (const r of d.buried) strokeRange(ctx, arr, r); }
    }
    ctx.globalAlpha = alpha;
    // 中线标记：地面段白色短线，地下段白色点线
    if (s.type === 'surface') { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1, width * 0.22); ctx.setLineDash([width, width]); for (const r of d.ground) strokeRange(ctx, arr, r); ctx.setLineDash([]); }
    if (d.buried.length && !this.game.preview) { ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = Math.max(1, width * 0.18); ctx.setLineDash([2, width * 1.6]); for (const r of d.buried) strokeRange(ctx, arr, r); ctx.setLineDash([]); }
    if (near) {
      // 桥面栏杆（高架与越水桥梁）与引桥挡墙
      ctx.strokeStyle = K.parapet; ctx.lineWidth = 1;
      for (const r of d.high) { strokeOffset(ctx, arr, r, width / 2 + 1.25); strokeOffset(ctx, arr, r, -width / 2 - 1.25); }
      for (const r of d.water) { const mid = (r[0] + r[1]) >> 1; if (hs[mid] >= -DECO_FLAT && hs[mid] <= DECO_FLAT) { strokeOffset(ctx, arr, r, width / 2 + 2.6); strokeOffset(ctx, arr, r, -width / 2 - 2.6); } }
      if (d.ramp.length) { ctx.strokeStyle = K.wall; ctx.lineWidth = 1.2; ctx.setLineDash([2, 1.5]); for (const r of d.ramp) { strokeOffset(ctx, arr, r, width / 2 + 2.6); strokeOffset(ctx, arr, r, -width / 2 - 2.6); } ctx.setLineDash([]); }
    }
    // 与铁路交叉：地下线——铁路从隧道上方经过；高架 / 地面线——跨越铁路的桥台
    if (z >= 16) for (const rc of d.rails) {
      const p = this.P(rc.x, rc.y, 0), q = {};
      if (p.x < -30 || p.y < -30 || p.x > this.w + 30 || p.y > this.h + 30) continue;
      const len = width * 2.4 + 3, c = Math.cos(rc.ang), sn = Math.sin(rc.ang);
      this.P(rc.x + c * 0.1, rc.y + sn * 0.1, 0, q);
      const ra = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.save(); ctx.globalAlpha = alpha;
      if (hs[rc.i] < -DECO_FLAT) {
        ctx.translate(p.x, p.y); ctx.rotate(ra); ctx.lineCap = 'butt';
        ctx.strokeStyle = S.TH.road.railCase; ctx.lineWidth = 3.4; ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
        ctx.strokeStyle = S.TH.road.rail; ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
      } else {
        const ta = arrAngle(arr, rc.i), off = width / 2 + 3;
        ctx.translate(arr[rc.i * 2], arr[rc.i * 2 + 1]); ctx.rotate(ta);
        ctx.strokeStyle = K.wall; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath();
        for (const sx of [-1, 1]) { ctx.moveTo(sx * (width + 4), -off); ctx.lineTo(sx * (width + 4), off); }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };
  // 高出地面部分的阴影与桥墩：2.5D 阴影落在地面、桥墩连到桥面；2D 阴影向右下偏移；水中桥墩画出水纹
  Renderer.prototype.drawRaisedBase = function (ctx, cs, arr, alpha, width, t, d) {
    const pts = cs.g.pts, hs = cs.h, n = pts.length, tmp = {};
    const K = S.TH.trk;
    if (t > 0.05) {
      if (this.shadows) {
        ctx.globalAlpha = (S.TH.night ? 0.4 : 0.18) * alpha * t; ctx.strokeStyle = S.TH.night ? '#000' : '#3a3a3a'; ctx.lineWidth = width;
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) { if (hs[i] <= DECO_FLAT) { pen = false; continue; } const p = this.P(pts[i][0], pts[i][1], 0, tmp); if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); pen = true; }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.55 * alpha * t; ctx.strokeStyle = S.TH.pier; ctx.lineWidth = Math.max(1, width * 0.35);
      ctx.beginPath();
      if (d) for (const i of d.piers) { const p = this.P(pts[i][0], pts[i][1], 0, tmp); ctx.moveTo(p.x, p.y); ctx.lineTo(arr[i * 2], arr[i * 2 + 1]); }
      else { const step = 4; for (let i = step; i < n - 1; i += step) { const p = this.P(pts[i][0], pts[i][1], 0, tmp); ctx.moveTo(p.x, p.y); ctx.lineTo(arr[i * 2], arr[i * 2 + 1]); } }
      ctx.stroke();
    }
    if (!d) return;
    if (t < 0.95 && this.shadows) {
      const k = (1 - t) * this.z * 2.0;
      ctx.globalAlpha = (S.TH.night ? 0.35 : 0.16) * alpha * (1 - t); ctx.strokeStyle = K.shadow; ctx.lineWidth = width + 1;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) { if (hs[i] <= DECO_FLAT) { pen = false; continue; } const hh = hs[i] * k; if (pen) ctx.lineTo(arr[i * 2] + hh * 0.55, arr[i * 2 + 1] + hh); else ctx.moveTo(arr[i * 2] + hh * 0.55, arr[i * 2 + 1] + hh); pen = true; }
      ctx.stroke();
    }
    if (this.z >= 20) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = K.pierFoot; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const i of d.piers) { if (!d.wet[i]) continue; const p = this.P(pts[i][0], pts[i][1], 0, tmp); ctx.moveTo(p.x + width * 0.9 + 1, p.y); ctx.ellipse(p.x, p.y, width * 0.9 + 1, (width * 0.9 + 1) * (1 - 0.5 * t), 0, 0, Math.PI * 2); }
      ctx.stroke();
    }
  };
  // 车站逐座绘制
  function drawStations(ctx, C, v, under, stH, xfer, hlLine, lyrDim, planOv, draft) {
    const g = this.game;
    this.stPx = [];
    const R0 = U.clamp(this.z * 0.11, 3.2, 9);
    const mult = { S: 0.8, M: 1, L: 1.3 };
    for (let i = 0; i < C.stations.length; i++) {
      const s = C.stations[i];
      if (s.x < v.x0 - 1 || s.x > v.x1 + 1 || s.y < v.y0 - 1 || s.y > v.y1 + 1) { this.stPx.push(null); continue; }
      const h = stH(s);
      const p = this.P(s.x, s.y, h);
      const lines = C.stationLines[i];
      const inter = lines.size > 1 || xfer.has(i);
      const r = R0 * mult[s.size] * (inter ? 1.4 : 1);
      this.stPx.push({ x: p.x, y: p.y, cx: p.x, cy: p.y, r: r, id: s.id });
      const serviced = C.serviced[i];
      let alpha = 1;
      if (hlLine && !lines.has(hlLine)) alpha = 0.35;
      const inPlanS = planOv ? !!planOv.stations[s.id] : null;
      if (planOv && !inPlanS) alpha *= 0.42;
      alpha *= lyrDim;
      ctx.globalAlpha = alpha;
      if (s.type === 'underground' && under > 0.05) {
        const gp = this.P(s.x, s.y, 0);
        ctx.strokeStyle = 'rgba(90,100,120,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(gp.x, gp.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      if (s.type === 'elevated' && this.tEase > 0.05) {
        const gp = this.P(s.x, s.y, 0);
        ctx.strokeStyle = 'rgba(120,124,130,0.7)'; ctx.lineWidth = Math.max(2, r * 0.6); ctx.beginPath(); ctx.moveTo(gp.x, gp.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = S.TH.stFill; ctx.fill();
      if (!serviced) { ctx.setLineDash([3, 2]); ctx.strokeStyle = '#8a8f98'; }
      else if (inter) ctx.strokeStyle = S.TH.stInter;
      else { const lid = lines.values().next().value; ctx.strokeStyle = C.net.lines[lid] ? C.net.lines[lid].color : '#444'; }
      const ow = inter ? Math.max(2.2, r * 0.3) : Math.max(1.8, r * 0.36);
      ctx.lineWidth = ow;
      ctx.stroke(); ctx.setLineDash([]);
      // 换乘标志：深色外环 + 各线路颜色分段内环 + 换乘箭头
      if (inter && serviced) {
        const ls = Array.from(lines), n = ls.length;
        if (n >= 1) {
          const rr = r - ow * 0.5 - Math.max(1.1, r * 0.13), gap = n > 1 ? 0.22 : 0;
          ctx.lineWidth = Math.max(1.5, r * 0.2); ctx.lineCap = 'butt';
          for (let k = 0; k < n; k++) {
            const L = C.net.lines[ls[k]]; if (!L) continue;
            const a0 = -Math.PI / 2 + k * Math.PI * 2 / n + gap / 2, a1 = -Math.PI / 2 + (k + 1) * Math.PI * 2 / n - gap / 2;
            ctx.strokeStyle = L.color; ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0, a1); ctx.stroke();
          }
          ctx.lineCap = 'round';
        }
        if (r >= 6.5) xferGlyph(ctx, p.x, p.y, r * 0.36, S.TH.stInter);
      }
      if (draft && !g.net.stations[s.id]) {
        ctx.strokeStyle = 'rgba(30,136,229,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.lineDashOffset = -this.time * 10;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      if (inPlanS) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
        ctx.globalAlpha = 0.6 + 0.4 * pulse;
        ctx.strokeStyle = S.TH.stInter; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 3.5 + pulse * 1.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = alpha;
      }
      ctx.globalAlpha = 1;
    }
  }
  // 站外换乘：两座不同线路的运营车站之间可步行换乘。车站本身是多线交汇时没有连线，
  // 只需要知道哪些站要按换乘站画标志
  function xferInfo(g, C) {
    const cache = g._xferCache;
    if (cache && cache.net === C.net && cache.version === C.version) return cache.info;
    const set = new Set(), links = [];
    const mnet = g.model && g.model.net;
    if (mnet && mnet.acc) {
      const MC = mnet.C;
      for (const tr of mnet.acc.transfers) {
        if (tr.a > tr.b) continue;
        const ia = C.sIndex.get(MC.stations[tr.a].id), ib = C.sIndex.get(MC.stations[tr.b].id);
        if (ia === undefined || ib === undefined) continue;
        const la = C.stationLines[ia], lb = C.stationLines[ib];
        if (!la.size || !lb.size) continue;
        let share = false; la.forEach(function (l) { if (lb.has(l)) share = true; });
        if (share) continue;
        set.add(ia); set.add(ib); links.push([ia, ib]);
      }
    }
    const info = { set: set, links: links };
    g._xferCache = { net: C.net, version: C.version, info: info };
    return info;
  }
  // 换乘箭头（⇄）：上箭头向右、下箭头向左
  function xferGlyph(ctx, x, y, s, col) {
    const a = s * 0.42, hd = s * 0.5;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, s * 0.3); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s, y - a); ctx.lineTo(x + s, y - a); ctx.lineTo(x + s - hd, y - a - hd);
    ctx.moveTo(x + s, y + a); ctx.lineTo(x - s, y + a); ctx.lineTo(x - s + hd, y + a + hd);
    ctx.stroke();
  }
  Renderer.prototype.strokeArr = function (ctx, arr) {
    ctx.beginPath();
    ctx.moveTo(arr[0], arr[1]);
    for (let i = 2; i < arr.length; i += 2) ctx.lineTo(arr[i], arr[i + 1]);
    ctx.stroke();
  };
  // 叠层画布复位：文字层和地铁层共用这一张，上一帧留下的变换与半透明状态必须先清掉
  Renderer.prototype.labelCtx = function () {
    const x = this.lctx, d = this.ldpr || 1;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
    x.imageSmoothingEnabled = true;
    x.clearRect(0, 0, this.lcv.width, this.lcv.height);
    x.setTransform(d, 0, 0, d, 0, 0);
    return x;
  };
})(window.CM);
