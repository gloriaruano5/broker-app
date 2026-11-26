// Prueba histórica (backtest) de la orientación y de los rangos de la app con datos reales.
// Usa exactamente el mismo código de análisis que la app (analysis.js). Guarda un resumen en data/backtest.json
// (solo estadísticas de los activos, nada de las posiciones de la usuaria).
import fs from 'node:fs';
import vm from 'node:vm';

const www = new URL('../app/src/main/assets/www/', import.meta.url);
const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['assets.js', 'analysis.js']) vm.runInContext(fs.readFileSync(new URL(f, www), 'utf8'), ctx);
const { DEFAULT_ASSETS, Analysis: A } = ctx.window;

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
let cookie = '', crumb = '';
async function get(url, h = {}) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...h } }); return { status: r.status, text: await r.text(), headers: r.headers }; }
  catch (e) { return { status: 0, text: String(e) }; }
}
async function yahooSession() {
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
  const sc = r && r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookie = sc.map(x => x.split(';')[0]).join('; ');
  const c = await get('https://query2.finance.yahoo.com/v1/test/getcrumb');
  crumb = c.status === 200 ? c.text.trim() : '';
  return `cookie ${cookie ? 'sí' : 'no'}, crumb ${c.status}`;
}
async function yahoo(sym) {
  for (const host of ['query2', 'query1']) {
    const r = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=1d${crumb ? '&crumb=' + encodeURIComponent(crumb) : ''}`);
    if (r.status !== 200) { if (host === 'query1') return { err: 'Yahoo ' + r.status }; continue; }
    const res = JSON.parse(r.text).chart.result?.[0]; if (!res) return { err: 'Yahoo vacío' };
    const q = res.indicators.quote[0]; const t = [], c = [];
    (res.timestamp || []).forEach((ts, i) => { const v = q.close?.[i]; if (v != null && v > 0) { t.push(ts); c.push(v); } });
    return { t, c, src: 'Yahoo' };
  }
}
async function nasdaq(sym, cls = 'stocks') {
  const r = await get(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${cls}&fromdate=1990-01-01&limit=99999`, { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  if (r.status !== 200) return { err: 'Nasdaq ' + r.status };
  const rows = JSON.parse(r.text)?.data?.tradesTable?.rows; if (!rows?.length) return { err: 'Nasdaq vacío' };
  const pts = rows.map(x => [Date.parse(x.date) / 1000, +String(x.close).replace(/[$,]/g, '')]).filter(x => x[1] > 0).sort((a, b) => a[0] - b[0]);
  return { t: pts.map(x => x[0]), c: pts.map(x => x[1]), src: 'Nasdaq' };
}
async function coinbase(sym) {
  const out = new Map(); let end = Math.floor(Date.now() / 1000);
  for (let k = 0; k < 20; k++) {
    const start = end - 299 * 86400;
    const r = await get(`https://api.exchange.coinbase.com/products/${sym}/candles?granularity=86400&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
    if (r.status !== 200) { if (!out.size) return { err: 'Coinbase ' + r.status }; break; }
    const rows = JSON.parse(r.text); if (!rows.length) break;
    rows.forEach(x => out.set(x[0], x[4]));
    end = start - 86400;
  }
  const ts = [...out.keys()].sort((a, b) => a - b);
  return { t: ts, c: ts.map(x => out.get(x)), src: 'Coinbase' };
}
const PROXY = { gold: 'GLD', water: 'CGW', china: 'MCHI', copx: 'COPX', sp500: 'SPY', japan: 'EWJ', copper: 'CPER' };
async function history(a) {
  const errs = [];
  if (a.yahoo.endsWith('-USD')) { const r = await coinbase(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  const y = await yahoo(a.yahoo); if (!y.err) return y; errs.push(y.err);
  if (!a.yahoo.includes('.') && !a.yahoo.includes('-')) { const r = await nasdaq(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  if (PROXY[a.id]) { const r = await nasdaq(PROXY[a.id], 'etf'); if (!r.err) { r.src = 'Nasdaq ' + PROXY[a.id] + ' (equivalente en EE. UU.)'; return r; } errs.push(r.err); }
  return { err: errs.join(', ') };
}
// Estudio de factores: qué parte de la señal ayuda de verdad (rentabilidad a 3 meses frente a la media del activo).
const FACT = {};
// Validación por periodos: ventaja de cada señal frente a la media del mismo activo EN ESE MISMO periodo.
const PER = {};
function periodStats(h, pts) {
  const split = Date.parse('2022-01-01') / 1000;
  for (const per of ['a', 'b']) {
    const P = pts.filter(p => p.f63 != null && (per === 'a' ? h.t[p.i] < split : h.t[p.i] >= split));
    if (P.length < 20) continue;
    const base = P.reduce((x, p) => x + p.f63, 0) / P.length;
    for (const p of P) { const k = p.b + per; const o = PER[k] || (PER[k] = [0, 0]); o[0] += p.f63 - base; o[1]++; }
    const fav = P.filter(p => p.score >= 0.75), unf = P.filter(p => p.score <= -0.75);
    for (const [nm, L] of [['fav', fav], ['unf', unf]]) { const o = PER[nm + per] || (PER[nm + per] = [0, 0]); L.forEach(p => { o[0] += p.f63 - base; o[1]++; }); }
  }
}
function factorStudy(h) {
  const c = h.c, t = h.t, n = c.length, s50 = A.sma(c, 50), s200 = A.sma(c, 200), r = A.rsi(c, 14);
  const pts = [];
  for (let i = 260; i + 63 < n; i += 5) pts.push(i);
  if (!pts.length) return;
  const f = i => c[i + 63] / c[i] - 1;
  const base = pts.reduce((x, i) => x + f(i), 0) / pts.length;
  const split = Date.parse('2022-01-01') / 1000;
  const feats = i => {
    const d = c[i] / s200[i] - 1, out = [];
    out.push(c[i] > s200[i] ? 'precio>MA200' : 'precio<MA200');
    out.push(s50[i] > s200[i] ? 'MA50>MA200' : 'MA50<MA200');
    out.push(r[i] >= 75 ? 'RSI>=75' : r[i] >= 70 ? 'RSI70-75' : r[i] <= 25 ? 'RSI<=25' : r[i] <= 30 ? 'RSI25-30' : 'RSI30-70');
    out.push(d > 0.35 ? 'dist200>+35%' : d > 0.15 ? 'dist200 +15..35%' : d < -0.25 ? 'dist200<-25%' : 'dist200 -25..+15%');
    if (c[i] > s200[i] && r[i] >= 70) out.push('alcista+RSI>=70');
    if (c[i] > s200[i] && r[i] <= 40) out.push('alcista+RSI<=40');
    if (c[i] < s200[i] && r[i] <= 30) out.push('bajista+RSI<=30');
    const ch3 = c[i] / c[Math.max(0, i - 63)] - 1, ch12 = c[i] / c[Math.max(0, i - 252)] - 1;
    out.push(ch12 > 0 ? 'mom12m>0' : 'mom12m<0');
    out.push(ch3 > 0 ? 'mom3m>0' : 'mom3m<0');
    return out;
  };
  for (const i of pts) {
    if (s200[i] == null || r[i] == null) continue;
    const ex = f(i) - base, per = t[i] < split ? 'a' : 'b';
    for (const k of feats(i)) { const o = FACT[k] || (FACT[k] = { a: [0, 0], b: [0, 0], assets: new Set() }); o[per][0] += ex; o[per][1]++; o.assets.add(h.id); }
  }
}

const pc = x => x == null ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const lines = [];
lines.push('Sesión Yahoo: ' + await yahooSession());
const result = { updated: new Date().toISOString().slice(0, 10), assets: {} };
const pool = { buy: [], acc: [], hold: [], caut: [], sell: [] };
const cover = { 4: [], 13: [], 52: [] };
for (const a of DEFAULT_ASSETS) {
  const h = await history(a);
  if (h.err || h.c.length < 400) { lines.push(`■ ${a.name}: sin historial suficiente (${h.err || h.c.length + ' días'})`); continue; }
  h.id = a.id; factorStudy(h);
  const bt = A.backtest(h, { keepPoints: true });
  periodStats(h, bt.pts); delete bt.pts;
  if (!bt) { lines.push(`■ ${a.name}: historial corto`); continue; }
  result.assets[a.id] = { src: h.src, days: h.c.length, ...bt };
  const s = bt.strategy, bb = bt.byBucket;
  lines.push(`■ ${a.name} (${h.src}, ${h.c.length} días desde ${new Date(h.t[0] * 1000).toISOString().slice(0, 10)})`);
  lines.push(`  3 meses después · al azar: sube ${(bt.base.up * 100).toFixed(0)}% media ${pc(bt.base.avg)} | ` + A.BUCKETS.map(([k, nm]) => bb[k].n ? `${nm}: n=${bb[k].n} sube ${(bb[k].up * 100).toFixed(0)}% media ${pc(bb[k].avg)}` : `${nm}: –`).join(' | '));
  lines.push(`  Estrategia salir en Precaución/Reducir: ${pc(s.cagr)}/año, caída máx ${pc(s.dd)} · comprar y mantener: ${pc(s.bhCagr)}/año, caída máx ${pc(s.bhDd)} · invertido ${(s.timeIn * 100).toFixed(0)}% del tiempo, ${s.switches} cambios`);
  lines.push('  Rangos 80% (acierto real): ' + Object.entries(bt.calib).map(([w, k]) => `${w} sem ${(k.coverage * 100).toFixed(0)}% (p10 ${k.q10.toFixed(2)}, p90 ${k.q90.toFixed(2)}, ${k.indep} casos indep.)`).join(' · '));
  for (const k of Object.keys(pool)) if (bb[k].n) pool[k].push({ n: bb[k].n, up: bb[k].up, avg: bb[k].avg - bt.base.avg });
  for (const w of [4, 13, 52]) if (bt.calib[w]) cover[w].push(bt.calib[w].coverage);
}
lines.push('');
lines.push('RESUMEN (media ponderada por casos; "ventaja" = rentabilidad a 3 meses tras la señal menos la de una semana cualquiera del mismo activo):');
for (const [k, nm] of A.BUCKETS) {
  const L = pool[k]; const N = L.reduce((x, y) => x + y.n, 0); if (!N) continue;
  lines.push(`  ${nm}: ${N} semanas en ${L.length} activos · ventaja media ${pc(L.reduce((x, y) => x + y.avg * y.n, 0) / N)}`);
}
for (const w of [4, 13, 52]) if (cover[w].length) lines.push(`  Rango ${w} semanas: el precio acabó dentro el ${(cover[w].reduce((x, y) => x + y, 0) / cover[w].length * 100).toFixed(0)}% de las veces (objetivo 80%)`);
result.summary = { pool: Object.fromEntries(Object.entries(pool).map(([k, L]) => { const N = L.reduce((x, y) => x + y.n, 0); return [k, N ? { n: N, edge: L.reduce((x, y) => x + y.avg * y.n, 0) / N } : null]; })), coverage: Object.fromEntries(Object.entries(cover).map(([w, L]) => [w, L.length ? L.reduce((x, y) => x + y, 0) / L.length : null])) };
lines.push('');
lines.push('VALIDACIÓN (ventaja a 3 meses frente a la media del activo en el mismo periodo; antes de 2022 | desde 2022):');
for (const [k, nm] of [...A.BUCKETS.map(b => [b[0], b[1]]), ['fav', 'Comprar+Acumular'], ['unf', 'Precaución+Reducir']]) {
  const a = PER[k + 'a'], b = PER[k + 'b'];
  lines.push(`  ${nm.padEnd(20)} ${a ? pc(a[0] / a[1]) + ' (n=' + a[1] + ')' : '–'} | ${b ? pc(b[0] / b[1]) + ' (n=' + b[1] + ')' : '–'}`);
}
result.validation = Object.fromEntries(Object.entries(PER).map(([k, v]) => [k, { edge: v[0] / v[1], n: v[1] }]));
lines.push('');
lines.push('FACTORES (ventaja a 3 meses frente a la media del activo; antes de 2022 | desde 2022; n = semanas):');
for (const [k, o] of Object.entries(FACT).sort()) lines.push(`  ${k.padEnd(20)} ${o.a[1] ? pc(o.a[0] / o.a[1]) : '–'} (n=${o.a[1]}) | ${o.b[1] ? pc(o.b[0] / o.b[1]) : '–'} (n=${o.b[1]}) · ${o.assets.size} activos`);
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
if (Object.keys(result.assets).length) {
  // Para no inflar el archivo, solo se guardan las estadísticas (no los puntos).
  fs.writeFileSync(new URL('../data/backtest.json', import.meta.url), JSON.stringify(result));
}
