// Sonda manual de Yahoo: muestra las últimas velas de un símbolo e intervalo, para revisar datos raros.
const [sym, range, interval] = (process.env.Q || 'PPFB.DE,max,1mo').split(',');
for (const host of ['query1', 'query2']) {
  const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  console.log(host, r.status);
  if (r.status !== 200) continue;
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0];
  console.log('meta', JSON.stringify({ cur: res.meta.currency, price: res.meta.regularMarketPrice, gran: res.meta.dataGranularity, n: res.timestamp.length }));
  const n = res.timestamp.length;
  for (let i = Math.max(0, n - 30); i < n; i++) console.log(new Date(res.timestamp[i] * 1000).toISOString(), q.open[i], q.high[i], q.low[i], q.close[i]);
  for (let i = 1; i < n; i++) if (res.timestamp[i] <= res.timestamp[i - 1]) console.log('DESORDEN', i, new Date(res.timestamp[i] * 1000).toISOString());
  break;
}
