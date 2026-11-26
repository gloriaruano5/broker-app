// Comprueba con datos reales que cada activo de la app tiene precios, historial, noticias, sentimiento y datos oficiales.
// Se ejecuta en GitHub Actions (workflow "Comprobar datos"). Usa el mismo código de análisis que la app.
import fs from 'node:fs';
import vm from 'node:vm';

const www = new URL('../app/src/main/assets/www/', import.meta.url);
const ctx = { window: {}, globalThis: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['assets.js', 'analysis.js', 'portfolio.js']) vm.runInContext(fs.readFileSync(new URL(f, www), 'utf8'), ctx);
const { DEFAULT_ASSETS, THEMES, Analysis: A, Portfolio: P } = ctx.window;

const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' };
const get = async (url, h = {}) => { try { const r = await fetch(url, { headers: { ...UA, ...h } }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } };

async function chart(sym, range, interval) {
  const r = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`);
  if (r.status !== 200) return { err: r.status };
  const res = JSON.parse(r.text).chart.result?.[0];
  if (!res) return { err: 'vacío' };
  const q = res.indicators.quote[0]; const t = [], c = [];
  (res.timestamp || []).forEach((ts, i) => { const v = q.close?.[i]; if (v != null) { t.push(ts); c.push(v); } });
  return { t, c, meta: res.meta };
}
function rss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
    title: (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') || '',
    date: Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || 0)
  }));
}
async function news(q, days = 14) {
  const qq = encodeURIComponent(q + ` when:${days}d`);
  const a = await get(`https://news.google.com/rss/search?q=${qq}&hl=es&gl=ES&ceid=ES:es`);
  const b = await get(`https://news.google.com/rss/search?q=${qq}&hl=en-US&gl=US&ceid=US:en`);
  return [...(a.status === 200 ? rss(a.text) : []), ...(b.status === 200 ? rss(b.text) : [])].sort((x, y) => y.date - x.date);
}

const fgS = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' });
const fgStocks = fgS.status === 200 ? { score: JSON.parse(fgS.text).fear_and_greed.score } : null;
const fgC = await get('https://api.alternative.me/fng/?limit=1');
const fgCrypto = fgC.status === 200 ? { score: +JSON.parse(fgC.text).data[0].value } : null;
const sec = JSON.parse(fs.readFileSync(new URL('../data/sec.json', import.meta.url), 'utf8'));
const eurusd = await chart('EURUSD=X', '5d', '1d');

const out = [];
out.push(`Miedo y codicia bolsa: ${fgStocks ? Math.round(fgStocks.score) : 'SIN DATOS (' + fgS.status + ')'} · cripto: ${fgCrypto ? fgCrypto.score : 'SIN DATOS'}`);
out.push(`EUR/USD: ${eurusd.meta?.regularMarketPrice ?? 'SIN DATOS'}`);
out.push('');
const themeNews = {};
for (const k of Object.keys(THEMES)) themeNews[k] = (await news(THEMES[k].q, 7)).length;
out.push('Noticias por tema geopolítico (7 días): ' + Object.entries(themeNews).map(([k, n]) => `${k}=${n}`).join(', '));
out.push('');

for (const a of DEFAULT_ASSETS) {
  const d = await chart(a.yahoo, '2y', '1d');
  const w = await chart(a.yahoo, 'max', '1wk');
  const n = await news(a.news);
  const s = a.sec ? sec.assets[a.sec] : null;
  const funds = a.sec ? sec.funds.positions[a.sec] || [] : [];
  const line = [`■ ${a.name} (${a.yahoo})`];
  if (d.err) { line.push(`  PRECIO: ERROR ${d.err}`); out.push(...line); continue; }
  const last = d.c[d.c.length - 1];
  const prevIdx = d.c.length - 2;
  line.push(`  Precio ${last.toFixed(2)} ${d.meta.currency} · cierre anterior ${d.c[prevIdx]?.toFixed(2)} · ${d.c.length} días · historial desde ${w.t ? new Date(w.t[0] * 1000).toISOString().slice(0, 10) : '?'}`);
  let val;
  if (s?.ttm?.eps) val = P.valuation(last, s, w.t ? w : null);
  const ev = A.evaluate(d, { news: n, fearGreed: a.type === 'Cripto' ? fgCrypto : fgStocks, insiders: s?.insiders, filings: s?.filings, funds, valuation: a.type === 'Acción' ? (val || null) : undefined });
  const odds = A.historicalOdds && w.t ? A.historicalOdds(w) : null;
  line.push(`  Noticias 14 d: ${n.length} · importantes: ${A.importantNews(n, 5).length} · tono ${ev.news ? ev.news.avg.toFixed(2) : '–'}`);
  if (a.sec) line.push(`  SEC: ${s ? `${s.filings.length} publicaciones, ${s.insiders.length} formularios de directivos, ${Object.keys(s.fundamentals).length} partidas contables, PER ${val?.pe ? val.pe.toFixed(1) : '–'}` : 'SIN DATOS'} · fondos 13F: ${funds.length}`);
  line.push(`  RSI ${ev.metrics.rsi?.toFixed(0)} · media 200 ${ev.metrics.sma200?.toFixed(2) ?? '–'} · 1 año ${ev.metrics.ch1y != null ? (ev.metrics.ch1y * 100).toFixed(1) + '%' : '–'}`);
  line.push(`  → ${ev.label} (puntuación ${ev.score.toFixed(1)}, confianza ${ev.confidence.level})`);
  if (ev.scenario) line.push(`  Escenario: ${ev.scenario.text}`);
  if (odds) line.push(`  Histórico: ${odds.text}`);
  out.push(...line);
}
const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
