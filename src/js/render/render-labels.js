'use strict';
// 标注层：叠层格点切换、站名 / 地标 / 道路 / 区名 / 未开放区域的文字绘制，以及屏幕与世界的拾取
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA;
  const Renderer = CM.Renderer, S = CM.RH.S, makeCanvas = CM.RH.makeCanvas;
  const FONT = CM.RH.FONT, EX = CM.RH_ISO.EX;

  // 叠层位图统一用满分辨率的格点参数：地铁层、标注层跟文字层一样不跟内部渲染分辨率降档，
  // 全屏自动降分辨率时线和字仍然是设备像素级清晰。位图尺寸按 lpx 算，贴回时再缩放到屏幕，
  // 每帧的填充率不变（合成量只跟屏幕像素数有关），多的只是位图内存
  Renderer.prototype.pxLayer = function () {
    return { px: this.lpx, py: this.lpy, dpr: this.ldpr || 1, ss: this._ssFrame };
  };
  // segScreen 的屏幕坐标缓存键不含 dpr，叠层与主画布混用时必须换一个键，否则会拿到另一套格点的残影
  Renderer.prototype.setSpace = function (s) {
    this.px = s.px; this.py = s.py; this.dpr = s.dpr;
    this._ssFrame = -1;
  };
  Renderer.prototype.useLabelSpace = function () {
    const s = this._lsp || (this._lsp = {});
    s.px = this.px; s.py = this.py; s.dpr = this.dpr; s.stPx = this.stPx; s.ss = this._ssFrame;
    const d = this.ldpr || 1;
    this.dpr = d;
    this.px = Math.round(this.ox * d) / d; this.py = Math.round(this.oy * d) / d;
    const ax = Math.round((s.px - this.px) * d) / d, ay = Math.round((s.py - this.py) * d) / d;
    if (s.stPx && (ax || ay)) {
      const arr = new Array(s.stPx.length);
      for (let i = 0; i < s.stPx.length; i++) { const q = s.stPx[i]; arr[i] = q ? { x: q.x + ax, y: q.y + ay, r: q.r, id: q.id, cx: q.cx == null ? q.cx : q.cx + ax, cy: q.cy == null ? q.cy : q.cy + ay } : null; }
      this.stPx = arr;
    }
    this._ssFrame = -1;
    return s;
  };
  // 还原成主画布的格点：偏移取切过去之前记下的那一份，不能拿 ox 现算（中间可能改过）
  Renderer.prototype.restoreSpace = function (s) {
    if (!s) return;
    this.px = s.px; this.py = s.py; this.dpr = s.dpr; this.stPx = s.stPx;
    if (s.ss !== undefined) this._ssFrame = s.ss;
  };
  // 标注层：内容画进独立位图缓存，没变就整帧不重描，再把位图贴回叠层画布
  Renderer.prototype.drawLabels = function (ui, dest) {
    const ctx = dest || this.lctx;
    if (!ctx) return;
    const g = this.game;
    // 开始界面不显示标注；顺手把上一局留下的位图清掉
    if (g.preview) { this.labelImage = null; this.labA = 0; this.mapLabA = 0; return; }
    const step = (this.dt || 0.016) / 0.25;
    const labA = U.clamp((this.labA == null ? (this.labelsOn ? 1 : 0) : this.labA) + (this.labelsOn ? step : -step), 0, 1);
    const mapLabA = U.clamp((this.mapLabA == null ? (this.mapLabelsOn !== false ? 1 : 0) : this.mapLabA) + (this.mapLabelsOn !== false ? step : -step), 0, 1);
    this.labA = labA; this.mapLabA = mapLabA;
    if (labA <= 0.001 && mapLabA <= 0.001) { this.labelImage = null; return; }
    const key = [this.w, this.h, this.ldpr, this.z, this.lpx, this.lpy, this.hs, this.M.join(','), this.cam.under, this.tEase > 0.5, this.bFade > 0.5, this.game.city.version, this.game.netVersion, this.layer, Math.round(labA * 255), Math.round(mapLabA * 255), this.themeName, document.fonts ? document.fonts.status : ''].join('|');
    const d = this.ldpr || 1;
    let image = this.labelImage;
    if (!image || image.key !== key || image.C !== this.drawnC) {
      const cw = Math.round(this.w * d), ch = Math.round(this.h * d);
      const cv = image && image.cv.width === cw && image.cv.height === ch ? image.cv : makeCanvas(cw, ch);
      const x = cv.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
      x.clearRect(0, 0, cw, ch);
      x.setTransform(d, 0, 0, d, 0, 0);
      const sp = this.useLabelSpace();
      try { this.drawLabelContent(x, ui); } finally { this.restoreSpace(sp); }
      image = this.labelImage = { key: key, C: this.drawnC, cv: cv };
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image.cv, 0, 0, image.cv.width, image.cv.height, 0, 0, Math.round(this.w * d), Math.round(this.h * d));
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  Renderer.prototype.drawLabelContent = function (ctx, ui) {
    const g = this.game, z = this.z, city = g.city;
    if (g.preview) return;   // 开始界面背景不显示标注
    // 标注开关渐隐渐现（不闪切）。状态在 drawLabels 里已逐帧推进过，这里直接用本帧终值，
    // 再推进一次会让渐隐永远停在中间值，标注一直半透明甚至看不见
    const dpr = this.ldpr || 1;
    // 视野按叠层位图画幅算：文字层与地铁层同格点，视野也必须同一套，否则边缘标注少了或错位
    const v = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const s of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]]) {
      const p = this.unproject(s[0], s[1]);
      if (p.x < v.x0) v.x0 = p.x; if (p.x > v.x1) v.x1 = p.x;
      if (p.y < v.y0) v.y0 = p.y; if (p.y > v.y1) v.y1 = p.y;
    }
    const placed = new Map(), tile = 48;
    // 文字锚点对齐到设备像素：相机位移是连续的，文字落在亚像素位置时每帧的字形光栅化结果都不一样，
    // 屏幕上看起来就是抖动闪烁。取整到整格后字形稳定，代价是最多偏半个设备像素
    const snap = function (v) { return Math.round(v * dpr) / dpr; };
    const fits = function (x0, y0, x1, y1) {
      // 避让判定也按对齐后的位置算：否则亚像素位移会让两个标注的相交关系逐帧翻转，低优先级的那个一直闪
      x0 = snap(x0); y0 = snap(y0); x1 = snap(x1); y1 = snap(y1);
      const i0 = Math.floor(x0 / tile), i1 = Math.floor(x1 / tile), j0 = Math.floor(y0 / tile), j1 = Math.floor(y1 / tile);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const list = placed.get(i + ':' + j);
        if (list) for (const r of list) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false;
      }
      const rect = [x0, y0, x1, y1];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const key = i + ':' + j; let list = placed.get(key); if (!list) { list = []; placed.set(key, list); } list.push(rect); }
      return true;
    };
    const halo = function (text, x, y, font, fill, align) {
      const px = snap(x), py = snap(y);
      ctx.font = font; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.2; ctx.strokeStyle = S.TH.halo; ctx.lineJoin = 'round';
      ctx.strokeText(text, px, py); ctx.fillStyle = fill; ctx.fillText(text, px, py);
    };
    // 文字层内容不变就整帧不动，字口不会再随底下街景闪，不需要再垫底板，只靠描边压住背景
    // 车站名。换乘站优先：两行以上（大小站除外）的先排，挤不下时先舍弃小站
    const C = this.drawnC;
    const busyLayer = this.layer === 'cong' || this.layer === 'flow' || this.layer === 'station' || this.layer === 'fac' || this.layer === 'gap';   // 这些图层自带标注，隐藏站名、区名与未开放区域
    // 站名跟着站网（drawnC）走，位置取地铁层算出来的屏幕坐标（与圆点同一套格点）
    if (C && C.stations && this.stPx && z >= 8.5 && this.labA > 0.01 && !busyLayer) {
      const pick = [];
      for (let i = 0; i < C.stations.length; i++) {
        const p = this.stPx[i];
        if (!p) continue;
        const sl = C.stationLines[i];
        pick.push([p, i, sl ? sl.size : 1, { L: 2, M: 1, S: 0 }[C.stations[i].size] || 0]);
      }
      pick.sort(function (a, b) { return (b[2] - a[2]) || (b[3] - a[3]); });
      ctx.globalAlpha = this.labA;
      // 字号取整：0.25 像素的台阶会让排版宽度在缩放中反复变化，邻近标注跟着闪
      const fs = Math.round(11.5 + U.clamp((z - 20) / 4, 0, 1));
      for (const it of pick) {
        const p = it[0], s = C.stations[it[1]];
        const font = (it[2] > 1 ? '600 ' : '') + fs + 'px ' + FONT;
        ctx.font = font;
        const w = this.textWidth(ctx, s.name);
        const x = p.x + p.r + 4, y = p.y;
        if (!fits(x - 2, y - fs / 2 - 2, x + w + 5, y + fs / 2 + 2)) continue;
        halo(s.name, x, y, font, S.TH.ink);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = this.mapLabA;
    // 地标
    if (z >= 13 && this.mapLabA > 0.01 && this.layer === 'none') {
      for (let k = 0; k < D.landmarks.length; k++) {
        if (!city.landmarkOn[k]) continue;
        const lm = D.landmarks[k];
        if (lm.x < v.x0 || lm.x > v.x1 || lm.y < v.y0 || lm.y > v.y1) continue;
        const h = this.tEase > 0.5 && this.bFade > 0.5 ? (lm.h ? lm.h * EX : 34 * EX * 1.6) : 0;
        const p = this.P(lm.x, lm.y, h);
        ctx.font = '11px ' + FONT;
        const text = '◆ ' + lm.name;
        const w = this.textWidth(ctx, text);
        if (!fits(p.x - w / 2, p.y - 18, p.x + w / 2, p.y - 6)) continue;
        halo(text, p.x, p.y - 12, '11px ' + FONT, S.TH.landmarkInk, 'center');
      }
    }
    // 道路名
    if (z >= 22 && this.layer === 'none' && this.mapLabA > 0.01) {
      ctx.font = '10.5px ' + FONT;
      const seen = new Set();
      for (const k of CM.Geo.query(city.roadWayBk, v.x0, v.y0, v.x1, v.y1)) {
        const w = city.roadWays[k], gr = city.roadGroups[w.g];
        if (gr.cls < 3 || !gr.name || (gr.flags & 6) || !city.roadsBuilt[w.g] || seen.has(gr.name)) continue;
        const p = w.p;
        let geom = this.roadLabelGeom.get(w);
        if (!geom) {
          let len = 0;
          for (let q = 2; q < p.length; q += 2) len += Math.hypot(p[q] - p[q - 2], p[q + 1] - p[q - 1]);
          let acc = 0, mx = p[0], my = p[1];
          for (let q = 2; q < p.length; q += 2) { const d = Math.hypot(p[q] - p[q - 2], p[q + 1] - p[q - 1]); if (acc + d >= len / 2) { const t = (len / 2 - acc) / (d || 1); mx = p[q - 2] + (p[q] - p[q - 2]) * t; my = p[q - 1] + (p[q + 1] - p[q - 1]) * t; break; } acc += d; }
          geom = { len: len, x: mx, y: my }; this.roadLabelGeom.set(w, geom);
        }
        const len = geom.len;
        if (len < 2.4) continue;
        const pt = this.P(geom.x, geom.y, 0);
        if (pt.x < -6 || pt.y < -6 || pt.x > this.w + 6 || pt.y > this.h + 6) continue;
        const text = gr.name;
        const tw = this.textWidth(ctx, text);
        if (!fits(pt.x - tw / 2, pt.y - 7, pt.x + tw / 2, pt.y + 7)) continue;
        seen.add(gr.name);
        halo(text, pt.x, pt.y, '10.5px ' + FONT, S.TH.roadInk, 'center');
      }
    }
    // 区名
    if (z < 16 && this.mapLabA > 0.01 && this.layer !== 'flow') {
      const a = U.clamp((16 - z) / 5, 0, 1) * 0.75;
      const dfs = Math.round(15 + 2 * U.clamp((z - 7) / 4, 0, 1));
      for (const dl of (city.districtLabels || [])) {
        const p = this.P(dl[1], dl[2], 0);
        const label = dl[0], font = '600 ' + dfs + 'px ' + FONT;
        ctx.globalAlpha = a * this.mapLabA;
        halo(label, p.x, p.y, font, S.TH.district, 'center');
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
    // 未开放区域标签
    if (z < 24 && !busyLayer) {
      const shown = new Set();
      for (let k = 0; k < city.regions.length; k++) {
        const rg = city.regions[k];
        if (city.regionOpen[k] || rg.scenic || rg.cx == null || !rg.cells || shown.has(k)) continue;
        const cx = rg.cx, cy = rg.cy;
        if (cx < v.x0 || cx > v.x1 || cy < v.y0 || cy > v.y1) continue;
        const p = this.P(cx, cy, 0);
        const text = '🔒 ' + rg.name.replace(/（.*）/, '') + ' · ' + U.regionLock(rg);
        ctx.font = '11px ' + FONT;
        const w = this.textWidth(ctx, text);
        if (!fits(p.x - w / 2, p.y - 8, p.x + w / 2, p.y + 8)) continue;
        halo(text, p.x, p.y, '11px ' + FONT, S.TH.lockInk, 'center');
        shown.add(k);
      }
    }
  };

  // ---------------- 拾取 ----------------
  Renderer.prototype.pickStation = function (sx, sy) {
    if (!this.stPx) return null;
    let best = null, bd = 1e9;
    for (const p of this.stPx) {
      if (!p) continue;
      const d = Math.hypot(p.cx - sx, p.cy - sy);
      if (d < p.r + 7 && d < bd) { bd = d; best = p.id; }
    }
    return best;
  };
  Renderer.prototype.pickSegment = function (sx, sy, tol) {
    if (!this.segPx) return null;
    tol = tol || 7;
    let best = null, bd = tol;
    this.segPx.forEach(function (arr, id) {
      for (let i = 0; i + 3 < arr.length; i += 2) {
        const d = U.distToSeg(sx, sy, arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
        if (d < bd) { bd = d; best = id; }
      }
    });
    return best;
  };
  Renderer.prototype.buildLinkGrid = function () {
    const city = this.game.city;
    if (this.linkGridVer === city.roadVersion) return;
    const G = new Map();
    for (const L of city.car.links) {
      const b = L.bbox;
      for (let j = Math.floor(b[1] / 4); j <= Math.floor(b[3] / 4); j++) for (let i = Math.floor(b[0] / 4); i <= Math.floor(b[2] / 4); i++) {
        const k = i + ':' + j; if (!G.has(k)) G.set(k, []); G.get(k).push(L);
      }
    }
    this.linkGrid = G; this.linkGridVer = city.roadVersion;
  };
  Renderer.prototype.pickLink = function (wx, wy, tol) {
    this.buildLinkGrid();
    const arr = this.linkGrid.get(Math.floor(wx / 4) + ':' + Math.floor(wy / 4));
    if (!arr) return null;
    let best = null, bd = tol || 0.25;
    for (const L of arr) { const d = U.distToPoly(wx, wy, L.pts); if (d < bd) { bd = d; best = L; } }
    return best;
  };
  Renderer.prototype.fitAll = function () {
    const zx = this.w / (CFG.W + 4), zy = this.h / (CFG.H + 4);
    this.cam.tz = this.cam.zoom = U.clamp(Math.min(zx, zy) * 1.05, 5, 96);
    this.cam.cx = CFG.W / 2; this.cam.cy = CFG.H / 2;
  };
})(window.CM);
