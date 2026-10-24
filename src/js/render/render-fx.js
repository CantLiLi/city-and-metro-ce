'use strict';
// 反馈特效：建站涟漪、建成绽放、拆除烟尘、轨道描绘、区域开放
(function (CM) {
  const U = CM.U;
  const Renderer = CM.Renderer, S = CM.RH.S;
  const FONT = CM.RH.FONT;

  const FX_DUR = { ripple: 0.9, burst: 1.5, dust: 1.1, trace: 1.3, region: 2.6 };
  Renderer.prototype.addFx = function (kind, x, y, o) {
    if (this.game && this.game.preview) return;
    o = o || {};
    this.fx.push({ kind: kind, x: x, y: y, o: o, t: -(o.delay || 0), dur: o.dur || FX_DUR[kind] || 1, seed: Math.random() * 1000 });
    if (this.fx.length > 160) this.fx.shift();
  };
  Renderer.prototype.fxRing = function (ctx, x, y, rw) {
    const tmp = {};
    ctx.beginPath();
    for (let a = 0; a <= 24; a++) { const t = a / 24 * Math.PI * 2; this.P(x + Math.cos(t) * rw, y + Math.sin(t) * rw, 0, tmp); if (a) ctx.lineTo(tmp.x, tmp.y); else ctx.moveTo(tmp.x, tmp.y); }
  };
  Renderer.prototype.drawFx = function (ctx, dt) {
    if (!this.fx.length) return;
    const z = this.z, tmp = {};
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      if (f.t >= f.dur) { this.fx.splice(i, 1); continue; }
      if (f.t < 0) continue;
      const k = f.t / f.dur, e = 1 - Math.pow(1 - k, 3);
      const col = f.o.color || '#2f6fb6';
      switch (f.kind) {
        case 'ripple': {
          for (let r = 0; r < 2; r++) {
            const kk = U.clamp(k * 1.3 - r * 0.3, 0, 1); if (kk <= 0 || kk >= 1) continue;
            ctx.globalAlpha = (1 - kk) * 0.85; ctx.strokeStyle = col; ctx.lineWidth = 3.2 * (1 - kk) + 0.8;
            this.fxRing(ctx, f.x, f.y, (6 + (1 - Math.pow(1 - kk, 3)) * 34) / z); ctx.stroke();
          }
          break;
        }
        case 'burst': {
          const p = this.P(f.x, f.y, 0, tmp), px = p.x, py = p.y;
          ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = col; ctx.lineWidth = 3 * (1 - k) + 1;
          this.fxRing(ctx, f.x, f.y, (8 + e * 46) / z); ctx.stroke();
          ctx.globalAlpha = (1 - k) * 0.35; ctx.fillStyle = col; this.fxRing(ctx, f.x, f.y, (6 + e * 18) / z); ctx.fill();
          // 光柱与粒子
          if (k < 0.6) { const a = 1 - k / 0.6; const g = ctx.createLinearGradient(px, py, px, py - 70); g.addColorStop(0, 'rgba(255,255,255,' + (0.75 * a) + ')'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(px - 3, py - 70 * e, 6, 70 * e); }
          for (let q = 0; q < 12; q++) {
            const ang = (q / 12) * Math.PI * 2 + f.seed, d = 10 + e * (28 + 14 * Math.sin(f.seed + q * 3));
            const x = px + Math.cos(ang) * d, y = py + Math.sin(ang) * d * 0.7 - e * 22 + k * k * 30;
            ctx.globalAlpha = (1 - k); ctx.fillStyle = q % 3 === 0 ? '#ffffff' : col;
            ctx.beginPath(); ctx.arc(x, y, 2.6 * (1 - k) + 0.8, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'dust': {
          const p = this.P(f.x, f.y, 0, tmp), sc = f.o.small ? 0.6 : 1;
          for (let q = 0; q < 7; q++) {
            const ang = (q / 7) * Math.PI * 2 + f.seed, d = e * 22 * sc;
            ctx.globalAlpha = (1 - k) * 0.5; ctx.fillStyle = this.th.night ? '#8b93a1' : '#a89f92';
            ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d * 0.6 - e * 14 * sc, (5 + e * 9) * sc, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'trace': {
          const pts = f.o.pts; if (!pts || pts.length < 2) break;
          const n = Math.max(2, Math.ceil(pts.length * Math.min(1, e * 1.4)));
          ctx.beginPath();
          for (let q = 0; q < n; q++) { this.P(pts[q][0], pts[q][1], 0, tmp); if (q) ctx.lineTo(tmp.x, tmp.y); else ctx.moveTo(tmp.x, tmp.y); }
          const fade = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1;
          ctx.globalAlpha = 0.55 * fade; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = this.lineWidthPx() + 9; ctx.stroke();
          ctx.globalAlpha = 0.9 * fade; ctx.strokeStyle = col; ctx.lineWidth = this.lineWidthPx() + 3; ctx.stroke();
          const hd = pts[n - 1]; this.P(hd[0], hd[1], 0, tmp);
          ctx.globalAlpha = fade; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(tmp.x, tmp.y, 5, 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'region': {
          const p = this.P(f.x, f.y, 0, tmp);
          ctx.globalAlpha = (1 - k) * 0.5; ctx.strokeStyle = '#2fd1bf'; ctx.lineWidth = 6 * (1 - k) + 2;
          this.fxRing(ctx, f.x, f.y, (30 + e * 160) / z); ctx.stroke();
          const a = k < 0.15 ? k / 0.15 : (k > 0.75 ? (1 - k) / 0.25 : 1);
          ctx.globalAlpha = a; ctx.font = '700 15px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 4; ctx.strokeStyle = this.th.halo; ctx.fillStyle = this.th.night ? '#7ff0e2' : '#0d8a7e';
          const txt = '新区域开放 · ' + String(f.o.name || '').replace(/（.*）/, '');
          ctx.strokeText(txt, p.x, p.y - 8 * e); ctx.fillText(txt, p.x, p.y - 8 * e);
          break;
        }
      }
    }
    ctx.restore();
  };
})(window.CM);
