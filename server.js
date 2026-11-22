const http = require("http");

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = 20000; // প্রতি ২০ সেকেন্ডে ব্যাকগ্রাউন্ডে মার্কেট স্ক্যান

const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "MATICUSDT", "LINKUSDT"
];

const REST_BASES = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api1.binance.com",
  "https://api2.binance.com"
];

const DEMO_CAPITAL = 1000000;
const RISK_PCT = 1;
const LEVERAGE = 10;
const COOLDOWN_MS = 600000;

let state = {
  clientUpdatedAt: Date.now(),
  updatedAt: new Date().toISOString(),
  currentSelectedSymbol: "BTCUSDT",
  tf: "15m",
  isAutoSyncRunning: true,
  sessionSignals: [],
  verifiedHits: 0,
  totalExecutions: 0,
  realizedPnLTotal: 0,
  demoPositionsByPair: {}
};

const lastClosedByPair = {};
const lastLockKeyByPair = {};
let isScanning = false;

function fmtPrice(val) {
  const p = Math.abs(Number(val) || 0);
  if (p <= 0) return "0.00";
  if (p < 0.1) return p.toFixed(5);
  if (p < 1) return p.toFixed(4);
  if (p < 10) return p.toFixed(3);
  return p.toFixed(2);
}

function calcEMA(closes, period) {
  if (!closes || !closes.length) return [];
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let avgG = g / period, avgL = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    const last = candles && candles[candles.length - 1];
    return last ? last.close * 0.0025 : 1;
  }
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return Math.max(slice.reduce((a, b) => a + b, 0) / slice.length, candles[candles.length - 1].close * 0.0005);
}

function calcMACD(closes) {
  if (!closes || closes.length < 30) return 0;
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = calcEMA(line, 9);
  return line[line.length - 1] - sig[sig.length - 1];
}

