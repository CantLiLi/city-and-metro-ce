'use strict';
// 地图：广州（真实地理）与新手教程「青湾」（虚构小城）。
// 各模块在加载时引用同一个 CM.DATA 对象，切换地图时替换它的内容，同时替换 CM.GEO（地理数据源）与网格尺寸、起始日期、人口曲线等参数。
(function (CM) {
  const CFG = CM.CFG;
  const MAPS = {
    gz: {
      id: 'gz', name: '广州', title: '广州 · 1990', sub: '真实地理（OpenStreetMap）· 1990 年起',
      desc: '从 1990 年尚无地铁的广州开始：珠江水系、道路与桥梁、街道边界和地标都来自真实地理，区域按历史年份逐步开放，并有参考广州地铁发展的历史任务。',
      facts: [['范围', '30 km × 24 km'], ['起始', '1990 年'], ['人口', '约 300 万'], ['模式', '经营挑战 / 自由建造']],
      modes: ['challenge', 'free'],
      geo: CM.GEO, data: Object.assign({}, CM.DATA),
      cfg: { W: CFG.W, H: CFG.H, START: Object.assign({}, CFG.START), growth: CFG.growth },
      cam: { cx: 30, cy: 41, zoom: 18 },
    },
  };
  if (CM.MAP_TUTORIAL) MAPS.tutorial = CM.MAP_TUTORIAL;
  CM.MAPS = MAPS;
  CM.MAP_ORDER = Object.keys(MAPS);
  CM.mapId = 'gz';
  CM.useMap = function (id) {
    const m = MAPS[id] || MAPS.gz;
    if (CM.mapId === m.id && CM.GEO === m.geo) return m;
    CM.mapId = m.id;
    for (const k of Object.keys(CM.DATA)) delete CM.DATA[k];
    Object.assign(CM.DATA, m.data);
    CM.GEO = m.geo;
    CFG.W = m.cfg.W; CFG.H = m.cfg.H; CFG.START = Object.assign({}, m.cfg.START); CFG.growth = m.cfg.growth;
    if (CM.Geo) CM.Geo.init();
    return m;
  };
  CM.curMap = function () { return MAPS[CM.mapId] || MAPS.gz; };

  // 地图缩略图：水系、主要道路与铁路（不切换当前地图，直接解码该地图的数据），按主题配色，结果缓存
  const thumbs = {};
  CM.mapThumb = function (id, theme) {
    const key = id + ':' + theme;
    if (thumbs[key]) return thumbs[key];
    const m = MAPS[id]; if (!m) return null;
    const G = m.geo, dec = CM.Geo.dec, Wc = m.cfg.W, Hc = m.cfg.H;
    const S = Math.min(640 / Wc, 400 / Hc), cv = document.createElement('canvas');
    cv.width = Math.round(Wc * S); cv.height = Math.round(Hc * S);
    const c = cv.getContext('2d'), dark = theme === 'dark';
    c.fillStyle = dark ? '#1b2533' : '#eef3f0'; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(S, 0, 0, S, 0, 0);
    const poly = function (rows, col) {
      c.fillStyle = col; c.beginPath();
      for (const row of rows) for (let k = 1; k < row.length; k++) { if (typeof row[k] !== 'string') continue; const p = dec(row[k], 1); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); }
      c.fill('evenodd');
    };
    poly(G.woods || [], dark ? '#22362f' : '#dbe9dc');
    poly(G.reserves || [], dark ? '#2a4238' : '#c9dfcc');
    poly(G.parks || [], dark ? '#264034' : '#cfe6cf');
    poly((G.water || []).filter(function (r) { return typeof r[1] !== 'number'; }), dark ? '#2b4f78' : '#a9cdeb');
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const r of G.water || []) if (typeof r[1] === 'number') { const p = dec(r[2]); c.strokeStyle = dark ? '#2b4f78' : '#a9cdeb'; c.lineWidth = Math.max(r[1], 0.25); c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke(); }
    for (const r of G.rail || []) { if (r[1] & 2) continue; const p = dec(r[2]); c.strokeStyle = dark ? '#5b6676' : '#9aa3ae'; c.lineWidth = 0.18; c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke(); }
    for (const cls of [3, 4]) for (const r of G.roads || []) {
      if (r[1] !== cls || (r[2] & 6)) continue;
      const p = dec(r[3]); c.strokeStyle = dark ? (cls === 4 ? '#b8964a' : '#6f7b8c') : (cls === 4 ? '#f0b54a' : '#c4ccd6'); c.lineWidth = cls === 4 ? 0.45 : 0.3;
      c.beginPath(); c.moveTo(p[0], p[1]); for (let q = 2; q < p.length; q += 2) c.lineTo(p[q], p[q + 1]); c.stroke();
    }
    thumbs[key] = cv.toDataURL('image/png');
    return thumbs[key];
  };
})(window.CM);
