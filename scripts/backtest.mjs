// Prueba histórica (backtest) de la orientación y de los rangos de la app con datos reales.
// Usa exactamente el mismo código de análisis que la app (analysis.js). Guarda un resumen en data/backtest.json
// (solo estadísticas de los activos, nada de las posiciones de la usuaria).
import fs from 'node:fs';
import { DEFAULT_ASSETS, A, yahooSession, history, ctx } from './lib.mjs';
const P = ctx.window.Portfolio;
const HIST = {};
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
  h.id = a.id; HIST[a.id] = h; factorStudy(h);
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
// ---------- Reparto de la cartera: ¿qué habría funcionado? ----------
// Mismos activos y mismo periodo para todos los métodos. Se revisa cada mes (21 sesiones de bolsa).
function portfolioTest(ids, fromDate) {
  const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  const maps = {}; ids.forEach(id => { const m = new Map(); HIST[id].t.forEach((t, i) => m.set(day(t), HIST[id].c[i])); maps[id] = m; });
  // Días de bolsa de EE. UU. (los del S&P 500) en los que todos tienen precio.
  const dates = [...maps.sp500.keys()].filter(d => d >= fromDate && ids.every(id => maps[id].has(d))).sort();
  const groups = {}; ids.forEach(id => groups[id] = DEFAULT_ASSETS.find(a => a.id === id).type === 'Cripto' ? 'Cripto' : 'Otro');
  const volAt = (id, d) => { const c = HIST[id].c, t = HIST[id].t, end = t.findIndex(x => day(x) > d); const j = end < 0 ? c.length : end; const seg = c.slice(Math.max(0, j - 253), j); return A.volatility(seg, 250); };
  const methods = {
    quieta: { label: 'Reparto igual al principio y no tocar', target: () => null },
    igual: { label: 'Mismo peso a todos, reequilibrando cada mes', target: () => Object.fromEntries(ids.map(id => [id, 1 / ids.length])) },
    riesgo: { label: 'Pesos según riesgo, reequilibrando cada mes', target: d => P.riskWeights(Object.fromEntries(ids.map(id => [id, volAt(id, d) || 0.5])), groups, { asset: 0.15, groups: { Cripto: 0.15 } }) },
    banda: { label: 'Pesos según riesgo, solo cuando se separan (la app)', target: d => P.riskWeights(Object.fromEntries(ids.map(id => [id, volAt(id, d) || 0.5])), groups, { asset: 0.15, groups: { Cripto: 0.15 } }), band: true }
  };
  const res = {};
  for (const [k, m] of Object.entries(methods)) {
    let val = Object.fromEntries(ids.map(id => [id, 1 / ids.length])), peak = 1, dd = 0, trades = 0, turnover = 0; const rets = [];
    for (let i = 1; i < dates.length; i++) {
      const before = Object.values(val).reduce((x, y) => x + y, 0);
      ids.forEach(id => val[id] *= maps[id].get(dates[i]) / maps[id].get(dates[i - 1]));
      const tot = Object.values(val).reduce((x, y) => x + y, 0);
      rets.push(tot / before - 1); peak = Math.max(peak, tot); dd = Math.min(dd, tot / peak - 1);
      if (i % 21 === 0) {
        const tg = m.target(dates[i]); if (!tg) continue;
        const cur = Object.fromEntries(ids.map(id => [id, val[id] / tot]));
        const plan = m.band ? P.rebalancePlan(cur, tg, tot) : null;
        if (m.band && !plan.some(x => x.out)) continue;
        let moved = 0; ids.forEach(id => { moved += Math.abs(tg[id] * tot - val[id]); if (Math.abs(tg[id] - cur[id]) > 0.002) trades++; });
        turnover += moved / 2 / tot;
        const cost = moved * 0.001; // comisión aproximada (Trade Republic: 1 € por orden; aquí 0,1%)
        ids.forEach(id => val[id] = tg[id] * (tot - cost));
      }
    }
    const tot = Object.values(val).reduce((x, y) => x + y, 0), yrs = rets.length / 252;
    const mean = rets.reduce((x, y) => x + y, 0) / rets.length, sd = Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / rets.length);
    res[k] = { label: m.label, cagr: Math.pow(tot, 1 / yrs) - 1, vol: sd * Math.sqrt(252), dd, sharpe: mean / sd * Math.sqrt(252), trades, turnoverYear: turnover / yrs };
  }
  return { from: dates[0], to: dates[dates.length - 1], ids, res };
}
const pfIds = Object.keys(HIST).filter(id => HIST[id].t[0] <= Date.parse('2018-08-01') / 1000);
if (pfIds.includes('sp500') && pfIds.length >= 5) {
  const pt = portfolioTest(pfIds, '2018-08-01');
  // Validación: el mismo test en dos mitades.
  const pt2 = portfolioTest(pfIds, '2022-01-01');
  lines.push('');
  lines.push(`REPARTO DE LA CARTERA (${pt.ids.length} activos: ${pt.ids.join(', ')}; ${pt.from} a ${pt.to}; desde 2022 entre corchetes):`);
  for (const [k, r] of Object.entries(pt.res)) { const r2 = pt2.res[k]; lines.push(`  ${r.label}: ${pc(r.cagr)}/año, volatilidad ${pc(r.vol)}, caída máx ${pc(r.dd)}, rentabilidad/riesgo ${r.sharpe.toFixed(2)}, ${r.trades} órdenes [${pc(r2.cagr)}/año, caída ${pc(r2.dd)}, r/r ${r2.sharpe.toFixed(2)}]`); }
  result.portfolio = { full: pt, since2022: pt2 };
}
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
if (Object.keys(result.assets).length) {
  // Para no inflar el archivo, solo se guardan las estadísticas (no los puntos).
  fs.writeFileSync(new URL('../data/backtest.json', import.meta.url), JSON.stringify(result));
}
