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
async function history(a) {
  const errs = [];
  if (a.yahoo.endsWith('-USD')) { const r = await coinbase(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  const y = await yahoo(a.yahoo); if (!y.err) return y; errs.push(y.err);
  if (!a.yahoo.includes('.') && !a.yahoo.includes('-')) { const r = await nasdaq(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  return { err: errs.join(', ') };
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
  const bt = A.backtest(h);
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
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
if (Object.keys(result.assets).length) {
  // Para no inflar el archivo, solo se guardan las estadísticas (no los puntos).
  fs.writeFileSync(new URL('../data/backtest.json', import.meta.url), JSON.stringify(result));
}