function calcVWAP(candles) {
  let pv = 0, vol = 0;
  for (const c of candles.slice(-48)) {
    const typ = (c.high + c.low + c.close) / 3;
    pv += typ * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : candles[candles.length - 1].close;
}

async function fetchJson(url, timeoutMs = 4500) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchKlines(symbol, interval = "15m", limit = 120) {
  for (const base of REST_BASES) {
    const raw = await fetchJson(`${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (Array.isArray(raw) && raw.length >= 35) {
      return raw.map(k => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: Math.max(0, parseFloat(k[5])),
        takerBuyVol: Math.max(0, parseFloat(k[9]) || parseFloat(k[5]) * 0.5)
      })).filter(c => Number.isFinite(c.close) && c.close > 0);
    }
  }
  return null;
}

function evaluatePair(candles) {
  const closed = candles.slice(0, -1);
  const evalSet = closed.length >= 28 ? closed : candles;
  const closes = evalSet.map(c => c.close);
  const last = evalSet[evalSet.length - 1];
  const prev = evalSet.length >= 2 ? evalSet[evalSet.length - 2] : last;
  const live = candles[candles.length - 1];
  const price = live.close;

  const ema7 = calcEMA(closes, 7).slice(-1)[0];
  const ema25 = calcEMA(closes, 25).slice(-1)[0];
  const ema99 = calcEMA(closes, 99).slice(-1)[0];
  const vwap = calcVWAP(evalSet);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(evalSet, 14);
  const macd = calcMACD(closes);

  const lookback = evalSet.slice(-21, -1);
  const swingHigh = Math.max(...lookback.map(c => c.high));
  const swingLow = Math.min(...lookback.map(c => c.low));

  let structure = "RANGE";
  if (last.close > swingHigh) structure = "BULL BOS";
  else if (last.close < swingLow) structure = "BEAR BOS";
  else if (ema7 > ema25 && ema25 > ema99) structure = "BULL TREND";
  else if (ema7 < ema25 && ema25 < ema99) structure = "BEAR TREND";

  let cvdDelta = 0, volSum = 0;
  for (const c of evalSet.slice(-14)) {
    cvdDelta += (c.takerBuyVol - (c.volume - c.takerBuyVol));
    volSum += c.volume;
  }
  const cvdRatio = volSum > 0 ? cvdDelta / volSum : 0;
  const avgVol = volSum / Math.max(1, Math.min(14, evalSet.length));
  const volExp = last.volume >= avgVol * 0.9;

  let longScore = 20, shortScore = 20;
  if (ema7 > ema25 && ema25 > ema99 && last.close >= ema7) longScore += 18;
  if (ema7 < ema25 && ema25 < ema99 && last.close <= ema7) shortScore += 18;
  if (structure.includes("BULL") && last.close > last.open) longScore += 16;
  if (structure.includes("BEAR") && last.close < last.open) shortScore += 16;
  if (price >= vwap) longScore += 8;
  if (price <= vwap) shortScore += 8;
  if (cvdRatio > 0.03 && volExp) longScore += 16;
  if (cvdRatio < -0.03 && volExp) shortScore += 16;
  if (macd > 0 && rsi >= 50 && rsi <= 78) longScore += 14;
  if (macd < 0 && rsi <= 50 && rsi >= 22) shortScore += 14;

  const liveBull = live.close >= live.open && live.close >= ema7;
  const liveBear = live.close <= live.open && live.close <= ema7;
  const closedBull = last.close > last.open && prev.close >= prev.open && last.close >= ema7;
  const closedBear = last.close < last.open && prev.close <= prev.open && last.close <= ema7;

  const isLongLock = liveBull && closedBull && longScore > shortScore && longScore >= 85;
  const isShortLock = liveBear && closedBear && shortScore > longScore && shortScore >= 85;

  const direction = isLongLock ? "LONG (BUY)" : (isShortLock ? "SHORT (SELL)" : (longScore >= shortScore ? "LONG (BUY)" : "SHORT (SELL)"));
  const isLocked = isLongLock || isShortLock;
  const confidence = isLocked ? Math.min(99, Math.max(90, Math.round(Math.max(longScore, shortScore)))) : Math.min(89, Math.max(20, Math.round(Math.max(longScore, shortScore))));

  const riskDist = Math.max(atr * 1.5, price * 0.0025);
  const isLong = direction.includes("LONG");
  const entry = price;
  const sl = isLong ? entry - riskDist : entry + riskDist;
  const tp = isLong ? entry + riskDist * 3 : entry - riskDist * 3;

  return {
    currentPrice: price,
    direction,
    confidence,
    isLocked,
    entry,
    sl,
    tp,
    entryTime: live.time
  };
}

function getLockedMargin() {
  return Object.values(state.demoPositionsByPair).reduce((acc, p) => acc + (Number(p?.margin) || 0), 0);
}

function formatBstTime() {
  const bst = new Date(Date.now() + 6 * 3600 * 1000);
  return bst.toISOString().split("T")[1].split(".")[0];
}

async function runBackgroundScan() {
  if (isScanning || !state.isAutoSyncRunning) return;
  isScanning = true;
  let mutated = false;

  try {
    const tf = state.tf || "15m";
    for (const pair of PAIRS) {
      const candles = await fetchKlines(pair, tf, 120);
      if (!candles || candles.length < 35) continue;

      const evalRes = evaluatePair(candles);
      const px = evalRes.currentPrice;
      const riskAmt = (DEMO_CAPITAL * RISK_PCT) / 100;

      // ১. সক্রিয় পজিশনের TP/SL চেক
      for (const item of state.sessionSignals) {
        if (item.pair === pair && String(item.resultStatus || "").includes("ACTIVE")) {
          const isLong = String(item.direction).includes("LONG");
          const hitTP = isLong ? px >= item.tpRaw : px <= item.tpRaw;
          const hitSL = isLong ? px <= item.slRaw : px >= item.slRaw;
          const tRisk = Number(item.riskAmt) || riskAmt;

          if (hitTP) {
            const gain = tRisk * 3;
            state.realizedPnLTotal += gain;
            item.resultStatus = `TP HIT (+$${gain.toFixed(0)})`;
            state.verifiedHits += 1;
            state.totalExecutions += 1;
            delete state.demoPositionsByPair[pair];
            lastClosedByPair[pair] = Date.now();
            mutated = true;
          } else if (hitSL) {
            state.realizedPnLTotal -= tRisk;
            item.resultStatus = `SL HIT (-$${tRisk.toFixed(0)})`;
            state.totalExecutions += 1;
            delete state.demoPositionsByPair[pair];
            lastClosedByPair[pair] = Date.now();
            mutated = true;
          }
        }
      }

      // ২. নতুন ৯০%+ সিগন্যাল ডিটেক্ট ও সেভ
      const hasActive = Boolean(state.demoPositionsByPair[pair]) ||
        state.sessionSignals.some(s => s.pair === pair && String(s.resultStatus || "").includes("ACTIVE"));
      const lastClosedAt = lastClosedByPair[pair] || 0;
      const cooldownOk = (Date.now() - lastClosedAt) > COOLDOWN_MS;
      const key = `${pair}_${tf}_${evalRes.direction}_${fmtPrice(evalRes.entry)}`;
      const lastKeyMeta = lastLockKeyByPair[pair];
      const dup = lastKeyMeta && lastKeyMeta.key === key && (Date.now() - lastKeyMeta.ts) < COOLDOWN_MS;

      if (!hasActive && cooldownOk && !dup && evalRes.isLocked && evalRes.confidence >= 90) {
        const slDist = Math.max(1e-8, Math.abs(evalRes.entry - evalRes.sl));
        const qty = riskAmt / slDist;
        const margin = (qty * evalRes.entry) / LEVERAGE;
        const freeCash = Math.max(0, DEMO_CAPITAL + state.realizedPnLTotal - getLockedMargin());

        if (freeCash >= margin && margin > 0) {
          const pct = Math.min(99, Math.max(90, Math.round(evalRes.confidence)));
          state.sessionSignals.unshift({
            time: formatBstTime(),
            pair,
            tf: tf.toUpperCase(),
            direction: evalRes.direction,
            entryRaw: evalRes.entry,
            slRaw: evalRes.sl,
            tpRaw: evalRes.tp,
            entryTime: evalRes.entryTime,
            lockedAtSec: evalRes.entryTime,
            riskAmt,
            resultStatus: `${pct}% LOCKED • ACTIVE`
          });
          if (state.sessionSignals.length > 50) state.sessionSignals.pop();

          state.demoPositionsByPair[pair] = {
            pair,
            tf: tf.toUpperCase(),
            direction: evalRes.direction,
            entryRaw: evalRes.entry,
            slRaw: evalRes.sl,
            tpRaw: evalRes.tp,
            entryTime: evalRes.entryTime,
            lockedAtSec: evalRes.entryTime,
            qty,
            margin,
            riskAmt
          };
          lastLockKeyByPair[pair] = { key, ts: Date.now() };
          mutated = true;
        }
      }
    }

    if (mutated) {
      state.clientUpdatedAt = Date.now();
      state.updatedAt = new Date().toISOString();
    }
  } catch (e) {
    // Silent fallback
  } finally {
    isScanning = false;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (urlPath === "/api/signals" && req.method === "GET") {
    sendJson(res, 200, state);
    return;
  }

  if (urlPath === "/api/signals" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
      if (body.length > 2e6) req.destroy();
    });
    req.on("end", () => {
      try {
        const incoming = JSON.parse(body || "{}");
        const incomingTs = Number(incoming.clientUpdatedAt) || 0;
        const currentTs = Number(state.clientUpdatedAt) || 0;

        if (incoming.tf) state.tf = incoming.tf;
        if (typeof incoming.isAutoSyncRunning === "boolean") {
          state.isAutoSyncRunning = incoming.isAutoSyncRunning;
        }

        if (!incomingTs || incomingTs >= currentTs) {
          if (Array.isArray(incoming.sessionSignals)) {
            state.sessionSignals = incoming.sessionSignals;
          }
          if (incoming.demoPositionsByPair && typeof incoming.demoPositionsByPair === "object") {
            state.demoPositionsByPair = incoming.demoPositionsByPair;
          }
          if (typeof incoming.verifiedHits === "number") state.verifiedHits = incoming.verifiedHits;
          if (typeof incoming.totalExecutions === "number") state.totalExecutions = incoming.totalExecutions;
          if (typeof incoming.realizedPnLTotal === "number") state.realizedPnLTotal = incoming.realizedPnLTotal;
          state.clientUpdatedAt = incomingTs || Date.now();
          state.updatedAt = new Date().toISOString();
        }

        sendJson(res, 200, { ok: true, state });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }
    });
    return;
  }

  sendJson(res, 200, {
    status: "running",
    service: "crypto-pro-24x7-backend",
    scannerIntervalMs: SCAN_INTERVAL_MS,
    updatedAt: state.updatedAt,
    activeSignalsCount: state.sessionSignals.length,
    endpoints: ["/api/signals"]
  });
});

server.listen(PORT, () => {
  console.log(`CRYPTO PRO 24x7 Backend listening on port ${PORT}`);
  runBackgroundScan();
  setInterval(runBackgroundScan, SCAN_INTERVAL_MS);
});
