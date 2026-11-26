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

    const cats = new Set();
    const add = (pts, text, kind) => { score += pts; reasons.push({ pts, text, kind: kind || (pts > 0 ? 'g' : pts < 0 ? 'r' : 'y') }); };

    if (m.sma200) {
      cats.add('tendencia');
      if (last > m.sma200) add(1, 'El precio está por encima de su media de 200 días: la tendencia de fondo es alcista.');
      else add(-1, 'El precio está por debajo de su media de 200 días: la tendencia de fondo es bajista.');
      // Pesos revisados con la prueba histórica de noviembre de 2026 (19 activos, 2016-2026, dos periodos por separado):
      // estar muy por encima de la media NO anticipó peores resultados; estar muy por debajo sí.
      const dist = last / m.sma200 - 1;
      if (dist > 0.35) reasons.push({ pts: 0, kind: 'y', text: `Está un ${pct(dist)} por encima de su media de 200 días. Subida muy estirada: históricamente no ha sido motivo para vender, pero las sacudidas suelen ser fuertes. Mejor no comprar de golpe.` });
      else if (dist < -0.25) reasons.push({ pts: 0, kind: 'y', text: `Está un ${pct(-dist)} por debajo de su media de 200 días. Aunque parezca barato, en la prueba histórica las caídas así no solían rebotar antes que otras: no es por sí solo motivo de compra.` });
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
      cats.add('rsi');
      // En la prueba histórica, un RSI muy alto fue señal de fuerza (siguió subiendo más de lo normal), no de venta,
      // y la sobreventa no fue una señal de compra fiable.
      if (m.rsi >= 75) reasons.push({ pts: 0, kind: 'y', text: `RSI de ${m.rsi.toFixed(0)}: impulso muy fuerte. En la prueba histórica no fue señal de venta: a 3 meses solía seguir subiendo, aunque con sacudidas.` });
      else if (m.rsi >= 70) reasons.push({ pts: 0, kind: 'y', text: `RSI de ${m.rsi.toFixed(0)}: zona de sobrecompra. Históricamente no ha sido una señal de venta fiable por sí sola.` });
      else if (m.rsi <= 30) reasons.push({ pts: 0, kind: 'y', text: `RSI de ${m.rsi.toFixed(0)}: sobreventa. Puede rebotar, pero en la prueba histórica no fue una señal de compra fiable si la tendencia es bajista.` });
      else reasons.push({ pts: 0, kind: 'y', text: `RSI de ${m.rsi.toFixed(0)}: zona neutral.` });
    }
    if (m.fromHi < -0.3) reasons.push({ pts: 0, kind: 'y', text: `Está un ${pct(-m.fromHi)} por debajo de su máximo del último año.` });
    if (m.ch1w != null && Math.abs(m.ch1w) > 0.08)
      alerts.push({ kind: m.ch1w > 0 ? 'g' : 'r', text: `Movimiento fuerte esta semana: ${signed(m.ch1w)}.` });

    const ns = extra.news ? newsSentiment(extra.news) : null;
    if (ns) {
      cats.add('noticias');
      if (ns.avg > 0.15) add(0.5, `Tono de las noticias positivo (${ns.pos} titulares positivos y ${ns.neg} negativos de ${ns.n}).`);
      else if (ns.avg < -0.15) add(-0.5, `Tono de las noticias negativo (${ns.neg} titulares negativos y ${ns.pos} positivos de ${ns.n}).`);
      else reasons.push({ pts: 0, kind: 'y', text: `Tono de las noticias mixto (${ns.pos} positivos, ${ns.neg} negativos de ${ns.n}).` });
    }
    const fg = extra.fearGreed;
    if (fg && fg.score != null) {
      cats.add('sentimiento');
      if (fg.score >= 75) add(-1, `Índice de miedo y codicia en ${Math.round(fg.score)} (codicia extrema): mucho FOMO en el mercado. Conviene prudencia.`);
      else if (fg.score >= 60) add(-0.25, `Índice de miedo y codicia en ${Math.round(fg.score)} (codicia).`);
      else if (fg.score <= 25) add(1, `Índice de miedo y codicia en ${Math.round(fg.score)} (miedo extremo): los mejores momentos de compra suelen darse con miedo.`);
      else if (fg.score <= 40) add(0.25, `Índice de miedo y codicia en ${Math.round(fg.score)} (miedo).`);
      else reasons.push({ pts: 0, kind: 'y', text: `Índice de miedo y codicia en ${Math.round(fg.score)} (neutral).` });
    }
    const ins = extra.insiders;
    if (ins && ins.length) {
      cats.add('directivos');
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
      cats.add('fondos');
      const upN = funds.filter(f => f.status === 'nueva' || f.status === 'aumenta').length;
      const downN = funds.filter(f => f.status === 'reduce' || f.status === 'vende todo').length;
      const lag = funds[0].period ? ` Pista retrasada: posiciones a ${funds[0].period}, publicadas hasta 45 días después.` : ' Pista retrasada (informes trimestrales).';
      if (upN > downN) add(0.25, `Grandes fondos: ${upN} lo compran o aumentan y ${downN} lo reducen.${lag}`);
      else if (downN > upN) add(-0.25, `Grandes fondos: ${downN} lo reducen o venden y ${upN} lo aumentan.${lag}`);
      else reasons.push({ pts: 0, kind: 'y', text: `Grandes fondos: movimientos equilibrados (${upN} suben, ${downN} bajan).${lag}` });
    }
    const val = extra.valuation;
    if (val) {
      cats.add('valoracion');
      if (val.eps != null && val.eps <= 0) add(-0.5, 'La empresa tiene pérdidas en los últimos 12 meses: no hay PER y el precio depende de expectativas futuras.');
      else if (val.pe && val.medianPe) {
        const ratio = val.pe / val.medianPe;
        if (ratio > 1.3) add(-0.75, `PER de ${val.pe.toFixed(0)}, un ${pct(ratio - 1)} por encima de su media de los últimos años (${val.medianPe.toFixed(0)}): cara respecto a su historia.`);
        else if (ratio < 0.8) add(0.75, `PER de ${val.pe.toFixed(0)}, un ${pct(1 - ratio)} por debajo de su media de los últimos años (${val.medianPe.toFixed(0)}): barata respecto a su historia.`);
        else reasons.push({ pts: 0, kind: 'y', text: `PER de ${val.pe.toFixed(0)}, en línea con su media de los últimos años (${val.medianPe.toFixed(0)}).` });
      } else if (val.pe) reasons.push({ pts: 0, kind: 'y', text: `PER de ${val.pe.toFixed(0)} (sin historial suficiente para comparar).` });
      if (val.growth != null) {
        if (val.growth > 0.25) add(0.5, `Las ventas crecen un ${pct(val.growth)} interanual: el negocio acompaña.`);
        else if (val.growth < 0) add(-0.5, `Las ventas caen un ${pct(-val.growth)} interanual.`);
        else reasons.push({ pts: 0, kind: 'y', text: `Las ventas crecen un ${pct(val.growth)} interanual.` });
      }
      if (val.peg != null) reasons.push({ pts: 0, kind: val.peg < 1 ? 'g' : val.peg > 3 ? 'r' : 'y', text: `PEG (PER dividido por crecimiento) de ${val.peg.toFixed(1)}: ${val.peg < 1 ? 'precio razonable para lo que crece' : val.peg > 3 ? 'se paga mucho por cada punto de crecimiento' : 'moderado'}.` });
    }
    const rules = extra.rules;
    if (rules) {
      if (rules.buyBelow && last <= rules.buyBelow) alerts.push({ kind: 'g', text: `Ha bajado de tu precio de compra objetivo (${rules.buyBelow}).` });
      if (rules.sellAbove && last >= rules.sellAbove) alerts.push({ kind: 'g', text: `Ha alcanzado tu precio objetivo de venta (${rules.sellAbove}).` });
      if (rules.stopBelow && last <= rules.stopBelow) alerts.push({ kind: 'r', text: `Ha caído por debajo de tu precio de salida (${rules.stopBelow}).` });
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

    // Datos anticipadores (no se pueden comprobar con el pasado salvo el MVRV: peso pequeño y avisado).
    const ld = extra.leading;
    if (ld) {
      if (ld.revUp != null && ld.revDown != null && ld.revUp + ld.revDown >= 2) {
        cats.add('analistas');
        if (ld.revUp >= 2 * Math.max(1, ld.revDown)) add(0.25, `Los analistas han subido sus previsiones de beneficio en las últimas 4 semanas (${ld.revUp} suben, ${ld.revDown} bajan). Suele anticipar buenas noticias; dato aún no comprobado con su historial.`);
        else if (ld.revDown >= 2 * Math.max(1, ld.revUp)) add(-0.25, `Los analistas han bajado sus previsiones de beneficio en las últimas 4 semanas (${ld.revDown} bajan, ${ld.revUp} suben). Dato aún no comprobado con su historial.`);
        else reasons.push({ pts: 0, kind: 'y', text: `Revisiones de previsiones equilibradas en 4 semanas (${ld.revUp} suben, ${ld.revDown} bajan).` });
      }
      if (ld.short && ld.short.dtc != null) {
        const ch = ld.short.prev ? ld.short.interest / ld.short.prev - 1 : null;
        reasons.push({ pts: 0, kind: ld.short.dtc > 5 ? 'r' : 'y', text: `Posiciones cortas (apuestas a la baja): ${ld.short.dtc.toFixed(1).replace('.', ',')} días de volumen para cerrarlas${ch != null ? `, ${ch >= 0 ? 'suben' : 'bajan'} un ${pct(Math.abs(ch))} en dos semanas` : ''}. ${ld.short.dtc > 5 ? 'Muchas: hay inversores que esperan caídas, aunque también puede provocar subidas bruscas si se cierran.' : 'Nivel normal.'}` });
      }
      if (ld.mvrv != null) {
        cats.add('onchain');
        if (ld.mvrvAsset === 'btc' && ld.mvrv > 3.5) add(-0.5, `MVRV on-chain de ${ld.mvrv.toFixed(2).replace('.', ',')}: los tenedores acumulan mucha ganancia sin vender. En el pasado, por encima de 3,5 casi siempre estuvo cerca de un techo.`);
        else if (ld.mvrvAsset === 'btc' && ld.mvrv < 1) add(0.5, `MVRV on-chain de ${ld.mvrv.toFixed(2).replace('.', ',')}: de media, los tenedores están en pérdidas. En el pasado, por debajo de 1 fue zona de compra a medio plazo.`);
        else reasons.push({ pts: 0, kind: 'y', text: `MVRV on-chain de ${ld.mvrv.toFixed(2).replace('.', ',')}: zona intermedia${ld.mvrvAsset === 'btc' ? ' (en el pasado solo los extremos, por debajo de 1 o por encima de 3,5, anticiparon algo)' : ' (en Ethereum no ha anticipado bien en el pasado)'}.` });
      }
    }

    let label, kind;
    if (score >= 2) { label = 'Señales favorables: posible zona de compra'; kind = 'g'; }
    else if (score >= 0.75) { label = 'Ligeramente favorable: mantener o comprar poco a poco'; kind = 'g'; }
    else if (score > -0.75) { label = 'Neutral: mantener y vigilar'; kind = 'y'; }
    else if (score > -2) { label = 'Precaución: no perseguir el precio'; kind = 'r'; }
    else { label = 'Señales negativas: valorar reducir o proteger ganancias'; kind = 'r'; }

    // Confianza: cuántos tipos de datos hay y cuánto coinciden entre sí.
    const plus = reasons.filter(r => r.pts > 0).reduce((a, r) => a + r.pts, 0);
    const minus = -reasons.filter(r => r.pts < 0).reduce((a, r) => a + r.pts, 0);
    const agreement = plus + minus ? Math.abs(plus - minus) / (plus + minus) : 0;
    const possible = extra.valuation !== undefined ? 7 : 5;
    const coverage = Math.min(1, cats.size / possible);
    const cScore = agreement * 0.6 + coverage * 0.4;
    const confidence = {
      level: cScore >= 0.65 ? 'Alta' : cScore >= 0.4 ? 'Media' : 'Baja',
      text: `${reasons.filter(r => r.pts > 0).length} señales a favor y ${reasons.filter(r => r.pts < 0).length} en contra; ${cats.size} de ${possible} tipos de datos disponibles.` +
        (agreement < 0.3 ? ' Las señales se contradicen, así que la orientación es débil.' : '')
    };
    // Régimen de mercado: según la prueba histórica, la señal ha sido mucho más fiable con el mercado bajista.
    if (extra.regime) {
      const rg = extra.regime, lv = ['Baja', 'Media', 'Alta'];
      reasons.push({ pts: 0, kind: rg.r === 'alcista' ? 'g' : rg.r === 'bajista' ? 'r' : 'y', text: `Mercado en general (${rg.ref}): ${rg.r}.` });
      const i = lv.indexOf(confidence.level);
      if (rg.r === 'bajista' && kind !== 'y' && i < 2) { confidence.level = lv[i + 1]; confidence.text += ' Sube un nivel: con el mercado bajista, esta señal acertó bastante más en el pasado.'; }
      if (rg.r === 'alcista' && kind === 'r' && i > 0) { confidence.level = lv[i - 1]; confidence.text += ' Baja un nivel: con el mercado alcista, las señales de precaución fallaron a menudo en el pasado.'; }
    }
    const top = reasons.filter(r => r.pts !== 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 2)
      .map(r => r.text.split(/\. /)[0].replace(/\.$/, ''));
    const why = top.length ? 'Lo que más pesa: ' + top.join('; ') + '.' : '';
    // Escenario más probable a corto plazo según tendencia, impulso y sobrecompra/sobreventa.
    const sc = { risks: [], watch: [] };
    const up = m.sma200 ? last > m.sma200 : (m.ch3m || 0) > 0;
    const f = v => v == null ? '–' : v >= 100 ? v.toFixed(0) : v.toFixed(2);
    if (up && m.rsi != null && m.rsi >= 70) sc.text = `Tendencia alcista con mucho impulso: en situaciones así, históricamente solía seguir subiendo en los meses siguientes, pero con sacudidas fuertes. Si compras, mejor por partes y no todo de golpe.`;
    else if (up && (m.ch1m || 0) < -0.08) sc.text = `Corrección dentro de una tendencia alcista: si aguanta por encima de la media de 200 días (${f(m.sma200)}), suele ser zona de oportunidad; si la pierde, la caída puede alargarse.`;
    else if (up) sc.text = `Tendencia alcista sana: lo más probable es que continúe, con altibajos normales. Riesgo principal: noticias o datos que rompan el impulso.`;
    else if (m.rsi != null && m.rsi <= 30) sc.text = `Tendencia bajista con sobreventa: es probable un rebote técnico a corto plazo, pero la tendencia no cambia hasta que recupere la media de 200 días (${f(m.sma200)}).`;
    else if (m.sma50 && m.sma50 > m.sma200) sc.text = `Precio por debajo de la media de 200 días pero con la de 50 por encima: fase de duda. Lo más probable es que se mueva de lado hasta que rompa ${f(m.sma200)} hacia arriba o hacia abajo.`;
    else sc.text = `Tendencia bajista: lo más probable a corto plazo es que siga débil. La señal de cambio sería recuperar la media de 200 días (${f(m.sma200)}).`;
    sc.levels = { support: m.lo52, resistance: m.hi52, sma200: m.sma200 };
    reasons.filter(r => r.pts < 0).sort((a, b) => a.pts - b.pts).slice(0, 3).forEach(r => sc.risks.push(r.text.split(/\. /)[0].replace(/\.$/, '')));
    // Posición en la barra de -1 (vender) a +1 (comprar).
    const bar = Math.max(-1, Math.min(1, score / 4));
    return { score, label, kind, reasons, alerts, metrics: m, news: ns, confidence, why, scenario: sc, bar };
  }

  function pct(x) { return (x * 100).toFixed(0) + '%'; }
  function signed(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + ' mil M$';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' M$';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + ' mil $';
    return v.toFixed(0) + ' $';
  }

  const IMPACT = ['resultados', 'beneficio', 'ingresos', 'previsiones', 'guidance', 'earnings', 'revenue', 'forecast', 'outlook',
    'adquisición', 'acquisition', 'compra de', 'fusión', 'merger', 'dividendo', 'dividend', 'recompra', 'buyback', 'investigación',
    'probe', 'demanda', 'lawsuit', 'multa', 'sanción', 'arancel', 'tariff', 'export', 'prohib', 'ban', 'ceo', 'dimite', 'resign',
    'rebaja', 'downgrade', 'mejora la recomendación', 'upgrade', 'precio objetivo', 'price target', 'contrato', 'contract', 'acuerdo',
    'deal', 'quiebra', 'bankrupt', 'regulación', 'regulator', 'sec ', 'etf', 'hackeo', 'hack', 'récord', 'record', 'split'];
  /** Solo los titulares que cambian algo: hechos con impacto o tono fuerte, sin repeticiones. */
  function importantNews(items, max = 5) {
    if (!items) return [];
    const week = Date.now() - 7 * 86400000;
    const seen = [];
    const out = [];
    for (const n of items) {
      if (n.date < week) continue;
      const t = n.title.toLowerCase();
      const impact = IMPACT.some(w => t.includes(w));
      const sc = headlineScore(n.title);
      if (!impact && Math.abs(sc) < 0.5) continue;
      const words = new Set(t.split(/\W+/).filter(w => w.length > 3));
      if (seen.some(s => [...words].filter(w => s.has(w)).length >= Math.min(4, words.size * 0.5))) continue;
      seen.push(words);
      out.push({ ...n, score: sc });
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * "¿Qué pasó antes en situaciones parecidas?": recorre el historial semanal y busca semanas con la misma
   * tendencia (precio frente a su media de 40 semanas ≈ 200 días) y la misma zona de RSI, y mira el precio 3 meses después.
   */
  function historicalOdds(w, horizon = 13) {
    const c = w.c;
    if (!c || c.length < 80) return null;
    const s40 = sma(c, 40), r = rsi(c, 14);
    const zone = v => v == null ? null : v < 30 ? 0 : v < 50 ? 1 : v < 70 ? 2 : 3;
    const ZN = ['sobreventa', 'débil', 'fuerte', 'sobrecompra'];
    const i0 = c.length - 1;
    if (s40[i0] == null || r[i0] == null) return null;
    const trend = c[i0] > s40[i0], z = zone(r[i0]);
    const fwd = [];
    let lastUsed = -99;
    for (let i = 40; i < c.length - horizon; i++) {
      if (s40[i] == null || r[i] == null) continue;
      if ((c[i] > s40[i]) !== trend || zone(r[i]) !== z) continue;
      if (i - lastUsed < 4) continue; // semanas casi seguidas cuentan como un solo caso
      lastUsed = i;
      fwd.push(c[i + horizon] / c[i] - 1);
    }
    const n = fwd.length;
    const state = `tendencia ${trend ? 'alcista' : 'bajista'} y RSI semanal en zona ${ZN[z]}`;
    if (n < 6) return { n, state, text: `Situación actual: ${state}. Hay pocos casos parecidos en su historial (${n}) para sacar conclusiones.` };
    const sorted = fwd.slice().sort((a, b) => a - b);
    const q = p => sorted[Math.min(n - 1, Math.floor(p * n))];
    const upPct = fwd.filter(x => x > 0).length / n;
    return { n, state, upPct, median: q(0.5), bad: q(0.25), good: q(0.75),
      text: `En su historial hubo ${n} momentos con ${state}. Tres meses después subía en el ${(upPct * 100).toFixed(0)}% de los casos. Lo típico fue un ${signed(q(0.5))}; en el 25% peor de los casos, ${signed(q(0.25))} o menos, y en el 25% mejor, ${signed(q(0.75))} o más.` };
  }

  /**
   * Rango probable de precio a 1, 3 y 12 meses a partir de su volatilidad real (no de su subida pasada):
   * se mide cuánto se mueve semana a semana en los últimos 3 años y se proyecta sin suponer que sube ni que baja.
   * 80% de probabilidad de terminar dentro del rango si el comportamiento se parece al de estos años.
   */
  function priceRanges(w, price, calib) {
    const c = w && w.c;
    if (!c || c.length < 30 || !(price > 0)) return null;
    // Últimos 3 años. La separación real entre puntos se mide con las fechas: a veces Yahoo devuelve datos mensuales
    // aunque se pidan semanales, y tratarlos como semanas inflaba los rangos al doble.
    const t = w.t || [];
    const t0 = t.length === c.length ? t[t.length - 1] - 3 * 365 * 86400 : null;
    let start = Math.max(1, c.length - 156);
    if (t0 != null) { start = 1; while (start < c.length - 1 && t[start - 1] < t0) start++; }
    const lr = [], gaps = [];
    for (let i = start; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) {
      const dt = t.length === c.length ? (t[i] - t[i - 1]) / 86400 : 7;
      if (dt < 3) continue; // punto duplicado de la semana en curso
      lr.push(Math.max(-0.7, Math.min(0.7, Math.log(c[i] / c[i - 1])))); gaps.push(dt);
    }
    if (lr.length < 26) return null;
    const step = gaps.slice().sort((x, y) => x - y)[gaps.length >> 1] || 7;
    const m = lr.reduce((x, y) => x + y, 0) / lr.length;
    const sdW = Math.sqrt(lr.reduce((x, y) => x + (y - m) ** 2, 0) / (lr.length - 1) * 7 / step);
    const z = 1.2816; // percentiles 10 y 90
    const out = [];
    for (const [weeks, label] of [[4, '1 mes'], [13, '3 meses'], [52, '12 meses']]) {
      const sd = sdW * Math.sqrt(weeks);
      // Si hay calibración (medida en su propio historial), se usan los percentiles 10 y 90 reales en vez de la campana teórica.
      // Solo si hay bastantes casos independientes; a 12 meses se limita para no extrapolar rachas pasadas.
      // La prueba sin mirar al futuro (scripts/ml_eval.py, 1.717 puntos) mostró que calibrar con el propio historial
      // empeoraba los rangos en 16-17 de 19 activos: se usa la campana simple, que acertó el 80-81%.
      const k = null;
      const lim = weeks === 52 ? 1.8 : 2.5;
      const z0 = weeks === 52 ? 1.45 : z; // a 12 meses la prueba histórica dio 75% de aciertos con 1,28: se amplía
      const zl = k ? Math.max(-lim, Math.min(-0.5, k.q10)) : -z0, zh = k ? Math.min(lim, Math.max(0.5, k.q90)) : z0;
      const low = price * Math.exp(zl * sd), high = price * Math.exp(zh * sd);
      out.push({ weeks, label, low, mid: price, high, lowPct: low / price - 1, midPct: 0, highPct: high / price - 1, volYear: sdW * Math.sqrt(52), years: Math.round(lr.length * step / 365), calibrated: !!k, coverage: k ? k.coverage : null });
    }
    return out;
  }

  /**
   * Prueba histórica ("backtest") con el historial diario completo de un activo.
   * Recalcula la orientación de la app cada semana usando SOLO los datos que había en ese momento
   * (precio, medias, RSI; las noticias, el sentimiento y los directivos de entonces no están disponibles)
   * y mira qué pasó después. También comprueba si el precio acabó dentro de los rangos que la app habría dado.
   */
  const BUCKETS = [['buy', 'Comprar', s => s >= 2], ['acc', 'Acumular', s => s >= 0.75 && s < 2], ['hold', 'Mantener', s => s > -0.75 && s < 0.75], ['caut', 'Precaución', s => s > -2 && s <= -0.75], ['sell', 'Reducir', s => s <= -2]];
  function bucketOf(score) { return BUCKETS.find(b => b[2](score))[0]; }
  function backtest(daily, opts = {}) {
    const t = daily.t, c = daily.c, n = c.length;
    const step = opts.step || 5, H = opts.horizon || 63;
    if (n < 400) return null;
    const pts = [];
    for (let i = 260; i < n; i += step) {
      const a = Math.max(0, i - 399);
      const ev = evaluate({ t: t.slice(a, i + 1), c: c.slice(a, i + 1) });
      // Rangos con la volatilidad semanal de los 3 años anteriores (semanas = cada 5 sesiones).
      const wk = []; for (let j = i; j >= Math.max(0, i - 780); j -= 5) wk.unshift(c[j]);
      let sdW = null;
      if (wk.length >= 30) {
        const lr = []; for (let j = 1; j < wk.length; j++) lr.push(Math.max(-0.7, Math.min(0.7, Math.log(wk[j] / wk[j - 1]))));
        const m = lr.reduce((x, y) => x + y, 0) / lr.length; sdW = Math.sqrt(lr.reduce((x, y) => x + (y - m) ** 2, 0) / (lr.length - 1));
      }
      pts.push({ i, score: ev.score, b: bucketOf(ev.score), f21: i + 21 < n ? c[i + 21] / c[i] - 1 : null, f63: i + 63 < n ? c[i + 63] / c[i] - 1 : null, f126: i + 126 < n ? c[i + 126] / c[i] - 1 : null, f252: i + 252 < n ? c[i + 252] / c[i] - 1 : null, sdW });
    }
    const key = H === 21 ? 'f21' : H === 126 ? 'f126' : 'f63';
    const stats = list => {
      const v = list.map(p => p[key]).filter(x => x != null); const k = v.length;
      if (!k) return { n: 0 };
      const srt = v.slice().sort((x, y) => x - y);
      return { n: k, indep: Math.max(1, Math.round(k * step / H)), up: v.filter(x => x > 0).length / k, avg: v.reduce((x, y) => x + y, 0) / k, med: srt[Math.floor(k / 2)], p25: srt[Math.floor(k * 0.25)], p75: srt[Math.floor(k * 0.75)] };
    };
    const base = stats(pts);
    const byBucket = {}; BUCKETS.forEach(([k]) => byBucket[k] = stats(pts.filter(p => p.b === k)));
    const favorable = stats(pts.filter(p => p.score >= 0.75)), unfavorable = stats(pts.filter(p => p.score <= -0.75));
    // Estrategia: estar invertido salvo cuando la señal es de precaución o reducir; se revisa cada semana. Coste 0,2% por cambio.
    let eq = 1, bh = 1, peakE = 1, peakB = 1, ddE = 0, ddB = 0, inMkt = 0, switches = 0, prevIn = true;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], j0 = p.i, j1 = Math.min(n - 1, k + 1 < pts.length ? pts[k + 1].i : n - 1);
      const inside = p.score > -0.75;
      if (inside !== prevIn) { eq *= 0.998; switches++; prevIn = inside; }
      for (let j = j0 + 1; j <= j1; j++) {
        const r = c[j] / c[j - 1];
        bh *= r; if (inside) { eq *= r; inMkt++; }
        peakE = Math.max(peakE, eq); peakB = Math.max(peakB, bh);
        ddE = Math.min(ddE, eq / peakE - 1); ddB = Math.min(ddB, bh / peakB - 1);
      }
    }
    const days = Math.max(1, (t[n - 1] - t[pts[0].i]) / 86400), yrs = days / 365.25;
    const strategy = { from: t[pts[0].i], years: yrs, cagr: Math.pow(eq, 1 / yrs) - 1, bhCagr: Math.pow(bh, 1 / yrs) - 1, dd: ddE, bhDd: ddB, timeIn: inMkt / Math.max(1, n - 1 - pts[0].i), switches };
    // Rangos: cuántas veces el precio acabó dentro del rango del 80% y percentiles reales para calibrarlos.
    const calib = {};
    for (const [weeks, f] of [[4, 'f21'], [13, 'f63'], [52, 'f252']]) {
      const u = pts.filter(p => p.sdW && p[f] != null).map(p => Math.log(1 + p[f]) / (p.sdW * Math.sqrt(weeks))).sort((x, y) => x - y);
      if (u.length < 10) continue;
      const inside = u.filter(x => Math.abs(x) <= 1.2816).length / u.length;
      calib[weeks] = { n: u.length, indep: Math.round(u.length * step / (weeks * 5)), coverage: inside, q10: u[Math.floor(u.length * 0.1)], q90: u[Math.floor(u.length * 0.9)] };
    }
    return { pts: opts.keepPoints ? pts : undefined, from: t[pts[0].i], to: t[n - 1], points: pts.length, horizon: H, base, byBucket, favorable, unfavorable, strategy, calib };
  }
  /** Texto sencillo con la fiabilidad histórica de la señal actual. */
  function backtestVerdict(bt, score) {
    if (!bt || !bt.base.n) return null;
    const b = bucketOf(score), s = bt.byBucket[b], name = BUCKETS.find(x => x[0] === b)[1];
    if (!s || s.n < 8 || s.indep < 5) return { b, name, text: `En su historial hay muy pocos casos con la señal «${name}» (${s ? s.n : 0} semanas, unos ${s ? s.indep : 0} periodos de 3 meses independientes), así que todavía no se puede medir si funciona en este activo.`, weak: false };
    const edge = s.avg - bt.base.avg;
    const fav = b === 'buy' || b === 'acc', unf = b === 'caut' || b === 'sell';
    const worked = fav ? edge > 0.01 : unf ? edge < -0.01 : true;
    const txt = `Cuando la parte técnica dio «${name}» en este activo (${s.n} semanas desde ${new Date(bt.from * 1000).getFullYear()}), 3 meses después había subido el ${(s.up * 100).toFixed(0)}% de las veces, con una media de ${signed(s.avg)}. En cualquier semana al azar: subía el ${(bt.base.up * 100).toFixed(0)}%, media ${signed(bt.base.avg)}.`;
    return { b, name, edge, worked, weak: !worked && (fav || unf), text: txt + (fav || unf ? (worked ? ' Esta señal ha aportado algo en este activo.' : ' En este activo esta señal NO ha mejorado al azar: tómala con mucha cautela.') : '') };
  }

  function regimeOf(d) {
    const c = d && d.c; if (!c || c.length < 200) return null;
    const n = c.length - 1, s50 = sma(c, 50)[n], s200 = sma(c, 200)[n], up = c[n] > s200, g = s50 > s200;
    return up && g ? 'alcista' : !up && !g ? 'bajista' : 'lateral';
  }
  const api = { regimeOf, backtest, backtestVerdict, bucketOf, BUCKETS, priceRanges, historicalOdds, importantNews, sma, rsi, changeSince, volatility, headlineScore, isGeo, newsSentiment, evaluate, signed };
  root.Analysis = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
