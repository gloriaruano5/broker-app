// Revisión nocturna de las empresas del S&P 500 y del Nasdaq 100 con la misma lógica técnica de la app.
// Guarda en data/scan.json solo las que dan una señal favorable, para que la app las muestre al instante
// en «Oportunidades de compra». Solo datos públicos de mercado; orientativo, no es asesoramiento.
import fs from 'node:fs';
import { A, get, nasdaq, news, fearGreed } from './lib.mjs';

const NH = { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
const SECTOR = { 'Information Technology': 'Tecnología', 'Health Care': 'Salud', Financials: 'Finanzas', 'Consumer Discretionary': 'Consumo', 'Consumer Staples': 'Consumo básico',
  'Communication Services': 'Comunicación', Industrials: 'Industria', Energy: 'Energía', Utilities: 'Eléctricas y agua', 'Real Estate': 'Inmobiliario', Materials: 'Materiales' };
const uni = new Map();

// S&P 500: lista pública mantenida en GitHub (datasets/s-and-p-500-companies); si falla, la tabla de Wikipedia.
try {
  const r = await get('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv');
  for (const line of r.text.split('\n').slice(1)) {
    const f = [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map(m => m[2] ?? m[1]).slice(0, 3);
    if (!f[0] || !/^[A-Z.]+$/.test(f[0])) continue;
    uni.set(f[0], { sym: f[0], name: f[1], sector: SECTOR[f[2]] || '', idx: 'S&P 500' });
  }
} catch (e) { console.log('Lista S&P 500:', e.message); }
if (uni.size < 400) try {
  const r = await get('https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw');
  const txt = r.text.split(/\n\|\}/)[0];
  for (const row of txt.split('\n|-')) {
    const m = row.match(/\{\{\s*(?:NyseSymbol|NasdaqSymbol|nyse|nasdaq|NYSE|NASDAQ)[^|]*\|\s*([A-Z.]+)\s*\}\}/i);
    if (!m) continue;
    const cells = row.split(/\|\||\n\|/).map(x => x.trim()).filter(Boolean);
    const nameCell = cells.find(c => /\[\[/.test(c)) || '';
    const name = (nameCell.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/) || []).slice(1).filter(Boolean).pop() || m[1];
    const sec = cells.find(c => SECTOR[c.replace(/\[\[|\]\]/g, '')]);
    uni.set(m[1].toUpperCase(), { sym: m[1].toUpperCase(), name, sector: sec ? SECTOR[sec.replace(/\[\[|\]\]/g, '')] : '', idx: 'S&P 500' });
  }
} catch (e) { console.log('Wikipedia:', e.message); }
console.log('S&P 500:', uni.size);
// Nasdaq 100.
try {
  const j = JSON.parse((await get('https://api.nasdaq.com/api/quote/list-type/nasdaq100', NH)).text);
  for (const x of j.data.data.rows) { const s = x.symbol.toUpperCase(); if (uni.has(s)) uni.get(s).idx += ' · Nasdaq 100'; else uni.set(s, { sym: s, name: x.companyName, sector: '', idx: 'Nasdaq 100' }); }
} catch (e) { console.log('Nasdaq 100:', e.message); }
console.log('Total:', uni.size);
if (uni.size < 50) { console.log('Universo demasiado pequeño, no se guarda nada'); process.exit(0); }

const from = new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10);
const spy = await nasdaq('SPY', 'etf', from);
const regime = spy.err ? null : A.regimeOf(spy);
const list = [...uni.values()], out = [], preDiscard = []; let ok = 0, fail = 0;
for (let i = 0; i < list.length; i += 4) {
  await Promise.all(list.slice(i, i + 4).map(async u => {
    const h = await nasdaq(u.sym.replace('.', '/'), 'stocks', from).catch(e => ({ err: e.message }));
    if (h.err || h.c.length < 200) { fail++; return; }
    ok++;
    const ev = A.evaluate(h, { regime, name: u.name });
    if (ev.deal || (ev.pinned && ev.pinned.pinned)) preDiscard.push({ sym: u.sym, name: u.name, why: `precio casi fijado (se mueve un ${Math.round(ev.pinned.vol20 * 100)}% al año): posible oferta de compra` });
    const b = A.bucketOf(ev.score);
    if (b !== 'buy' && b !== 'acc') return;
    const c = h.c.slice(-61), lr = []; for (let k = 1; k < c.length; k++) lr.push(Math.log(c[k] / c[k - 1]));
    const mu = lr.reduce((x, y) => x + y, 0) / lr.length, sd = Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / (lr.length - 1));
    const px = h.c[h.c.length - 1];
    out.push({ h, sym: u.sym, name: u.name, sector: u.sector, idx: u.idx, score: Math.round(ev.score * 100) / 100, label: ev.label, kind: ev.kind, b,
      px, vol: Math.round(sd * Math.sqrt(252) * 100) / 100, limit: Math.round(px * Math.exp(-0.7 * sd * Math.sqrt(5)) * 100) / 100, y1: A.changeSince(h.t, h.c, 365) });
  }));
}
// Segunda vuelta: antes de proponer nada, se contrasta cada candidata con todas las fuentes gratuitas.
// - SEC: si la empresa ha presentado formularios de compra o fusión (OPA) en los últimos 6 meses.
// - Precio clavado (oferta de compra en curso): se descarta aunque la parte técnica salga muy bien.
// - Noticias (tono y avisos de OPA/fusión), analistas (recomendación y revisiones), valoración (PER), miedo y codicia y mercado.
const SEC_UA = `MiCartera/1.0 ${process.env.SEC_CONTACT || 'broker-app-github-actions@users.noreply.github.com'}`;
let cikMap = {};
try { const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': SEC_UA } }); const j = await r.json(); for (const v of Object.values(j)) cikMap[v.ticker.toUpperCase()] = String(v.cik_str).padStart(10, '0'); } catch (e) { console.log('SEC tickers:', e.message); }
const fg = await fearGreed().catch(() => ({}));
const num = x => { const v = parseFloat(String(x ?? '').replace(/[$,%x]/g, '')); return isFinite(v) ? v : null; };
let dbg = 0;
async function confirm(x) {
  const chk = { sec: false, news: 0, analysts: false, valuation: false, sentiment: !!(fg && fg.stocks), market: !!regime };
  let dealFiling = null, filings = [];
  const cik = cikMap[x.sym.replace('.', '-')] || cikMap[x.sym];
  if (cik) try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': SEC_UA } });
    if (r.ok) { const j = await r.json(), f = j.filings.recent; filings = f.form.slice(0, 200).map((form, k) => ({ form, date: f.filingDate[k] })); dealFiling = A.dealFiling(filings); chk.sec = true; }
  } catch (e) {}
  const nm = x.name.replace(/\s*\(.*\)$/, '').replace(/,?\s+(Inc|Corp|Corporation|Co|Company|plc|Holdings?|Group|Ltd)\.?$/i, '');
  const nw = await news(`"${nm}" stock`, 14).catch(() => []);
  const pin = A.pinnedPrice(x.h);
  const dn = pin && pin.pinned ? await news(`"${nm}" acquisition OR merger OR takeover OR "tender offer"`, 120).catch(() => []) : [];
  chk.news = nw.length;
  const NH2 = { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
  const leading = {};
  const [fr, rr, sr] = await Promise.all([
    get(`https://api.nasdaq.com/api/analyst/${x.sym}/earnings-forecast`, NH2), get(`https://api.nasdaq.com/api/analyst/${x.sym}/ratings`, NH2),
    get(`https://api.nasdaq.com/api/quote/${x.sym}/summary?assetclass=stocks`, NH2)]);
  try { const j = JSON.parse(fr.text).data; const rows = [...((j.quarterlyForecast || {}).rows || []).slice(0, 1), ...((j.yearlyForecast || {}).rows || []).slice(0, 1)];
    if (rows.length) { leading.revUp = rows.reduce((a, r) => a + (num(r.up) || 0), 0); leading.revDown = rows.reduce((a, r) => a + (num(r.down) || 0), 0); chk.analysts = true; } } catch (e) {}
  try { const j = JSON.parse(rr.text).data; if (j.meanRatingType) { leading.rating = j.meanRatingType; chk.analysts = true; } } catch (e) {}
  let pe = null, fpe = null, target = null;
  try { const sd = JSON.parse(sr.text).data.summaryData; const f = k => { const e = Object.entries(sd).find(([kk]) => kk.toLowerCase() === k.toLowerCase()); return e ? num(e[1].value) : null; };
    pe = f('PERatio'); fpe = f('ForwardPE1Yr'); target = f('OneYrTarget'); chk.valuation = pe != null || fpe != null || target != null;
    if (!dbg++) console.log('Nasdaq summary', x.sym, sr.status, Object.keys(sd).join(',')); } catch (e) { if (!dbg++) console.log('Nasdaq summary', x.sym, sr.status, String(sr.text).slice(0, 200)); }
  const ev = A.evaluate(x.h, { regime, news: nw, dealNews: dn, name: x.name, dealFiling, fearGreed: fg && fg.stocks, leading: Object.keys(leading).length ? leading : null });
  let score = ev.score; const extraR = [];
  // Valoración sencilla con el PER (beneficio que se paga por cada acción): muy caro o en pérdidas resta; beneficios que crecen suman.
  if (pe != null && pe > 0 && fpe != null && fpe > 0 && fpe < pe * 0.85) { score += 0.25; extraR.push({ pts: 0.25, text: `Se espera que el beneficio crezca (PER ${pe.toFixed(0)} → ${fpe.toFixed(0)} el año que viene).` }); }
  if ((pe != null && pe > 60) || (fpe != null && fpe > 45)) { score -= 0.5; extraR.push({ pts: -0.5, text: `Valoración exigente (PER ${(pe ?? fpe).toFixed(0)}): si decepciona, puede caer mucho.` }); }
  if (pe == null && fpe != null && fpe < 0) { score -= 0.5; extraR.push({ pts: -0.5, text: 'La empresa está en pérdidas.' }); }
  // Precio objetivo medio de los analistas a 12 meses frente al precio de hoy.
  const upside = target && x.px ? target / x.px - 1 : null;
  if (upside != null && upside > 0.15) extraR.push({ pts: 0.25, text: `Los analistas ven de media un ${Math.round(upside * 100)}% de subida a 12 meses.` });
  if (upside != null && upside < 0) { score -= 0.5; extraR.push({ pts: -0.5, text: `El precio ya está por encima del objetivo medio de los analistas (${Math.round(upside * 100)}%).` }); }
  if (upside != null && upside > 0.15) score += 0.25;
  const reasons = [...ev.reasons.filter(r => r.pts), ...extraR];
  // Desempate continuo con datos distintos del precio: objetivo de analistas, revisiones de beneficio y tono de las noticias.
  const rv = (leading.revUp || 0) + (leading.revDown || 0), tone = ev.news ? ev.news.avg || 0 : 0;
  const tb = Math.max(-0.3, Math.min(0.3, upside || 0)) + (rv ? 0.2 * (leading.revUp - leading.revDown) / rv : 0) + 0.2 * Math.max(-1, Math.min(1, tone));
  const n = Object.values(chk).filter(Boolean).length + 1; // + la gráfica
  return { ...x, score: Math.round(score * 100) / 100, label: ev.label, kind: ev.kind, b: A.bucketOf(score), deal: ev.deal ? (dealFiling || (ev.deal.news[0] || 'precio fijado')) : (dealFiling && pin && pin.pinned ? dealFiling : null), dealFiling,
    pinned: !!(pin && pin.pinned), checks: chk, sources: n, rating: leading.rating || null, pe, fpe, upside: upside != null ? Math.round(upside * 1000) / 1000 : null, tb: Math.round(tb * 1000) / 1000,
    pro: reasons.filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 3).map(r => r.text), con: reasons.filter(r => r.pts < 0).sort((a, b) => a.pts - b.pts).slice(0, 3).map(r => r.text) };
}
// Se contrastan las 80 mejores por precio (de 4 en 4 para no saturar las fuentes).
out.sort((x, y) => y.score - x.score || x.vol - y.vol);
const cand = out.slice(0, 80), conf = [];
for (let i = 0; i < cand.length; i += 4) conf.push(...(await Promise.all(cand.slice(i, i + 4).map(x => confirm(x).catch(e => ({ ...x, err: e.message }))))));
const discarded = preDiscard.concat(conf.filter(x => x.deal || x.pinned).map(x => ({ sym: x.sym, name: x.name, why: x.deal ? 'oferta de compra o fusión: ' + x.deal : 'precio casi fijado (posible oferta de compra)' })));
// Solo se proponen las confirmadas: sin oferta de compra ni precio fijado, señal favorable tras todo el contraste y al menos 4 fuentes con datos.
const good = conf.filter(x => !x.err && !x.deal && !x.pinned && (x.b === 'buy' || x.b === 'acc') && x.sources >= 4);
// Orden: la señal completa ajustada por riesgo (a señal parecida, primero el que menos oscila).
const ra = x => x.score - 3 * Math.max(0, x.vol - 0.3) + (x.tb || 0);
good.sort((x, y) => ra(y) - ra(x));
good.forEach(x => delete x.h); out.forEach(x => delete x.h);
const res = { date: new Date().toISOString().slice(0, 10), scanned: ok, failed: fail, favorable: out.length, checked: conf.length, confirmed: good.length, discarded, ccy: 'USD', top: good.slice(0, 40) };
fs.writeFileSync(new URL('../data/scan.json', import.meta.url), JSON.stringify(res));
const text = `Revisadas ${ok} empresas (${fail} sin datos). Favorables por precio: ${out.length}. Contrastadas: ${conf.length}. Confirmadas: ${good.length}. Descartadas por OPA/precio fijado: ${discarded.map(x => x.sym).join(', ') || 'ninguna'}. Primeras: ${good.slice(0, 10).map(x => x.sym + ' ' + x.score).join(', ')}`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
