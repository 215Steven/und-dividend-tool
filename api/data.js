/**
 * UND 配息率工具 — 伺服器端每日快照
 *
 * 2026/10 富邦改版後，舊的 djjson 端點全數 404，這支改接新版 JSON API。
 * 一次把清單、報酬率、各檔配息明細抓齊並算好年化配息率，
 * 回傳前端可以直接渲染的 report。
 *
 * 為什麼要有這支：
 *   原本每個訪客各自跑一輪（一百多檔、每檔約 0.5 秒），首次開啟要等幾十秒；
 *   改成所有人共用 CDN 快取，每天只打富邦一次，對方負載也小很多。
 *
 * CDN 快取：s-maxage=43200（12 小時）+ stale-while-revalidate=86400
 * 排程：vercel.json 的 cron 每天 UTC 04:00（台灣 12:00）預熱
 */

const FUBON_BASE = 'https://invest.fubonlife.com.tw';
const INSURANCE  = 'UND';
const CONCURRENCY = 8;

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
  'Origin': FUBON_BASE,
  'Referer': FUBON_BASE + '/funds/overview',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

async function fbPost(path, body, ms) {
  const r = await fetch(FUBON_BASE + path, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(ms || 15000)
  });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  const j = await r.json();
  return j && j.data;
}

// '13.80%' -> 13.8；'N/A' -> null
function pctNum(s) {
  if (s === null || s === undefined) return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function daysSince(d) {
  if (!d) return 99999;
  const t = Date.parse(String(d).replace(/\//g, '-'));
  return isNaN(t) ? 99999 : (Date.now() - t) / 86400000;
}
function ymdAgo(days) {
  const d0 = new Date(Date.now() - days * 86400000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d0.getFullYear() + '/' + p(d0.getMonth() + 1) + '/' + p(d0.getDate());
}
// 新版清單沒有配息頻率欄位，先由名稱猜，拿到明細後再用配息間隔修正
function freqFromName(name) {
  const s = String(name || '');
  if (/月配|月中配息|月撥|月收益/.test(s)) return '月配';
  if (/季配/.test(s)) return '季配';
  if (/半年配/.test(s)) return '半年配';
  if (/年配/.test(s)) return '年配';
  return '無';
}
function guessFreq(rows) {
  if (!rows || rows.length < 3) return null;
  const ds = rows.slice(0, 5)
    .map((r) => Date.parse(String(r.recordDate || r.dividendDate || r.date || '').replace(/\//g, '-')))
    .filter((t) => !isNaN(t));
  if (ds.length < 3) return null;
  let gap = 0;
  for (let i = 1; i < ds.length; i++) gap += Math.abs(ds[i - 1] - ds[i]) / 86400000;
  gap = gap / (ds.length - 1);
  if (gap < 45) return '月配';
  if (gap < 135) return '季配';
  if (gap < 225) return '半年配';
  return '年配';
}
// 與前端同一套：基金按月份去重取 6 筆，ETF 直接取前 6 筆
function get6MonthDivs(divs, isETF) {
  if (!divs || divs.length === 0) return [];
  if (isETF) return divs.slice(0, 6);
  const seen = {}, r = [];
  for (let i = 0; i < divs.length; i++) {
    const key = divs[i].date.substring(0, 7);
    if (!seen[key]) { seen[key] = true; r.push(divs[i]); }
    if (r.length >= 6) break;
  }
  return r;
}
function calcRate(nav, r6) {
  if (!r6 || r6.length === 0 || nav <= 0) return null;
  const avg = r6.reduce((s, d) => s + d.amount, 0) / r6.length;
  return (avg * 12) / nav * 100;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // ① 一次拿全部標的，再篩出本險種
    const assets = await fbPost('/api/asset/getAssets', {}, 25000);
    if (!assets || !assets.length) throw new Error('getAssets 回傳空資料');
    const mine = assets.filter((a) =>
      (a.insurances || []).some((x) => x.code === INSURANCE));
    if (!mine.length) throw new Error('找不到 ' + INSURANCE + ' 的標的');

    const byCode = {};
    const report = mine.map((a) => {
      const isDisc = a.optionType === 'DIA' || /全權委託/.test(a.assetType || '');
      const row = {
        name: (a.assetChName || '').trim(),
        code: a.assetFbCode || '',
        type: (a.assetType || '').trim(),
        cur:  a.currencyName || '',
        rr:   a.riskLevel || '',
        freq: freqFromName(a.assetChName),
        nav:  Number(a.netAssetValue) || 0,
        rate: '', divs: null, rn: 0,
        url:  FUBON_BASE + '/funds/overview/' + a.optionType + '/' + a.optionCompany + '/' + a.assetFbCode,
        isDisc: isDisc,
        ret6m: pctNum(a.sixMonthReturn),
        ret1y: pctNum(a.oneYearReturn),
        ret3y: pctNum(a.threeYearReturn),
        v40: a.assetFbCode || '',
        v41: a.optionType === 'ETF' ? 'C' : (isDisc ? 'D' : (a.optionType === 'WFUND' ? 'B' : 'A'))
      };
      byCode[row.v40] = row;
      return row;
    });

    // ② 配息明細：只抓「最近一次配息在 45 天內」的候選
    const cands = mine.filter((a) => !/全權委託/.test(a.assetType || '')
      && a.optionType !== 'DIA' && daysSince(a.dividendDate) <= 45);
    let idx = 0;
    async function worker() {
      while (idx < cands.length) {
        const a = cands[idx++];
        const isETF = a.optionType === 'ETF';
        try {
          const rows = await fbPost(
            isETF ? '/api/etf/getEtfDividends' : '/api/fund/getFundDividends',
            { assetFbCode: a.assetFbCode, startDate: ymdAgo(400), endDate: ymdAgo(0) },
            10000);
          const divs = (rows || []).map((x) => {
            const ds = x.recordDate || x.dividendDate || x.date || '';
            const am = parseFloat(x.dividendPerUnit);
            if (!ds || isNaN(am) || am <= 0) return null;
            return { date: String(ds).replace(/\//g, '-').substring(0, 7), amount: am };
          }).filter(Boolean);
          const row = byCode[a.assetFbCode];
          if (!row) continue;
          const fq = guessFreq(rows);
          if (fq) row.freq = fq;
          if (row.freq === '月配' && divs.length) {
            const r6 = get6MonthDivs(divs, isETF);
            const rate = calcRate(row.nav, r6);
            row.rate = rate !== null ? rate.toFixed(2) : '';
            row.divs = r6;
            row.rn = rate || 0;
          }
        } catch (_) { /* 個別基金失敗不中斷 */ }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const monthlyCount = report.filter((r) => r.freq === '月配' && !r.isDisc).length;
    const rated = report.filter((r) => r.rate).length;
    const savedAt = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    // 資料太少就不要讓 CDN 快取，免得一整天都回壞資料
    res.setHeader('Cache-Control', rated >= 10
      ? 's-maxage=43200, stale-while-revalidate=86400'
      : 'no-store');

    return res.status(200).json({
      insurance: INSURANCE,
      report: report,
      totalFunds: report.length,
      monthlyCount: monthlyCount,
      rated: rated,
      savedAt: savedAt,
      fetchedAt: Date.now()
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
