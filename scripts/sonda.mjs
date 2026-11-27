// Sonda manual: precio actual y media de 50 días de algunos símbolos (Nasdaq), para revisar datos raros.
import { nasdaq } from './lib.mjs';
const from = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
for (const [s, cls] of (process.env.SYMS || 'CPER:etf,COPX:etf').split(',').map(x => x.split(':'))) {
  const h = await nasdaq(s, cls || 'stocks', from);
  if (h.err) { console.log(s, h.err); continue; }
  const c = h.c, n = c.length, sma = c.slice(-50).reduce((a, b) => a + b, 0) / 50;
  console.log(s, 'último', c[n - 1], 'fecha', new Date(h.t[n - 1] * 1000).toISOString().slice(0, 10), 'media50', sma.toFixed(2), 'dif', ((c[n - 1] / sma - 1) * 100).toFixed(1) + '%', 'hace 30 sesiones', c[n - 31]);
}
