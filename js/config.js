'use strict';
// 全局参数。PRD 中标注"待确认"的数值在此给出可调整的默认值（DEFAULT），评审确认后只需修改本文件。
(function (CM) {
  CM.CFG = {
    GAME_VERSION: '1.4.0',
    SAVE_FORMAT: 'city-metro-save',
    SAVE_VERSION: 2,
    SAVE_MIN_VERSION: 2,   // 1.1 起地图改为真实地理，旧版存档的城市数据与之不兼容

    // 地图：每格 250 m，120×96 格 ≈ 30 km × 24 km；交通小区 4×4 格（1 km²）
    W: 120, H: 96, CELL_M: 250, ZONE: 4,
    START: { y: 1990, m: 1, d: 1, minute: 6 * 60 },

    time: {
      secPerHour: 2.5,          // 1× 速度下，现实秒/游戏小时（一天 60 秒）
      speeds: [1, 3, 8],        // 加速档位
      visualPerSec: 24,         // 1× 下动态对象的"视觉时间"（游戏秒/现实秒），列车车辆按此运动
    },

    // 一天的出行时段（模型分时段计算）
    periods: [
      { key: 'AM', name: '早高峰', hours: [7, 8] },
      { key: 'MD', name: '日间平峰', hours: [6, 9, 10, 11, 12, 13, 14, 15, 16] },
      { key: 'PM', name: '晚高峰', hours: [17, 18] },
      { key: 'EV', name: '夜间', hours: [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5] },
    ],
    // 小时出行分布（估算，归一化后使用）
    hourProfile: [0.3, 0.2, 0.1, 0.1, 0.2, 0.6, 2.5, 8.5, 9.5, 6.0, 5.0, 5.2, 5.0, 4.8, 4.9, 5.0, 5.6, 8.0, 9.0, 6.0, 4.2, 3.2, 2.0, 1.0],
    // 各时段占该类出行的比例：[AM, MD, PM, EV]
    purposeSplit: {
      hwOut: [0.70, 0.22, 0.03, 0.05],  // 家→工作
      hwRet: [0.02, 0.18, 0.62, 0.18],  // 工作→家
      hoOut: [0.10, 0.62, 0.10, 0.18],  // 家→其他（购物、就学、休闲）
      hoRet: [0.03, 0.50, 0.17, 0.30],
    },

    walk: {
      mPerMin: 75,              // 步行速度
      maxAccessM: 1125,         // 进出站最大步行距离（15 分钟）DEFAULT
      transferMaxM: 500,        // 站外换乘最大步行距离 DEFAULT
      cellExtraM: 60,           // 街道到建筑的平均附加距离
    },

    metro: {
      vmax: { underground: 22, surface: 19, elevated: 22 },  // m/s
      accel: 0.9, dwell: 30, turnaround: 150,
      latAccel: 0.8,            // 弯道横向加速度上限 → 弯道限速
      carCap: 240,              // 每节车厢定员
      carsBySize: { S: 4, M: 6, L: 8 }, // 列车编组受沿线最小站台限制
      fMin: [8, 6, 8, 4],       // 各时段最低发车频率（列/小时）DEFAULT
      fMax: 30,                 // 最小间隔 2 分钟
      targetLF: 0.85,
      stationCap: { S: 9000, M: 20000, L: 40000 }, // 车站每小时进出站+换乘能力 DEFAULT
      minSpacingM: 350,         // 最小站距 DEFAULT
      // 线形约束（参考城市轨道交通设计规范的量级，DEFAULT）
      minRadiusM: 250,          // 正线最小曲线半径：低于此值不允许
      warnRadiusM: 400,         // 低于此值需限速通过
      maxTurnAtStationDeg: 60,  // 车站前后线路方向最大偏转（站台为直线段）
      platformHalfM: 70,        // 站台直线段半长
      maxGrade: 0.03,           // 最大坡度（地下/地面/高架转换坡道）
      levelM: { underground: -15, surface: 0, elevated: 12 }, // 轨面高程（米）
      sizeName: { S: '小型', M: '中型', L: '大型' },
      typeName: { underground: '地下', surface: '地面', elevated: '高架' },
      height: { underground: -0.11, surface: 0.0, elevated: 0.075 }, // 视觉高度（格）
    },

    // 建设成本（万元，1990 年价格，按年上涨）DEFAULT
    cost: {
      trackPerKm: { underground: 30000, surface: 6000, elevated: 12000 },
      riverPerKm: { underground: 22000, surface: 16000, elevated: 16000 }, // 越江隧道 / 跨江桥梁 附加
      hillPerKm: 12000,         // 山体隧道附加
      protectedPerKm: 6000,     // 保护建筑下方隧道加固附加
      station: {
        underground: { S: 15000, M: 25000, L: 40000 },
        elevated: { S: 8000, M: 13000, L: 20000 },
        surface: { S: 5000, M: 8000, L: 12000 },
      },
      upgradeFactor: 1.2,
      demolishPerCell: 30000,   // 拆迁一个完全开发街区的费用（按开发强度折算）
      demolishFactor: {
        track: { underground: 0, surface: 0.7, elevated: 0.18 },
        station: { underground: 0.25, surface: 0.8, elevated: 0.6 },
      },
      freeMoveM: 250,           // 车站移动不超过此距离免费 DEFAULT
      freeLengthM: 300,         // 线形调整导致增长不超过此值免费 DEFAULT
      relocationFactor: 0.5,    // 大范围搬迁按新站造价比例收费
      inflation: 0.035,
    },

    ops: {
      carKmCost: 0.0009,        // 万元/车厢公里（≈9 元）
      stationDaily: { S: 1.5, M: 2.6, L: 4.5 }, // 万元/天
      serviceHours: 18,
      inflation: 0.04,
    },

    // 全网统一票价（元/次，换乘不另收费）；滑块范围与步长 DEFAULT
    fareDefault: { mode: 'flat', flat: 2 },
    fareRange: { min: 0, max: 10, step: 0.5 },

    choice: {
      theta: 0.065,             // Logit 灵敏度（1/分钟）
      walkW: 1.6, waitW: 1.5,
      transferPen: 4, outTransferPen: 6,
      carAccess: 4,             // 停车与取车附加分钟
      // 以下为估算曲线：[年份, 值]
      vot: [[1990, 2.5], [1995, 5], [2000, 9], [2005, 14], [2010, 22], [2015, 32], [2020, 42], [2030, 58], [2050, 80]], // 元/小时
      carCostPerKm: [[1990, 0.40], [2000, 0.60], [2010, 0.85], [2020, 1.0], [2050, 1.2]],
      parking: [[1990, 0.5], [2000, 2], [2010, 6], [2020, 9], [2050, 12]],
      occupancy: [[1990, 3.4], [1995, 2.8], [2000, 2.3], [2005, 1.9], [2010, 1.6], [2020, 1.45], [2050, 1.4]],
      hoRate: [[1990, 0.16], [2000, 0.26], [2010, 0.38], [2020, 0.45], [2050, 0.5]],
      workerRate: [[1990, 0.36], [2000, 0.40], [2010, 0.43], [2050, 0.45]],
      distDecayHW: [[1990, 4.5], [2000, 6], [2010, 8], [2030, 9.5]], // km
      distDecayHO: [[1990, 2.8], [2010, 4], [2030, 5]],
    },

    road: {
      // 等级：1 支路 2 次干道 3 主干道 4 快速路
      cap: [0, 0, 1700, 3200, 5600],  // 单向小时通行能力（车/小时）
      speed: [0, 15, 28, 38, 65],     // 自由流速度 km/h
      bprA: 0.15, bprB: 4,
      msa: 0.4,
      // 系统道路改造（拓宽、信号优化、立交）带来的通行能力增长系数（估算）
      capGrowth: [[1990, 1.0], [1995, 1.25], [2000, 1.6], [2005, 2.0], [2010, 2.4], [2020, 2.9], [2040, 3.3]],
    },

    economy: {
      startFunds: 300000,       // 经营挑战初始资金 30 亿元 DEFAULT
      grantBase: [[1990, 15000], [2000, 32000], [2010, 70000], [2020, 110000], [2050, 180000]], // 万元/月
      debtLimit: -200000,       // 负债下限（随通胀调整）DEFAULT
      negMonthsLimit: 24,       // 连续负余额月数上限 DEFAULT
      satFail: 25, satFailMonths: 12,
      startSat: 60,
      failGrantFactor: 0.85, failGrantMonths: 12, failSat: -6,
    },

    growth: {
      popCurve: [[1990, 3.0e6], [1995, 3.45e6], [2000, 4.25e6], [2005, 5.15e6], [2010, 6.2e6], [2015, 6.9e6], [2020, 7.7e6], [2030, 8.5e6], [2045, 9.2e6], [2070, 9.8e6], [2300, 10.2e6]],
      histEnd: 2020,            // 此后为模拟增长
      jobsRatio: [[1990, 0.50], [2000, 0.53], [2010, 0.56], [2030, 0.58]],
      metroBoostMax: 0.06,
    },

    saves: { prefix: 'cm1.', maxManual: 12 },
    perf: { solverBudgetMs: 5, chunkBudgetMs: 6, cacheMaxPx: 24e6, maxCars: 320, maxPeds: 180 },
  };
})(window.CM);
