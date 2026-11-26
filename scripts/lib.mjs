// Funciones comunes de los scripts: cargar el código de análisis de la app y descargar precios, noticias y sentimiento.
import fs from 'node:fs';
import vm from 'node:vm';

export const www = new URL('../app/src/main/assets/www/', import.meta.url);
const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['assets.js', 'analysis.js', 'portfolio.js']) vm.runInContext(fs.readFileSync(new URL(f, www), 'utf8'), ctx);
export const { DEFAULT_ASSETS, Analysis: A } = ctx.window;
export { ctx };

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
let cookie = '', crumb = '';
export async function get(url, h = {}) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...h } }); return { status: r.status, text: await r.text(), headers: r.headers }; }
  catch (e) { return { status: 0, text: String(e) }; }
}
export async function yahooSession() {
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
export async function nasdaq(sym, cls = 'stocks', from = '1990-01-01') {
  const r = await get(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${cls}&fromdate=${from}&limit=99999`, { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
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
export const PROXY = { gold: 'GLD', water: 'CGW', china: 'MCHI', copx: 'COPX', sp500: 'SPY', japan: 'EWJ', copper: 'CPER' };
export async function history(a) {
  const errs = [];
  if (a.yahoo.endsWith('-USD')) { const r = await coinbase(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  const y = await yahoo(a.yahoo); if (!y.err) return y; errs.push(y.err);
  if (!a.yahoo.includes('.') && !a.yahoo.includes('-')) { const r = await nasdaq(a.yahoo); if (!r.err) return r; errs.push(r.err); }
  if (PROXY[a.id]) { const r = await nasdaq(PROXY[a.id], 'etf'); if (!r.err) { r.src = 'Nasdaq ' + PROXY[a.id] + ' (equivalente en EE. UU.)'; return r; } errs.push(r.err); }
  return { err: errs.join(', ') };
}

function rss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
    title: ((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
    date: Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || 0)
  }));
}
/** Titulares de Google Noticias (español e inglés) de los últimos días. */
export async function news(q, days = 7) {
  const qq = encodeURIComponent(q + ` when:${days}d`);
  const a = await get(`https://news.google.com/rss/search?q=${qq}&hl=es&gl=ES&ceid=ES:es`);
  const b = await get(`https://news.google.com/rss/search?q=${qq}&hl=en-US&gl=US&ceid=US:en`);
  return [...(a.status === 200 ? rss(a.text) : []), ...(b.status === 200 ? rss(b.text) : [])].sort((x, y) => y.date - x.date);
}
export async function fearGreed() {
  const s = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' });
  const c = await get('https://api.alternative.me/fng/?limit=1');
  let stocks = null, crypto = null;
  try { if (s.status === 200) stocks = { score: JSON.parse(s.text).fear_and_greed.score }; } catch (e) {}
  try { if (c.status === 200) crypto = { score: +JSON.parse(c.text).data[0].value }; } catch (e) {}
  return { stocks, crypto };
}
