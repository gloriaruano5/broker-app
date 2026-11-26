// Diario de señales: cada día guarda, para cada activo, el precio, la orientación de la app y los datos que hoy
// no se pueden comprobar con el pasado (tono de las noticias, miedo y codicia, directivos, grandes fondos).
// Dentro de unos meses permitirá medir si esos datos ayudan de verdad. Solo datos públicos de mercado.
import fs from 'node:fs';
import { DEFAULT_ASSETS, A, yahooSession, history, news, fearGreed } from './lib.mjs';

const today = new Date().toISOString().slice(0, 10);
const sec = (() => { try { return JSON.parse(fs.readFileSync(new URL('../data/sec.json', import.meta.url), 'utf8')); } catch (e) { return null; } })();
await yahooSession();
const fg = await fearGreed();
const row = { date: today, fg: { stocks: fg.stocks ? Math.round(fg.stocks.score) : null, crypto: fg.crypto ? fg.crypto.score : null }, assets: {} };
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const lines = [`Diario ${today} · miedo y codicia bolsa ${row.fg.stocks ?? '–'}, cripto ${row.fg.crypto ?? '–'}`];

for (const a of DEFAULT_ASSETS) {
  const out = {};
  const h = await history(a);
  const n = await news(a.news, 14).catch(() => []);
  const s = a.sec && sec ? sec.assets[a.sec] : null;
  const funds = a.sec && sec && sec.funds ? sec.funds.positions[a.sec] || [] : [];
  const ns = A.newsSentiment(n);
  out.news = { n: n.length, avg: ns ? r2(ns.avg) : null, imp: A.importantNews(n, 5).length };
  if (s) {
    const since = Date.now() - 120 * 86400000; let buys = 0, sells = 0;
    for (const f of s.insiders || []) if (new Date(f.date).getTime() >= since) for (const tx of f.tx || []) { if (tx.code === 'P') buys++; if (tx.code === 'S') sells++; }
    out.ins = { buys, sells };
  }
  if (funds.length) out.funds = { up: funds.filter(f => f.status === 'nueva' || f.status === 'aumenta').length, down: funds.filter(f => f.status === 'reduce' || f.status === 'vende todo').length };
  if (!h.err && h.c.length > 30) {
    const k = Math.max(0, h.c.length - 400), d = { t: h.t.slice(k), c: h.c.slice(k) };
    const fgA = a.type === 'Cripto' ? fg.crypto : fg.stocks;
    const tech = A.evaluate(d), full = A.evaluate(d, { news: n, fearGreed: fgA, insiders: s && s.insiders, filings: s && s.filings, funds });
    Object.assign(out, { px: h.c[h.c.length - 1], pxDate: new Date(h.t[h.t.length - 1] * 1000).toISOString().slice(0, 10), src: h.src.split(' ')[0] + (h.src.includes('equivalente') ? ' ' + h.src.split(' ')[1] : ''), tech: r2(tech.score), score: r2(full.score), b: A.bucketOf(full.score), conf: full.confidence.level });
  } else out.err = h.err || 'historial corto';
  row.assets[a.id] = out;
  lines.push(`${a.name}: ${out.px != null ? `${out.px} (${out.src}) señal ${out.b} ${out.score} [técnica ${out.tech}]` : 'sin precio (' + out.err + ')'} · noticias ${out.news.n} tono ${out.news.avg ?? '–'}`);
}

// Un archivo por año, una línea por día (si se repite el día, se sustituye).
const file = new URL(`../data/diario/${today.slice(0, 4)}.jsonl`, import.meta.url);
fs.mkdirSync(new URL('../data/diario/', import.meta.url), { recursive: true });
const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(`{"date":"${today}"`)) : [];
prev.push(JSON.stringify(row));
fs.writeFileSync(file, prev.join('\n') + '\n');
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
