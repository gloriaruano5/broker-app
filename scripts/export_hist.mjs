// Exporta el historial diario de cada activo y la puntuación técnica de la app en cada semana pasada
// (calculada solo con datos hasta esa semana) para que scripts/ml_eval.py compare modelos de predicción.
import fs from 'node:fs';
import { DEFAULT_ASSETS, A, yahooSession, history } from './lib.mjs';

const dir = process.argv[2] || '/tmp/hist';
fs.mkdirSync(dir, { recursive: true });
await yahooSession();
const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const meta = {};
for (const a of DEFAULT_ASSETS) {
  const h = await history(a);
  if (h.err || h.c.length < 400) { console.log(`${a.id}: sin historial (${h.err || h.c.length})`); continue; }
  fs.writeFileSync(`${dir}/${a.id}.csv`, 'date,close\n' + h.t.map((t, i) => `${day(t)},${h.c[i]}`).join('\n') + '\n');
  const bt = A.backtest(h, { keepPoints: true });
  fs.writeFileSync(`${dir}/${a.id}_score.csv`, 'date,score\n' + bt.pts.map(p => `${day(h.t[p.i])},${p.score}`).join('\n') + '\n');
  meta[a.id] = { type: a.type, src: h.src, days: h.c.length };
  console.log(`${a.id}: ${h.c.length} días (${h.src})`);
}
fs.writeFileSync(`${dir}/meta.json`, JSON.stringify(meta));
