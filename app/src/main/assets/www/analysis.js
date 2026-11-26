// Cálculos de análisis. Funciones puras para poder probarlas fuera de la app.
(function (root) {
  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function rsi(values, n = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  // Cambio porcentual respecto a hace "days" días (usando fechas, no posiciones).
  function changeSince(times, closes, days) {
    if (!closes.length) return null;
    const target = times[times.length - 1] - days * 86400;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] <= target) return closes[closes.length - 1] / closes[i] - 1;
    }
    return null;
  }

  function volatility(closes, n = 60) {
    const r = [];
    for (let i = Math.max(1, closes.length - n); i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
    if (r.length < 5) return null;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
    return Math.sqrt(v * 252);
  }

  // Sentimiento sencillo de titulares (español e inglés). Devuelve -1..1.
  const POS = ['sube', 'suben', 'subida', 'dispara', 'récord', 'record', 'máximos', 'gana', 'ganancias', 'supera', 'mejora',
    'crece', 'crecimiento', 'beneficio', 'alza', 'optimismo', 'compra', 'impulsa', 'rebota', 'fuerte', 'acuerdo',
    'surge', 'soar', 'soars', 'jump', 'jumps', 'rally', 'rallies', 'beat', 'beats', 'gain', 'gains', 'rise', 'rises',
    'upgrade', 'upgrades', 'bullish', 'strong', 'growth', 'profit', 'buy', 'outperform', 'high', 'boost', 'deal', 'approval'];
  const NEG = ['cae', 'caen', 'caída', 'desploma', 'hunde', 'pierde', 'pérdidas', 'baja', 'recorta', 'rebaja', 'miedo',
    'crisis', 'sanciones', 'aranceles', 'investigación', 'demanda', 'multa', 'riesgo', 'temor', 'guerra', 'prohibición',
    'restricciones', 'quiebra', 'despidos', 'burbuja', 'vende', 'ventas masivas', 'alerta', 'débil', 'decepciona',
    'fall', 'falls', 'drop', 'drops', 'plunge', 'plunges', 'slump', 'tumble', 'miss', 'misses', 'downgrade', 'downgrades',
    'bearish', 'weak', 'loss', 'losses', 'lawsuit', 'probe', 'fine', 'ban', 'tariff', 'tariffs', 'sanction', 'sanctions',
    'war', 'fear', 'risk', 'sell', 'selloff', 'sell-off', 'crash', 'bubble', 'cut', 'cuts', 'layoffs', 'warning'];
  const GEO = ['guerra', 'aranceles', 'sanciones', 'taiwán', 'taiwan', 'china', 'rusia', 'ucrania', 'israel', 'irán', 'iran',
    'opep', 'opec', 'exportación', 'export', 'restricciones', 'tariff', 'sanction', 'war', 'elecciones', 'election',
    'reserva federal', 'fed', 'bce', 'tipos de interés', 'inflación', 'inflation', 'rates', 'geopolític', 'conflicto'];

  function headlineScore(title) {
    const t = ' ' + title.toLowerCase().replace(/[.,:;!?¡¿"'()«»]/g, ' ') + ' ';
    let s = 0;
    for (const w of POS) if (t.includes(' ' + w + ' ')) s++;
    for (const w of NEG) if (t.includes(' ' + w + ' ')) s--;
    return Math.max(-1, Math.min(1, s / 2));
  }
  function isGeo(title) {
    const t = title.toLowerCase();
    return GEO.some(w => t.includes(w));
  }

  function newsSentiment(items) {
    if (!items || !items.length) return null;
    const recent = items.slice(0, 30);
    const scores = recent.map(i => headlineScore(i.title));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { avg, pos: scores.filter(s => s > 0).length, neg: scores.filter(s => s < 0).length, n: scores.length };
  }

  /**
   * Junta todas las señales en una orientación.
   * daily: {t:[], c:[]} precios diarios; extra: {news, fearGreed, insiders, funds, filings}
   */
  function evaluate(daily, extra = {}) {
    const reasons = [];
    const alerts = [];
    let score = 0;
    const c = daily.c, t = daily.t;
    const last = c[c.length - 1];
    const s50 = sma(c, 50), s200 = sma(c, 200), r = rsi(c, 14);
    const m = {
      last, sma50: s50[c.length - 1], sma200: s200[c.length - 1], rsi: r[c.length - 1],
      ch1w: changeSince(t, c, 7), ch1m: changeSince(t, c, 30), ch3m: changeSince(t, c, 91),
      ch1y: changeSince(t, c, 365), vol: volatility(c)
    };
    // Máximo y mínimo de 52 semanas.
    const yStart = t[t.length - 1] - 365 * 86400;
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < c.length; i++) if (t[i] >= yStart) { hi = Math.max(hi, c[i]); lo = Math.min(lo, c[i]); }
    m.hi52 = hi; m.lo52 = lo; m.fromHi = last / hi - 1;

    const add = (pts, text, kind) => { score += pts; reasons.push({ pts, text, kind: kind || (pts > 0 ? 'g' : pts < 0 ? 'r' : 'y') }); };

    if (m.sma200) {
      if (last > m.sma200) add(1, 'El precio está por encima de su media de 200 días: la tendencia de fondo es alcista.');
      else add(-1, 'El precio está por debajo de su media de 200 días: la tendencia de fondo es bajista.');
      const dist = last / m.sma200 - 1;
      if (dist > 0.35) add(-1, `Está un ${pct(dist)} por encima de su media de 200 días. Subida muy estirada: riesgo de FOMO y de corrección.`);
      else if (dist < -0.25) add(0.5, `Está un ${pct(-dist)} por debajo de su media de 200 días: barato respecto a su historia reciente, aunque la tendencia no ha girado.`, 'y');
    } else {
      reasons.push({ pts: 0, kind: 'y', text: 'Hay menos de 200 días de historial: el análisis de tendencia es limitado.' });
    }
    if (m.sma50 && m.sma200) {
      // Cruces recientes de medias (últimos 20 días).
      for (let i = c.length - 20; i < c.length; i++) {
        if (i < 1 || !s200[i - 1]) continue;
        const before = s50[i - 1] - s200[i - 1], now = s50[i] - s200[i];
        if (before <= 0 && now > 0) { alerts.push({ kind: 'g', text: 'Cruce dorado reciente: la media de 50 días ha superado a la de 200.' }); break; }
        if (before >= 0 && now < 0) { alerts.push({ kind: 'r', text: 'Cruce de la muerte reciente: la media de 50 días ha caído por debajo de la de 200.' }); break; }
      }
      if (m.sma50 > m.sma200) add(0.5, 'La media de 50 días está por encima de la de 200 (impulso positivo).');
      else add(-0.5, 'La media de 50 días está por debajo de la de 200 (impulso negativo).');
    }
    if (m.rsi != null) {
      if (m.rsi >= 75) add(-1, `RSI de ${m.rsi.toFixed(0)}: sobrecompra fuerte. Suele ser mal momento para comprar con prisa.`);
      else if (m.rsi >= 70) add(-0.5, `RSI de ${m.rsi.toFixed(0)}: zona de sobrecompra.`);
      else if (m.rsi <= 25) add(1, `RSI de ${m.rsi.toFixed(0)}: sobreventa fuerte. Históricamente zona de posibles rebotes.`);
      else if (m.rsi <= 30) add(0.5, `RSI de ${m.rsi.toFixed(0)}: zona de sobreventa.`);
      else reasons.push({ pts: 0, kind: 'y', text: `RSI de ${m.rsi.toFixed(0)}: zona neutral.` });
    }
    if (m.fromHi < -0.3) reasons.push({ pts: 0, kind: 'y', text: `Está un ${pct(-m.fromHi)} por debajo de su máximo del último año.` });
    if (m.ch1w != null && Math.abs(m.ch1w) > 0.08)
      alerts.push({ kind: m.ch1w > 0 ? 'g' : 'r', text: `Movimiento fuerte esta semana: ${signed(m.ch1w)}.` });

    const ns = extra.news ? newsSentiment(extra.news) : null;
    if (ns) {
      if (ns.avg > 0.15) add(0.5, `Tono de las noticias positivo (${ns.pos} titulares positivos y ${ns.neg} negativos de ${ns.n}).`);
      else if (ns.avg < -0.15) add(-0.5, `Tono de las noticias negativo (${ns.neg} titulares negativos y ${ns.pos} positivos de ${ns.n}).`);
      else reasons.push({ pts: 0, kind: 'y', text: `Tono de las noticias mixto (${ns.pos} positivos, ${ns.neg} negativos de ${ns.n}).` });
    }
    const fg = extra.fearGreed;
    if (fg && fg.score != null) {
      if (fg.score >= 75) add(-1, `Índice de miedo y codicia en ${Math.round(fg.score)} (codicia extrema): mucho FOMO en el mercado. Conviene prudencia.`);
      else if (fg.score >= 60) add(-0.25, `Índice de miedo y codicia en ${Math.round(fg.score)} (codicia).`);
      else if (fg.score <= 25) add(1, `Índice de miedo y codicia en ${Math.round(fg.score)} (miedo extremo): los mejores momentos de compra suelen darse con miedo.`);
      else if (fg.score <= 40) add(0.25, `Índice de miedo y codicia en ${Math.round(fg.score)} (miedo).`);
      else reasons.push({ pts: 0, kind: 'y', text: `Índice de miedo y codicia en ${Math.round(fg.score)} (neutral).` });
    }
    const ins = extra.insiders;
    if (ins && ins.length) {
      const since = Date.now() - 120 * 86400000;
      let buys = 0, sells = 0, buyVal = 0, sellVal = 0;
      for (const f of ins) {
        if (new Date(f.date).getTime() < since) continue;
        for (const tx of f.tx || []) {
          if (tx.code === 'P') { buys++; buyVal += (tx.shares || 0) * (tx.price || 0); }
          if (tx.code === 'S') { sells++; sellVal += (tx.shares || 0) * (tx.price || 0); }
        }
      }
      if (buys > 0) add(1, `Directivos han comprado acciones en el mercado en los últimos 4 meses (${buys} compras, ${money(buyVal)}). Es una de las señales más fiables.`);
      if (sells > 0 && sellVal > 5 * Math.max(buyVal, 1) && sellVal > 20e6)
        add(-0.5, `Directivos han vendido ${money(sellVal)} en los últimos 4 meses. Muchas ventas son planificadas, pero es un dato a vigilar.`);
      else if (sells > 0) reasons.push({ pts: 0, kind: 'y', text: `Hay ${sells} ventas de directivos en 4 meses (${money(sellVal)}), habitual por planes de retribución.` });
    }
    const funds = extra.funds;
    if (funds && funds.length) {
      const upN = funds.filter(f => f.status === 'nueva' || f.status === 'aumenta').length;
      const downN = funds.filter(f => f.status === 'reduce' || f.status === 'vende todo').length;
      if (upN > downN) add(0.5, `Grandes fondos: ${upN} lo compran o aumentan y ${downN} lo reducen en su último informe 13F.`);
      else if (downN > upN) add(-0.5, `Grandes fondos: ${downN} lo reducen o venden y ${upN} lo aumentan en su último informe 13F.`);
      else reasons.push({ pts: 0, kind: 'y', text: `Grandes fondos: movimientos equilibrados (${upN} suben, ${downN} bajan).` });
    }
    if (extra.filings && extra.filings.length) {
      const week = Date.now() - 8 * 86400000;
      const recent = extra.filings.filter(f => new Date(f.date).getTime() >= week);
      if (recent.length) alerts.push({ kind: 'y', text: `Publicación oficial reciente: ${recent.map(f => f.form + ' (' + f.date + ')').join(', ')}. Revisa la pestaña Oficial.` });
    }
    if (extra.geoNews && extra.geoNews.length) {
      const neg = extra.geoNews.filter(n => headlineScore(n.title) < 0).length;
      if (neg >= 4) alerts.push({ kind: 'r', text: `Hay ${neg} titulares geopolíticos negativos recientes sobre sus temas. Revisa la pestaña Geopolítica.` });
    }

    let label, kind;
    if (score >= 2) { label = 'Señales favorables: posible zona de compra'; kind = 'g'; }
    else if (score >= 0.75) { label = 'Ligeramente favorable: mantener o comprar poco a poco'; kind = 'g'; }
    else if (score > -0.75) { label = 'Neutral: mantener y vigilar'; kind = 'y'; }
    else if (score > -2) { label = 'Precaución: no perseguir el precio'; kind = 'r'; }
    else { label = 'Señales negativas: valorar reducir o proteger ganancias'; kind = 'r'; }

    return { score, label, kind, reasons, alerts, metrics: m, news: ns };
  }

  function pct(x) { return (x * 100).toFixed(0) + '%'; }
  function signed(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + ' mil M$';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' M$';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + ' mil $';
    return v.toFixed(0) + ' $';
  }

  const api = { sma, rsi, changeSince, volatility, headlineScore, isGeo, newsSentiment, evaluate, signed };
  root.Analysis = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
