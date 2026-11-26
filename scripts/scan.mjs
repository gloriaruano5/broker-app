// Revisión nocturna de las empresas del S&P 500 y del Nasdaq 100 con la misma lógica técnica de la app.
// Guarda en data/scan.json solo las que dan una señal favorable, para que la app las muestre al instante
// en «Oportunidades de compra». Solo datos públicos de mercado; orientativo, no es asesoramiento.
import fs from 'node:fs';
import { A, get, nasdaq } from './lib.mjs';

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
const list = [...uni.values()], out = []; let ok = 0, fail = 0;
for (let i = 0; i < list.length; i += 4) {
  await Promise.all(list.slice(i, i + 4).map(async u => {
    const h = await nasdaq(u.sym.replace('.', '/'), 'stocks', from).catch(e => ({ err: e.message }));
    if (h.err || h.c.length < 200) { fail++; return; }
    ok++;
    const ev = A.evaluate(h, { regime });
    const b = A.bucketOf(ev.score);
    if (b !== 'buy' && b !== 'acc') return;
    const c = h.c.slice(-61), lr = []; for (let k = 1; k < c.length; k++) lr.push(Math.log(c[k] / c[k - 1]));
    const mu = lr.reduce((x, y) => x + y, 0) / lr.length, sd = Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / (lr.length - 1));
    const px = h.c[h.c.length - 1];
    out.push({ sym: u.sym, name: u.name, sector: u.sector, idx: u.idx, score: Math.round(ev.score * 100) / 100, label: ev.label, kind: ev.kind, b,
      px, limit: Math.round(px * Math.exp(-0.7 * sd * Math.sqrt(5)) * 100) / 100, y1: A.changeSince(h.t, h.c, 365) });
  }));
}
out.sort((x, y) => y.score - x.score || (y.y1 || 0) - (x.y1 || 0));
const res = { date: new Date().toISOString().slice(0, 10), scanned: ok, failed: fail, favorable: out.length, ccy: 'USD', top: out.slice(0, 40) };
fs.writeFileSync(new URL('../data/scan.json', import.meta.url), JSON.stringify(res));
const text = `Revisadas ${ok} empresas (${fail} sin datos). Favorables: ${out.length}. Primeras: ${out.slice(0, 10).map(x => x.sym + ' ' + x.score).join(', ')}`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
