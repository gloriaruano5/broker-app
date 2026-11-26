/* Mi Cartera: seguimiento de inversiones. Todo el estado se guarda en el móvil (localStorage). */
(function () {
  'use strict';
  const A = window.Analysis;
  const $ = s => document.querySelector(s);
  const view = $('#view');
  const DISCLAIMER = 'Análisis automático y orientativo. No es asesoramiento financiero: nadie puede predecir el precio. La decisión final es tuya.';

  // ---------- Almacenamiento ----------
  function load(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* lleno: se ignora */ } }
  let assets = load('assets', null) || window.DEFAULT_ASSETS.map(a => Object.assign({ qty: 0, cost: 0 }, a));
  // Si la lista inicial se corrige (símbolos, ISIN), se actualiza en el móvil sin tocar cantidades ni operaciones.
  const DEFAULTS_VERSION = 5;
  if (load('defaultsVersion', 1) < DEFAULTS_VERSION) {
    assets.forEach(a => {
      const def = window.DEFAULT_ASSETS.find(d => d.id === a.id);
      if (def) { ['yahoo', 'alt', 'note', 'isin', 'name', 'resolveIsin'].forEach(k => { if (def[k] !== undefined) a[k] = def[k]; else if (k !== 'name') delete a[k]; }); delete a.resolved; delete a.resolveAt; }
    });
    // Activos nuevos de la lista inicial que aún no estén en el móvil.
    window.DEFAULT_ASSETS.forEach((d, i) => { if (!assets.some(a => a.id === d.id)) assets.splice(Math.min(i, assets.length), 0, Object.assign({ qty: 0, cost: 0 }, d)); });
    save('defaultsVersion', DEFAULTS_VERSION);
    save('assets', assets);
  }
  let settings = Object.assign({ dataRepo: 'gloriaruano5/broker-app', branch: 'main' }, load('settings', {}));
  const persist = () => { save('assets', assets); syncNotif(); };

  // ---------- Red ----------
  let reqId = 0; const pending = {};
  window.__nativeResolve = (id, status, body) => { const p = pending[id]; if (p) { delete pending[id]; p({ status, text: body }); } };
  function http(url, headers) {
    if (window.NativeHttp) {
      return new Promise(res => { const id = 'r' + (++reqId); pending[id] = res; window.NativeHttp.request(id, url, JSON.stringify(headers || {})); });
    }
    return fetch(url, { headers: headers || {} }).then(async r => ({ status: r.status, text: await r.text() }))
      .catch(e => ({ status: 0, text: 'ERROR: ' + e.message }));
  }
  const mem = {};
  async function cached(key, ttlMin, fn) {
    const now = Date.now();
    if (mem[key] && now - mem[key].at < ttlMin * 60000) return mem[key].v;
    const stored = load('c:' + key, null);
    if (stored && now - stored.at < ttlMin * 60000) { mem[key] = stored; return stored.v; }
    try {
      const v = await fn();
      mem[key] = { at: now, v };
      if (JSON.stringify(v).length < 400000) save('c:' + key, mem[key]);
      return v;
    } catch (e) {
      if (stored) return stored.v; // sin conexión: se usan los últimos datos guardados
      throw e;
    }
  }
  function clearCache() {
    Object.keys(mem).forEach(k => delete mem[k]);
    Object.keys(localStorage).filter(k => k.startsWith('c:')).forEach(k => localStorage.removeItem(k));
  }

  // ---------- Fuentes de datos ----------
  async function yahoo(sym, range, interval) {
    return cached(`y2:${sym}:${range}:${interval}`, range === 'max' ? 720 : /m$/.test(interval) ? 5 : 20, async () => {
      let last;
      for (const host of ['query1', 'query2']) {
        const r = await http(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false&events=div`);
        last = r;
        if (r.status !== 200) continue;
        const j = JSON.parse(r.text);
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res) continue;
        const q = res.indicators.quote[0] || {};
        const t = [], c = [], o = [], h = [], l = [], v = [];
        (res.timestamp || []).forEach((ts, i) => {
          const x = q.close && q.close[i]; if (x == null || !isFinite(x)) return;
          const op = q.open && q.open[i], hi = q.high && q.high[i], lo = q.low && q.low[i], vo = q.volume && q.volume[i];
          t.push(ts); c.push(x);
          o.push(op != null && isFinite(op) ? op : x); h.push(hi != null && isFinite(hi) ? Math.max(hi, x) : x);
          l.push(lo != null && isFinite(lo) ? Math.min(lo, x) : x); v.push(vo != null && isFinite(vo) ? vo : 0);
        });
        const meta = res.meta || {};
        // Cierre anterior: el último cierre de un día anterior al de la cotización actual.
        // (chartPreviousClose es el cierre antes del inicio del rango, no el de ayer.)
        let prev = null;
        if (interval === '1d' && t.length >= 2) {
          const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);
          const cur = day(meta.regularMarketTime || t[t.length - 1]);
          for (let i = t.length - 1; i >= 0; i--) if (day(t[i]) < cur) { prev = c[i]; break; }
        }
        const div = Object.values((res.events && res.events.dividends) || {}).map(x => ({ t: x.date, amount: x.amount })).sort((a, b) => a.t - b.t);
        return { t, c, o, h, l, v, div, meta: { price: meta.regularMarketPrice, prev: prev, currency: meta.currency, name: meta.longName || meta.shortName, exchange: meta.fullExchangeName } };
      }
      throw new Error('Yahoo no responde (' + (last ? last.status : '?') + ')');
    });
  }
  async function daily(a) {
    if (a.resolveIsin && a.isin && !a.resolved) await resolveListing(a).catch(() => {});
    let d = null, err = null;
    try { d = await yahoo(a.yahoo, '2y', '1d'); } catch (e) { err = e; }
    // Si la cotización elegida falla o casi no tiene historial, se prueba otra bolsa del mismo ISIN (como mucho cada 12 h).
    if ((!d || d.c.length < 100) && (a.isin || a.alt) && !(a.resolveAt > Date.now() - 12 * 3600e3)) {
      const was = a.yahoo; await resolveListing(a).catch(() => {});
      if (a.yahoo !== was) { try { d = await yahoo(a.yahoo, '2y', '1d'); err = null; } catch (e) { err = e; } }
    }
    if (!d) throw err || new Error('sin datos');
    return d;
  }
  /** Busca la cotización del mismo ISIN con historial suficiente: primero en euros (Xetra y otras bolsas alemanas), luego el resto. */
  async function resolveListing(a) {
    a.resolveAt = Date.now();
    let found = [];
    if (a.isin) try {
      const r = await http(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(a.isin)}&quotesCount=15&newsCount=0`);
      found = (JSON.parse(r.text).quotes || []).map(q => q.symbol).filter(Boolean);
    } catch (e) {}
    const rank = s => s.endsWith('.DE') ? 0 : /\.(F|MU|SG|DU|BE|HM)$/.test(s) ? 1 : /\.(MI|AS|PA)$/.test(s) ? 2 : 3;
    const cands = [...new Set([...(a.alt || []), ...found.sort((x, y) => rank(x) - rank(y)), a.yahoo])].slice(0, 8);
    for (const sym of cands) {
      try {
        const d = await yahoo(sym, '2y', '1d');
        if (d.c.length >= 200 && Date.now() / 1000 - d.t[d.t.length - 1] < 7 * 86400) { a.yahoo = sym; a.resolved = true; persist(); return sym; }
      } catch (e) {}
    }
    persist();
    return null;
  }

  async function fxToEur(ccy) {
    if (!ccy || ccy === 'EUR') return 1;
    let div = 1, base = ccy;
    if (ccy === 'GBp' || ccy === 'GBX') { div = 100; base = 'GBP'; }
    if (ccy === 'ZAc' || ccy === 'ILA') { div = 100; base = ccy === 'ZAc' ? 'ZAR' : 'ILS'; }
    const d = await yahoo(`EUR${base}=X`, '5d', '1d');
    return 1 / (d.meta.price || d.c[d.c.length - 1]) / div;
  }

  function parseRss(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return [...doc.querySelectorAll('item')].map(it => ({
      title: (it.querySelector('title') || {}).textContent || '',
      link: (it.querySelector('link') || {}).textContent || '',
      date: new Date((it.querySelector('pubDate') || {}).textContent || 0).getTime(),
      source: (it.querySelector('source') || {}).textContent || ''
    })).map(n => { if (n.source && n.title.endsWith(' - ' + n.source)) n.title = n.title.slice(0, -(n.source.length + 3)); return n; });
  }
  async function news(query, opts = {}) {
    const days = opts.days || 14;
    return cached(`n:${query}:${days}`, 30, async () => {
      const q = encodeURIComponent(query + ` when:${days}d`);
      const urls = [`https://news.google.com/rss/search?q=${q}&hl=es&gl=ES&ceid=ES:es`];
      if (!opts.esOnly) urls.push(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
      const all = [];
      for (const u of urls) { const r = await http(u); if (r.status === 200) all.push(...parseRss(r.text)); }
      const seen = new Set();
      return all.filter(n => { const k = n.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => b.date - a.date).slice(0, 40);
    });
  }
  async function fearGreedStocks() {
    return cached('fg:stocks', 60, async () => {
      const r = await http('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' });
      if (r.status !== 200) throw new Error('CNN ' + r.status);
      const j = JSON.parse(r.text).fear_and_greed;
      return { score: j.score, rating: j.rating, prevWeek: j.previous_1_week, prevMonth: j.previous_1_month };
    });
  }
  async function fearGreedCrypto() {
    return cached('fg:crypto', 60, async () => {
      const r = await http('https://api.alternative.me/fng/?limit=31');
      const d = JSON.parse(r.text).data;
      return { score: +d[0].value, rating: d[0].value_classification, prevWeek: +d[7].value, prevMonth: +d[30].value };
    });
  }
  async function secData() {
    return cached('sec:' + settings.dataRepo, 180, async () => {
      const r = await http(`https://raw.githubusercontent.com/${settings.dataRepo}/${settings.branch}/data/sec.json`);
      if (r.status !== 200) throw new Error('Datos oficiales no disponibles (' + r.status + ')');
      return JSON.parse(r.text);
    });
  }
  async function analysisNotes() {
    return cached('notes:' + settings.dataRepo, 180, async () => {
      const r = await http(`https://raw.githubusercontent.com/${settings.dataRepo}/${settings.branch}/data/analisis.json`);
      if (r.status !== 200) return null;
      return JSON.parse(r.text);
    }).catch(() => null);
  }
  // Prueba histórica: resultados calculados cada semana en GitHub con datos reales; si falta el activo, se calcula aquí.
  async function backtestData() {
    return cached('bt:' + settings.dataRepo, 360, async () => {
      const r = await http(`https://raw.githubusercontent.com/${settings.dataRepo}/${settings.branch}/data/backtest.json`);
      if (r.status !== 200) return null;
      return JSON.parse(r.text);
    }).catch(() => null);
  }
  async function assetBacktest(a) {
    const all = await backtestData();
    if (all && all.assets && all.assets[a.id]) return { ...all.assets[a.id], updated: all.updated };
    const key = 'btl:' + a.id + ':' + a.yahoo, old = load(key, null);
    if (old && Date.now() - old.at < 7 * 86400e3) return old.v;
    const h = await yahoo(a.yahoo, 'max', '1d').catch(() => null);
    const bt = h && h.c.length >= 400 ? A.backtest(h) : null;
    if (bt) { bt.src = 'calculado en el móvil'; save(key, { at: Date.now(), v: bt }); }
    return bt;
  }

  // Datos de Yahoo que necesitan "crumb" (PER, fechas de resultados, dividendos). Si fallan, se usa lo de la SEC.
  let crumbP = null;
  function yahooCrumb() {
    if (!crumbP) crumbP = (async () => {
      await http('https://fc.yahoo.com/');
      const r = await http('https://query2.finance.yahoo.com/v1/test/getcrumb');
      if (r.status !== 200 || !r.text || r.text.length > 40 || r.text.includes('<')) throw new Error('sin crumb');
      return r.text.trim();
    })().catch(e => { crumbP = null; throw e; });
    return crumbP;
  }
  async function yahooSummary(sym) {
    return cached('ys:' + sym, 360, async () => {
      const crumb = await yahooCrumb();
      const r = await http(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile&crumb=${encodeURIComponent(crumb)}`);
      if (r.status !== 200) throw new Error('Yahoo resumen ' + r.status);
      const q = JSON.parse(r.text).quoteSummary.result[0];
      const raw = x => x && typeof x === 'object' ? x.raw : x;
      const sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {}, fd = q.financialData || {}, ce = q.calendarEvents || {}, ap = q.assetProfile || {};
      const ed = ce.earnings && ce.earnings.earningsDate ? ce.earnings.earningsDate.map(raw).filter(Boolean) : [];
      return { pe: raw(sd.trailingPE), fpe: raw(sd.forwardPE) || raw(ks.forwardPE), revenueGrowth: raw(fd.revenueGrowth), earningsGrowth: raw(fd.earningsGrowth),
        divYield: raw(sd.dividendYield) || raw(sd.yield), exDiv: raw(ce.exDividendDate) || raw(sd.exDividendDate), divDate: raw(ce.dividendDate),
        earnings: ed, sector: ap.sector, country: ap.country, targetPrice: raw(fd.targetMeanPrice), recommendation: fd.recommendationKey };
    });
  }
  // Eventos que pueden mover mucho el precio (se actualizan desde el repositorio sin instalar otra versión).
  async function keyEvents() {
    const remote = await cached('events:' + settings.dataRepo, 360, async () => {
      const r = await http(`https://raw.githubusercontent.com/${settings.dataRepo}/${settings.branch}/data/eventos.json`);
      if (r.status !== 200) throw new Error('sin eventos');
      return JSON.parse(r.text).events;
    }).catch(() => null);
    return remote || (window.MACRO_EVENTS || []).map(([date, title]) => ({ date, title, type: 'banco', impact: title.startsWith('Fed') ? 'alto' : 'medio', themes: ['todos'] }));
  }
  const EVENT_TIPS = {
    banco: 'Suele mover bolsa, oro, dólar y cripto ese día y el siguiente. A largo plazo no hace falta vender antes; si pensabas comprar, esperar a conocer la decisión evita comprar justo antes de un salto.',
    resultados: 'El precio puede moverse un 5-15% en un día tras los resultados. Si esta posición pesa mucho o acumula mucha ganancia, puedes reducir algo antes; si quieres comprar, suele ser más prudente esperar a ver los resultados.',
    elecciones: 'Las semanas previas suele haber más volatilidad. Históricamente el mercado se calma cuando se conoce el resultado; evita decisiones bruscas justo antes.',
    politica: 'Puede traer anuncios de estímulos o restricciones que muevan mucho a los activos afectados. Vigila las noticias de esos días.',
    vencimientos: 'Día de mucho volumen y movimientos raros que suelen corregirse en días siguientes. No conviene operar ese día por impulso.'
  };
  const eventAffects = (e, a) => (e.themes || []).includes('todos') || (e.themes || []).some(t => (a.themes || []).includes(t));
  const isCrypto = a => a.type === 'Cripto';
  const metaOf = a => Object.assign({ sector: a.type, country: 'Otro', fx: '' }, (window.ASSET_META || {})[a.id], a.meta || {});

  /** Precio, valor en euros y resultado de cada activo (se reutiliza en Cartera, Riesgo y Renta). */
  async function snapshot(a) {
    const d = await daily(a);
    const price = d.meta.price || d.c[d.c.length - 1];
    const fx = await fxToEur(d.meta.currency);
    // Posición precargada desde el valor en euros y el % desde la compra que muestra el bróker.
    if (a.seed && !(a.ops && a.ops.length) && !(a.qty > 0) && price > 0 && fx > 0) {
      a.qty = a.seed.valueEur / (price * fx);
      a.cost = price / (1 + a.seed.pct);
      a.costEur = a.seed.valueEur / (1 + a.seed.pct);
      a.seeded = a.seed.date || true;
      delete a.seed;
      persist();
    }
    if (a.avgEur && !(a.cost > 0) && !(a.ops && a.ops.length) && fx > 0) { a.cost = a.avgEur / fx; persist(); }
    const pos = window.Portfolio.position(a);
    const value = pos.qty * price * fx;
    const r = { a, d, price, ccy: d.meta.currency, fx, pos, value };
    if (pos.qty > 0 && pos.avg > 0) {
      r.localRet = price / pos.avg - 1;
      if (pos.costEur) {
        r.plEur = value - pos.costEur;
        r.eurRet = value / pos.costEur - 1;
        r.fxEffect = r.eurRet - r.localRet; // parte de la ganancia o pérdida que viene del cambio de moneda
      } else {
        r.plEur = value - pos.qty * pos.avg * fx;
        r.eurRet = r.localRet;
      }
    }
    return r;
  }

  // ---------- Utilidades de formato ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function num(v, d) {
    if (v == null || !isFinite(v)) return '–';
    if (d == null) d = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4;
    return v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const eur = v => num(v, 0) + ' €';
  const pctS = v => v == null || !isFinite(v) ? '–' : (v >= 0 ? '+' : '') + num(v * 100, 1) + '%';
  const cls = v => v == null ? '' : v >= 0 ? 'up' : 'down';
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 60) return `hace ${m} min`;
    if (m < 1440) return `hace ${Math.round(m / 60)} h`;
    return `hace ${Math.round(m / 1440)} d`;
  }
  function big(v) {
    if (v == null) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return num(v / 1e9, 2) + ' mil M';
    if (a >= 1e6) return num(v / 1e6, 1) + ' M';
    return num(v, 0);
  }
  const dateS = ts => new Date(ts * 1000).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

  // ---------- Navegación ----------
  const stack = [];
  let current = { name: 'cartera' };
  function go(name, arg, push = true) {
    if (push) stack.push(current);
    current = { name, arg };
    render();
  }
  window.appBack = () => { if (!stack.length) return false; current = stack.pop(); render(); return true; };
  $('#backBtn').onclick = () => window.appBack();
  $('#refreshBtn').onclick = () => { clearCache(); render(); };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { stack.length = 0; current = { name: b.dataset.tab }; render(); });
  function render() {
    $('#backBtn').classList.toggle('hidden', !stack.length);
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === (['detalle', 'editar', 'renta', 'diario', 'oportunidades'].includes(current.name) ? 'x' : current.name)));
    window.scrollTo(0, 0);
    ({ cartera: renderPortfolio, detalle: renderDetail, mercado: renderMarket, ajustes: renderSettings, editar: renderEdit, riesgo: renderRisk, agenda: renderAgenda, renta: renderTax, diario: renderJournal, oportunidades: renderOpps })[current.name](current.arg);
  }

  // ---------- Vista: Cartera ----------
  function byValue(list) { const v = load('lastValues', {}); return list.map((a, i) => [a, i]).sort((x, y) => (v[y[0].id] || 0) - (v[x[0].id] || 0) || x[1] - y[1]).map(x => x[0]); }
  async function renderPortfolio() {
    $('#title').textContent = 'Mi Cartera';
    view.innerHTML = `
      <div class="card"><div class="muted small">Valor de la cartera</div>
        <div class="big" id="total">…</div><div id="totalPl" class="small"></div>
        <div class="btns" style="margin-top:10px"><button class="btn sec" id="taxBtn">Renta y plusvalías</button><button class="btn sec" id="jBtn">Diario de decisiones</button></div>
        <button class="btn" id="oppBtn" style="width:100%;margin-top:8px">🎯 Oportunidades de compra de hoy</button></div>
      <div class="card" id="alertsCard"><h2>Avisos</h2><div id="alerts" class="muted small">Analizando tus activos…</div></div>
      <div class="card"><h2>Tus activos</h2><div id="list"></div></div>
      <div class="disclaimer">${DISCLAIMER}</div>`;
    $('#taxBtn').onclick = () => go('renta');
    $('#jBtn').onclick = () => go('diario');
    $('#oppBtn').onclick = () => go('oportunidades');
    const list = $('#list');
    list.innerHTML = `<div class="phead"><span>Activo</span><span>Valor</span><span>Desde la compra</span></div>` + byValue(assets).map(a => `
      <div class="asset prow" data-id="${esc(a.id)}">
        <div class="pname"><div class="name"><span class="dot" id="dot-${esc(a.id)}"></span><span class="nm">${esc(a.name)}</span></div><div class="sub" id="sub-${esc(a.id)}">${esc(a.type)} · ${esc(a.yahoo)}</div></div>
        <div class="val" id="px-${esc(a.id)}">…</div>
        <div class="chg" id="ch-${esc(a.id)}"></div>
      </div>`).join('');
    list.querySelectorAll('.asset').forEach(el => el.onclick = () => go('detalle', el.dataset.id));

    let total = 0, invested = 0, plSum = 0, fxSum = 0, missing = 0;
    const vals = {};
    const alerts = [];
    const fg = { stocks: await fearGreedStocks().catch(() => null), crypto: await fearGreedCrypto().catch(() => null) };
    await Promise.all(assets.map(async a => {
      try {
        const sn = await snapshot(a);
        const d = sn.d;
        const ch = d.meta.prev ? sn.price / d.meta.prev - 1 : null;
        const ev = A.evaluate(d, { fearGreed: isCrypto(a) ? fg.crypto : fg.stocks, rules: a.rules });
        const dot = $('#dot-' + a.id); if (dot) dot.className = 'dot ' + ev.kind;
        const chEl = $('#ch-' + a.id);
        $('#sub-' + a.id).textContent = `${a.type} · ${num(sn.price * sn.fx, 2)} €`;
        if (sn.pos.qty > 0) {
          $('#px-' + a.id).textContent = eur(sn.value);
          chEl.innerHTML = sn.eurRet != null ? `<b>${esc(pctS(sn.eurRet))}</b>${sn.plEur != null ? `<span>${sn.plEur >= 0 ? '+' : ''}${esc(eur(sn.plEur))}</span>` : ''}` : '';
          chEl.className = 'chg ' + cls(sn.eurRet);
        } else {
          $('#px-' + a.id).textContent = num(sn.price * sn.fx, 2) + ' €';
          chEl.innerHTML = `<b>${esc(pctS(ch))}</b><span>hoy</span>`; chEl.className = 'chg ' + cls(ch);
        }
        vals[a.id] = sn.pos.qty > 0 ? sn.value : 0;
        if (sn.pos.qty > 0) {
          total += sn.value;
          if (sn.plEur != null) { plSum += sn.plEur; invested += sn.value - sn.plEur; }
          if (sn.fxEffect != null) fxSum += sn.fxEffect * (sn.value - sn.plEur);
        }
        ev.alerts.forEach(x => alerts.push({ a, ...x }));
      } catch (e) {
        missing++;
        $('#px-' + a.id).innerHTML = '<span class="warn small">sin datos</span>';
      }
    }));
    if (current.name !== 'cartera') return;
    // Ordenar por valor actual (lo que sacarías vendiendo hoy), de mayor a menor; se recuerda para la próxima vez.
    save('lastValues', Object.assign(load('lastValues', {}), vals));
    byValue(assets).forEach(a => { const el = list.querySelector(`[data-id="${CSS.escape(a.id)}"]`); if (el) list.appendChild(el); });
    $('#total').textContent = total > 0 ? eur(total) : 'Añade tus cantidades';
    if (invested > 0) {
      $('#totalPl').innerHTML = `<span class="${cls(plSum)}">${plSum >= 0 ? '+' : ''}${eur(plSum)} (${pctS(plSum / invested)})</span> <span class="muted">sobre lo invertido</span>` +
        (Math.abs(fxSum) >= 1 ? `<div class="muted">De eso, el efecto de la moneda es <span class="${cls(fxSum)}">${fxSum >= 0 ? '+' : ''}${eur(fxSum)}</span> (solo en los activos con el importe pagado en euros).</div>` : '');
    } else $('#totalPl').innerHTML = '<span class="muted">Toca un activo, entra en «Mi posición» y apunta tus compras.</span>';
    if (missing) $('#totalPl').innerHTML += `<div class="warn">${missing} activo(s) sin datos. Revisa su símbolo en Ajustes.</div>`;
    const soon = (await keyEvents()).filter(e => { const dd = (Date.parse(e.date + 'T12:00:00') - Date.now()) / 86400000; return dd > -1 && dd <= 10; });
    soon.forEach(e => {
      const aff = assets.filter(a => window.Portfolio.position(a).qty > 0 && eventAffects(e, a));
      if (!aff.length) return;
      const dd = Math.round((Date.parse(e.date + 'T12:00:00') - Date.now()) / 86400000);
      alerts.push({ a: { name: dd <= 0 ? 'Hoy' : `En ${dd} días` }, kind: e.impact === 'alto' ? 'r' : 'y', text: `${e.title}${e.themes.includes('todos') ? ' (afecta a toda la cartera)' : ' (afecta a ' + aff.map(x => x.name).join(', ') + ')'}. Mira la Agenda.` });
    });
    const order = { r: 0, g: 1, y: 2 };
    alerts.sort((x, y) => order[x.kind] - order[y.kind]);
    $('#alerts').innerHTML = alerts.length
      ? alerts.map(x => `<div class="reason"><span class="dot ${x.kind}" style="display:inline-block"></span> <b>${esc(x.a.name)}</b>: ${esc(x.text)}</div>`).join('')
      : 'Sin cambios destacados en precios, tendencias ni en tus precios objetivo.';
    try {
      const snaps = (await Promise.all(assets.map(a => snapshot(a).catch(() => null)))).filter(Boolean);
      const pl = riskPlan(snaps), outN = pl ? pl.rows.filter(r => r.out).length : 0;
      if (outN && current.name === 'cartera' && $('#alerts')) { if (!alerts.length) $('#alerts').innerHTML = ''; $('#alerts').insertAdjacentHTML('beforeend', `<div class="reason"><span class="dot y" style="display:inline-block"></span> <b>Reparto</b>: ${outN} activo(s) se han separado bastante del reparto propuesto. Mira «Reparto propuesto» en la pestaña Riesgo.</div>`); }
    } catch (e) {}
    if (new Date().getMonth() >= 10) try {
      const t = await yearEndTax();
      if (current.name === 'cartera' && $('#alerts') && (t.saving > 20 || t.realized < -50)) { if (!$('#alerts').querySelector('.reason')) $('#alerts').innerHTML = ''; $('#alerts').insertAdjacentHTML('afterbegin', `<div class="reason"><span class="dot g" style="display:inline-block"></span> <b>Fin de año</b>: ${t.saving > 20 ? `podrías ahorrar unos ${eur(t.saving)} de impuestos compensando pérdidas` : `tienes ${eur(-t.realized)} de pérdidas que puedes usar`} antes del 31 de diciembre. Mira «Renta y plusvalías».</div>`); }
    } catch (e) {}
    const chk = await dataCheck(false).catch(() => null);
    const bad = chk ? chk.items.filter(x => x.issues.length) : [];
    if (bad.length && current.name === 'cartera' && $('#alerts')) { if (!alerts.length) $('#alerts').innerHTML = ''; } if (bad.length && current.name === 'cartera' && $('#alerts')) $('#alerts').insertAdjacentHTML('afterbegin', bad.map(x => `<div class="reason"><span class="dot y" style="display:inline-block"></span> <b>${esc(x.name)}</b>: revisión de datos: ${esc(x.issues.join('; '))}. Puede que su gráfica o su análisis no sean fiables ahora.</div>`).join(''));
  }

  // ---------- Reparto según riesgo ----------
  const PLAN_CAPS = { asset: 0.15, groups: { Cripto: 0.15 } };
  let btCache = null;
  function riskPlan(snaps) {
    const held = snaps.filter(s => s.value > 0);
    if (held.length < 3) return null;
    const total = held.reduce((x, s) => x + s.value, 0);
    const vols = {}, groups = {}, cur = {};
    const mode = settings.planMode || 'igual';
    held.forEach(s => { vols[s.a.id] = mode === 'igual' ? 1 : A.volatility(s.d.c, 250) || 0.5; groups[s.a.id] = isCrypto(s.a) ? 'Cripto' : 'Otro'; cur[s.a.id] = s.value / total; });
    const tw = window.Portfolio.riskWeights(vols, groups, PLAN_CAPS);
    const rows = window.Portfolio.rebalancePlan(cur, tw, total).map(r => ({ ...r, name: held.find(s => s.a.id === r.id).a.name }));
    let test = '';
    const pf = btCache && btCache.portfolio;
    if (pf && pf.full) { const q = pf.full.res, b = q[mode === 'igual' ? 'igualBanda' : 'banda'], z = q.quieta;
      if (b) test = `En la prueba con ${pf.full.ids.length} de tus activos desde ${pf.full.from.slice(0, 4)}, este método dio ${pctS(b.cagr)} al año con una caída máxima de ${pctS(b.dd)}, frente a ${pctS(z.cagr)} y ${pctS(z.dd)} dejando la cartera quieta (antes de impuestos).`; }
    return { rows, total, test, mode };
  }

  // ---------- Comprobación automática de datos (en el móvil, que sí accede a los precios) ----------
  let checking = null;
  const CHECK_V = 2;
  async function dataCheck(force) {
    const last = load('dataCheck', null);
    // CHECK_V cambia cuando cambia la forma de comprobar: así, al actualizar la app, se descarta el resultado viejo y se recalcula.
    if (!force && last && last.v === CHECK_V && Date.now() - last.at < 4 * 3600e3) return last;
    if (checking) return checking;
    checking = (async () => {
      const items = [];
      for (const a of assets) {
        const it = { id: a.id, name: a.name, issues: [] };
        try {
          const d = await daily(a);
          const price = d.meta.price || d.c[d.c.length - 1];
          if (!(price > 0)) it.issues.push('sin precio');
          const ageDays = (Date.now() / 1000 - d.t[d.t.length - 1]) / 86400;
          if (ageDays > (isCrypto(a) ? 2 : 5)) it.issues.push(`último precio de hace ${Math.round(ageDays)} días`);
          if (d.c.length < 100) it.issues.push(`solo ${d.c.length} días de historial`);
          if (d.meta.prev && Math.abs(price / d.meta.prev - 1) > 0.25) it.issues.push(`variación de hoy extraña (${pctS(price / d.meta.prev - 1)})`);
          const w = await yahoo(a.yahoo, 'max', '1wk').catch(() => null);
          const btA = await assetBacktest(a).catch(() => null);
          const rg = w ? A.priceRanges(w, price, btA && btA.calib) : null;
          if (!rg) it.issues.push('no se pudo calcular hasta dónde podría llegar');
          else {
            it.range = [rg[2].lowPct, rg[2].highPct];
            // Los activos muy volátiles tienen rangos amplios de verdad: solo se avisa si el rango no cuadra con lo que se mueve el precio cada día (señal de datos rotos).
            const lr = []; for (let i = Math.max(1, d.c.length - 252); i < d.c.length; i++) if (d.c[i] > 0 && d.c[i - 1] > 0) lr.push(Math.log(d.c[i] / d.c[i - 1]));
            const mu = lr.reduce((x, y) => x + y, 0) / (lr.length || 1);
            const volD = lr.length > 60 ? Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / (lr.length - 1) * (isCrypto(a) ? 365 : 252)) : null;
            const volR = rg[2].volYear;
            if (volR > 2.5 || (volD && (volR > volD * 1.7 + 0.1 || volR < volD / 1.7 - 0.1))) it.issues.push(`rango a 12 meses que no cuadra con su volatilidad (${pctS(rg[2].lowPct)} / ${pctS(rg[2].highPct)})`);
          }
          if (w && w.t.length) it.since = w.t[0];
          it.price = price; it.ccy = d.meta.currency;
        } catch (e) { it.issues.push('sin datos (' + e.message + ')'); }
        items.push(it);
      }
      const res = { at: Date.now(), v: CHECK_V, items };
      save('dataCheck', res);
      return res;
    })();
    try { return await checking; } finally { checking = null; }
  }

  // ---------- Vista: Detalle ----------
  const DETAIL_TABS = [['analisis', 'Análisis'], ['grafica', 'Gráfica'], ['noticias', 'Noticias'], ['geo', 'Geopolítica'], ['oficial', 'Oficial'], ['fondos', 'Grandes fondos'], ['posicion', 'Mi posición']];
  async function renderDetail(id) {
    const a = assets.find(x => x.id === id); if (!a) return go('cartera', null, false);
    const tab = current.tab || 'analisis';
    $('#title').textContent = a.name;
    view.innerHTML = `
      <div class="card"><div class="row"><div class="grow"><div class="muted small">${esc(a.type)} · ${esc(a.yahoo)}${a.sec ? ' · SEC ' + esc(a.sec) : ''}</div>
        <div class="big" id="dPx">…</div><div id="dCh" style="font-size:16px;font-weight:600"></div></div></div>
        <div class="pills" id="perPills" style="margin-top:8px"></div>
        ${a.note ? `<div class="small warn" style="margin-top:6px">${esc(a.note)}</div>` : ''}</div>
      <div class="pills">${DETAIL_TABS.map(([k, l]) => `<button class="pill ${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
      <div id="tabBody"><div class="loading">Cargando…</div></div>`;
    view.querySelectorAll('.pill[data-t]').forEach(b => b.onclick = () => { current.tab = b.dataset.t; renderDetail(id); });
    let d;
    try { d = await daily(a); } catch (e) { $('#tabBody').innerHTML = `<div class="card warn">No hay datos de precio para «${esc(a.yahoo)}». Cambia el símbolo en Mi posición.</div>`; if (tab === 'posicion') renderPosition(a, null); return; }
    const price = d.meta.price || d.c[d.c.length - 1];
    const fxNow = await fxToEur(d.meta.currency).catch(() => null);
    $('#dPx').innerHTML = fxNow ? `${num(price * fxNow, 2)} €${d.meta.currency && d.meta.currency !== 'EUR' ? ` <span class="small muted" style="font-weight:400">${num(price)} ${esc(d.meta.currency)}</span>` : ''}` : num(price) + ' ' + esc(d.meta.currency || '');
    showPeriod(a, d, price, current.period || 'hoy');
    const body = $('#tabBody');
    try {
      if (tab === 'analisis') await tabAnalysis(a, d, body);
      if (tab === 'grafica') await tabChart(a, d, body);
      if (tab === 'noticias') await tabNews(a, body);
      if (tab === 'geo') await tabGeo(a, body);
      if (tab === 'oficial') await tabOfficial(a, body);
      if (tab === 'fondos') await tabFunds(a, body);
      if (tab === 'posicion') renderPosition(a, d);
    } catch (e) { body.innerHTML = `<div class="card warn">Error: ${esc(e.message)}</div>`; }
  }

  // Variación del precio en el intervalo elegido (hoy, 1 semana… o todo el historial).
  const PERIODS = [['hoy', 'Hoy', 1], ['1s', '1S', 7], ['1m', '1M', 30], ['3m', '3M', 91], ['6m', '6M', 182], ['1a', '1A', 365], ['5a', '5A', 1826], ['max', 'Todo', 0], ['compra', 'Desde compra', -1]];
  async function showPeriod(a, d, price, key) {
    const pos = window.Portfolio.position(a);
    const list = PERIODS.filter(p => p[0] !== 'compra' || pos.avg > 0);
    const pills = $('#perPills'); if (!pills) return;
    pills.innerHTML = list.map(([k, l]) => `<button class="pill ${k === key ? 'on' : ''}" data-p="${k}">${l}</button>`).join('');
    pills.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { current.period = b.dataset.p; showPeriod(a, d, price, b.dataset.p); });
    const [, label, days] = PERIODS.find(p => p[0] === key);
    let ch = null, since = '';
    if (key === 'hoy') { ch = d.meta.prev ? price / d.meta.prev - 1 : null; since = 'hoy'; }
    else if (key === 'compra') {
      const sn = await snapshot(a).catch(() => null);
      ch = sn && sn.eurRet != null ? sn.eurRet : price / pos.avg - 1;
      since = sn && sn.plEur != null ? `desde la compra (${sn.plEur >= 0 ? '+' : ''}${eur(sn.plEur)})` : 'desde la compra';
    } else {
      let t = d.t, c = d.c;
      if (days === 0 || days > 700) { const w = await yahoo(a.yahoo, 'max', '1wk').catch(() => null); if (w && w.c.length) { t = w.t; c = w.c; } }
      if (days === 0) { ch = price / c[0] - 1; since = 'desde ' + dateS(t[0]); }
      else {
        const base = A.changeSince(t, c, days);
        ch = base == null ? price / c[0] - 1 : (1 + base) * price / c[c.length - 1] - 1;
        since = base == null ? 'desde ' + dateS(t[0]) + ' (no hay más datos)' : 'en ' + ({ '1s': '1 semana', '1m': '1 mes', '3m': '3 meses', '6m': '6 meses', '1a': '1 año', '5a': '5 años' })[key];
      }
    }
    const el = $('#dCh'); if (!el || current.period !== undefined && (current.period || 'hoy') !== key) return;
    el.innerHTML = `<span class="${cls(ch)}">${pctS(ch)}</span> <span class="muted small" style="font-weight:400">${esc(since)} · ${esc(d.meta.exchange || '')}</span>`;
  }

  // ---------- Datos anticipadores ----------
  const NASDAQ_H = { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
  const usTicker = a => a.type === 'Acción' && /^[A-Z]{1,5}$/.test(a.yahoo) ? a.yahoo : null;
  const nint = v => v == null ? null : +String(v).replace(/[^0-9.\-]/g, '') || 0;
  async function leadingData(a) {
    const out = {};
    const t = usTicker(a);
    if (t) {
      await cached('lead:' + t, 720, async () => {
        const [f, r, sh] = await Promise.all([
          http(`https://api.nasdaq.com/api/analyst/${t}/earnings-forecast`, NASDAQ_H).catch(() => null),
          http(`https://api.nasdaq.com/api/analyst/${t}/ratings`, NASDAQ_H).catch(() => null),
          http(`https://api.nasdaq.com/api/quote/${t}/short-interest?assetClass=stocks`, NASDAQ_H).catch(() => null)
        ]);
        const o = {};
        try { const j = JSON.parse(f.text).data; const rows = [...((j.quarterlyForecast || {}).rows || []).slice(0, 1), ...((j.yearlyForecast || {}).rows || []).slice(0, 1)];
          if (rows.length) { o.revUp = rows.reduce((x, r) => x + (nint(r.up) || 0), 0); o.revDown = rows.reduce((x, r) => x + (nint(r.down) || 0), 0); o.eps = rows.map(r => ({ period: r.fiscalEnd, eps: r.consensusEPSForecast, n: nint(r.noOfEstimates) })); } } catch (e) {}
        try { const j = JSON.parse(r.text).data; o.rating = j.meanRatingType; o.ratingNote = j.ratingsSummary; } catch (e) {}
        try { const rows = JSON.parse(sh.text).data.shortInterestTable.rows; if (rows && rows.length) o.short = { date: rows[0].settlementDate, interest: nint(rows[0].interest), prev: rows[1] ? nint(rows[1].interest) : null, dtc: nint(rows[0].daysToCover) }; } catch (e) {}
        return o;
      }).then(o => Object.assign(out, o)).catch(() => {});
    }
    if (a.id === 'btc' || a.id === 'eth') {
      const m = await cached('mvrv:' + a.id, 720, async () => {
        const r = await http(`https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${a.id}&metrics=CapMVRVCur&frequency=1d&page_size=7&paging_from=end`);
        const rows = JSON.parse(r.text).data || []; const last = rows.filter(x => x.CapMVRVCur).pop();
        return last ? { v: +last.CapMVRVCur, date: last.time.slice(0, 10) } : null;
      }).catch(() => null);
      if (m) { out.mvrv = m.v; out.mvrvDate = m.date; out.mvrvAsset = a.id; }
    }
    return Object.keys(out).length ? out : null;
  }
  async function marketRegime(a) {
    const ref = isCrypto(a) ? assets.find(x => x.id === 'btc') || { yahoo: 'BTC-USD' } : assets.find(x => x.id === 'sp500') || { yahoo: 'SXR8.DE' };
    const d = await yahoo(ref.yahoo, '2y', '1d').catch(() => null);
    const r = d ? A.regimeOf(d) : null;
    return r ? { r, ref: isCrypto(a) ? 'Bitcoin' : 'S&P 500' } : null;
  }

  async function gatherExtra(a, d) {
    const [nw, fg, sec, geo] = await Promise.all([
      news(a.news).catch(() => null),
      (isCrypto(a) ? fearGreedCrypto() : fearGreedStocks()).catch(() => null),
      a.sec ? secData().catch(() => null) : null,
      geoNews(a).catch(() => null)
    ]);
    const s = sec && sec.assets && sec.assets[a.sec];
    const funds = sec && sec.funds && sec.funds.positions && sec.funds.positions[a.sec];
    const [leading, regime] = await Promise.all([leadingData(a).catch(() => null), marketRegime(a).catch(() => null)]);
    const extra = { news: nw, fearGreed: fg, insiders: s && s.insiders, filings: s && s.filings, funds, geoNews: geo, sec, rules: a.rules, leading, regime };
    if (a.type === 'Acción') {
      const price = d.meta.price || d.c[d.c.length - 1];
      extra.valuation = null;
      if (s && s.ttm && s.ttm.eps) {
        const w = await yahoo(a.yahoo, 'max', '1wk').catch(() => null);
        extra.valuation = window.Portfolio.valuation(price, s, w);
        if (extra.valuation) extra.valuation.source = 'SEC';
      }
      const ys = await yahooSummary(a.yahoo).catch(() => null);
      extra.summary = ys;
      if (!extra.valuation && ys && (ys.pe || ys.revenueGrowth != null)) {
        extra.valuation = { eps: ys.pe ? 1 : null, pe: ys.pe || null, growth: ys.revenueGrowth, source: 'Yahoo' };
        if (ys.pe && ys.revenueGrowth > 0) extra.valuation.peg = ys.pe / (ys.revenueGrowth * 100);
      }
      if (extra.valuation && ys) extra.valuation.fpe = ys.fpe;
    }
    return extra;
  }

  async function tabAnalysis(a, d, body) {
    const extra = await gatherExtra(a, d);
    const ev = A.evaluate(d, extra);
    const m = ev.metrics;
    const notes = await analysisNotes();
    const note = notes && notes.assets && notes.assets[a.id];
    const imp = A.importantNews(extra.news, 3);
    const v = extra.valuation;
    const w = await yahoo(a.yahoo, 'max', '1wk').catch(() => null);
    const odds = w ? A.historicalOdds(w) : null;
    const fxR = await fxToEur(d.meta.currency).catch(() => null) || 1;
    const curR = fxR !== 1 || d.meta.currency === 'EUR' ? '€' : (d.meta.currency || '');
    const bt = await assetBacktest(a).catch(() => null);
    const ranges = w ? A.priceRanges(w, d.meta.price || d.c[d.c.length - 1], bt && bt.calib) : null;
    const techScore = A.evaluate(d).score; // la parte que se puede comprobar con el pasado
    const verdict = bt ? A.backtestVerdict(bt, techScore) : null;
    if (verdict && verdict.weak && ev.confidence.level !== 'Baja') { ev.confidence.level = ev.confidence.level === 'Alta' ? 'Media' : 'Baja'; ev.confidence.text += ' Se baja un nivel porque en la prueba histórica esta señal no funcionó bien en este activo.'; }
    const sc = ev.scenario;
    const ccy = d.meta.currency || '';
    const today = new Date().toISOString().slice(0, 10);
    const watch = [];
    const ys = extra.summary;
    if (ys && ys.earnings && ys.earnings[0]) watch.push(`Resultados el ${new Date(ys.earnings[0] * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}`);
    else if (extra.sec && a.sec && extra.sec.assets[a.sec] && extra.sec.assets[a.sec].nextReport && extra.sec.assets[a.sec].nextReport.estimate >= today) watch.push(`Resultados hacia el ${new Date(extra.sec.assets[a.sec].nextReport.estimate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })} (estimado)`);
    const lim = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    (await keyEvents()).filter(e => e.date >= today && e.date <= lim && eventAffects(e, a)).slice(0, 4)
      .forEach(e => watch.push(`${e.title} el ${new Date(e.date + 'T12:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}${e.approx ? ' (aprox.)' : ''}`));
    if (sc.levels.sma200) watch.push(`Si pierde o recupera ${num(sc.levels.sma200)} ${ccy} (media de 200 días)`);
    const pos = (ev.bar + 1) / 2 * 100;
    const dots = { Alta: 3, Media: 2, Baja: 1 }[ev.confidence.level];
    body.innerHTML = `
      <div class="card"><div class="small muted">Orientación según todo lo analizado</div>
        <div style="font-size:18px;font-weight:700;margin:4px 0" class="${ev.kind === 'g' ? 'up' : ev.kind === 'r' ? 'down' : 'warn'}">${esc(ev.label)}</div>
        <div style="position:relative;height:16px;border-radius:999px;margin:14px 0 4px;background:linear-gradient(90deg,#ef4444 0%,#f97316 25%,#f59e0b 50%,#84cc16 75%,#22c55e 100%)">
          <div style="position:absolute;top:-6px;left:calc(${pos.toFixed(1)}% - 4px);width:8px;height:28px;border-radius:4px;background:#fff;box-shadow:0 0 0 2px #0b1220"></div></div>
        <div class="row small muted" style="justify-content:space-between"><span>Vender</span><span>Reducir</span><span>Mantener</span><span>Acumular</span><span>Comprar</span></div>
        <div class="small" style="margin-top:10px">Confianza: <b>${'●'.repeat(dots)}${'○'.repeat(3 - dots)} ${ev.confidence.level.toLowerCase()}</b> · ${esc(ev.confidence.text)}</div>
        <div class="small" style="margin-top:6px">${esc(ev.why)}</div></div>
      ${bt ? (() => { const st = bt.strategy, yr = new Date(st.from * 1000).getFullYear();
        const cov = bt.calib && bt.calib[13] ? bt.calib[13].coverage : null;
        return `<div class="card"><h2>¿Ha funcionado antes?</h2>
        ${verdict ? `<div class="small ${verdict.weak ? 'warn' : ''}">${esc(verdict.text)}</div>` : ''}
        <h3>Si hubieras seguido la señal desde ${yr}</h3>
        <div class="kv"><div><span>Saliendo en «Precaución» y volviendo después</span><b class="${cls(st.cagr)}">${pctS(st.cagr)} al año</b></div><div><span>Comprar y no tocar</span><b class="${cls(st.bhCagr)}">${pctS(st.bhCagr)} al año</b></div>
        <div><span>Peor caída siguiendo la señal</span><b class="down">${pctS(st.dd)}</b></div><div><span>Peor caída sin tocar</span><b class="down">${pctS(st.bhDd)}</b></div></div>
        <div class="small muted" style="margin-top:6px">${st.cagr > st.bhCagr ? 'Aquí la señal ganó a no hacer nada' : 'Aquí la señal ganó menos que no hacer nada'}${st.dd > st.bhDd ? ', pero con caídas más pequeñas' : ''}. Antes de impuestos y comisiones (se cuenta un 0,2% por operación). ${cov != null ? `Los rangos de 3 meses acertaron el ${(cov * 100).toFixed(0)}% de las veces (objetivo: 80%).` : ''}
        Solo se puede comprobar la parte técnica (precio, medias, RSI): las noticias y el sentimiento de entonces no están guardados. Datos: ${esc(bt.src || '')}${bt.updated ? ', revisado el ' + esc(bt.updated) : ''}. Lo que funcionó en el pasado puede dejar de funcionar.</div></div>`; })() : ''}
      <div class="card"><h2>Lo más probable</h2>
        <div>${esc(sc.text)}</div>
        ${odds ? `<h3>Qué pasó antes en situaciones parecidas</h3><div class="small">${esc(odds.text)}</div>
          ${odds.upPct != null ? `<div style="display:flex;height:10px;border-radius:6px;overflow:hidden;margin-top:6px"><div style="width:${(odds.upPct * 100).toFixed(0)}%;background:var(--up)"></div><div style="flex:1;background:var(--down)"></div></div>
          <div class="row small muted" style="justify-content:space-between"><span>subió ${(odds.upPct * 100).toFixed(0)}%</span><span>bajó ${(100 - odds.upPct * 100).toFixed(0)}%</span></div>` : ''}` : ''}
        ${sc.risks.length ? `<h3>Riesgos principales</h3>${sc.risks.map(r => `<div class="reason down small">▼ ${esc(r)}</div>`).join('')}` : ''}
        <h3>Niveles clave (${esc(ccy)})</h3><div class="kv">
          <div><span>Suelo del último año</span><b>${num(sc.levels.support)}</b></div>
          <div><span>Media de 200 días</span><b>${num(sc.levels.sma200)}</b></div>
          <div><span>Techo del último año</span><b>${num(sc.levels.resistance)}</b></div>
          <div><span>Precio actual</span><b>${num(m.last)}</b></div></div>
        ${watch.length ? `<h3>Qué vigilar</h3>${watch.map(x => `<div class="reason small">👁 ${esc(x)}</div>`).join('')}` : ''}
        <div class="small muted" style="margin-top:8px">Ningún análisis acierta siempre: esto son probabilidades a partir de los datos de hoy, y cambian cuando cambian los datos. Úsalo para no decidir por impulso, no como garantía.</div></div>
      ${ranges ? `<div class="card"><h2>Hasta dónde podría llegar</h2>
        <div class="small muted" style="margin-bottom:8px">Según lo que se mueve ${esc(a.name)} (volatilidad de los últimos ${ranges[0].years} años: ${num(ranges[0].volYear * 100, 0)}% al año), hay unas 8 posibilidades de 10 de que el precio esté dentro de este rango.${ranges[1].calibrated ? ' Rango ajustado con lo que pasó de verdad en su historial.' : ''} No supone que vaya a subir ni a bajar: para eso mira la orientación de arriba.</div>
        ${ranges.map(r => { const lo = r.low * fxR, hi = r.high * fxR, mid = r.mid * fxR, now = m.last * fxR;
          const span = hi - lo || 1, pNow = Math.max(0, Math.min(100, (now - lo) / span * 100));
          return `<div style="margin:12px 0"><div class="row small"><b class="grow">En ${r.label}</b><span class="muted">hoy ${num(now, 2)} ${curR}</span></div>
            <div style="position:relative;height:10px;border-radius:6px;margin:8px 0 4px;background:linear-gradient(90deg,var(--down),var(--card2) ${pNow.toFixed(0)}%,var(--up))">
              <div style="position:absolute;top:-4px;left:calc(${pNow.toFixed(1)}% - 2px);width:4px;height:18px;background:#fff;border-radius:2px"></div></div>
            <div class="row small" style="justify-content:space-between"><span class="down">▼ ${num(lo, 2)} ${curR} (${pctS(r.lowPct)})</span><span class="up">${num(hi, 2)} ${curR} (${pctS(r.highPct)}) ▲</span></div></div>`; }).join('')}
        ${extra.summary && extra.summary.targetPrice ? `<div class="small" style="margin-top:6px">Precio objetivo medio de los analistas a 12 meses: <b>${num(extra.summary.targetPrice * fxR, 2)} ${curR}</b> (${pctS(extra.summary.targetPrice / m.last - 1)}).</div>` : ''}
        <div class="small muted" style="margin-top:8px">Es la estadística de su propio pasado, no una predicción: un suceso nuevo (resultados, aranceles, una crisis) puede sacarlo del rango. La marca blanca es el precio de hoy.</div></div>` : ''}
      ${extra.leading || extra.regime ? (() => { const L = extra.leading || {}; return `<div class="card"><h2>Datos anticipadores</h2><div class="kv">
        ${extra.regime ? `<div><span>Mercado (${esc(extra.regime.ref)})</span><b class="${extra.regime.r === 'alcista' ? 'up' : extra.regime.r === 'bajista' ? 'down' : 'warn'}">${esc(extra.regime.r)}</b></div>` : ''}
        ${L.revUp != null ? `<div><span>Previsiones de analistas (4 sem.)</span><b>${L.revUp} ▲ · ${L.revDown} ▼</b></div>` : ''}
        ${L.rating ? `<div><span>Recomendación media</span><b>${esc(({ Buy: 'Comprar', 'Strong Buy': 'Compra fuerte', Hold: 'Mantener', Sell: 'Vender', 'Strong Sell': 'Venta fuerte' })[L.rating] || L.rating)}</b></div>` : ''}
        ${L.short ? `<div><span>Cortos (días para cerrarlos)</span><b class="${L.short.dtc > 5 ? 'down' : ''}">${num(L.short.dtc, 1)}${L.short.prev ? ' · ' + pctS(L.short.interest / L.short.prev - 1) : ''}</b></div>` : ''}
        ${L.mvrv != null ? `<div><span>MVRV on-chain</span><b class="${L.mvrv > 3.5 ? 'down' : L.mvrv < 1 ? 'up' : ''}">${num(L.mvrv, 2)}</b></div>` : ''}</div>
        <div class="small muted" style="margin-top:6px">Datos que a veces se adelantan al precio. El mercado general cambia la fiabilidad de la señal: con el mercado bajista acertó bastante más que con el alcista. Las revisiones de analistas y los cortos todavía no se pueden comprobar con el pasado (se guardan cada día para medirlos), por eso pesan poco o nada. Del MVRV solo han servido los extremos. Fuentes: Nasdaq y Coin Metrics. Flujos de ETF: no hay fuente gratuita fiable.</div></div>`; })() : ''}
      ${ev.alerts.length ? `<div class="card"><h2>Qué ha cambiado</h2>${ev.alerts.map(x => `<div class="reason ${x.kind === 'g' ? 'up' : x.kind === 'r' ? 'down' : 'warn'}">${esc(x.text)}</div>`).join('')}</div>` : ''}
      ${imp.length ? `<div class="card"><h2>Lo importante esta semana</h2>${newsList(imp, 3)}</div>` : ''}
      ${note ? `<div class="card"><h2>Comentario del día <span class="badge">${esc(notes.date || '')}</span></h2><div style="white-space:pre-wrap">${esc(note)}</div></div>` : ''}
      <div class="card"><h2>Por qué</h2>${ev.reasons.map(r => `<div class="reason"><span class="${r.kind === 'g' ? 'up' : r.kind === 'r' ? 'down' : 'warn'}">${r.pts > 0 ? '▲' : r.pts < 0 ? '▼' : '●'}</span> ${esc(r.text)}</div>`).join('')}</div>
      ${v ? `<div class="card"><h2>Valoración</h2><div class="kv">
        <div><span>PER (12 meses)</span><b>${v.pe ? num(v.pe, 1) : v.eps != null && v.eps <= 0 ? 'Pérdidas' : '–'}</b></div>
        <div><span>PER medio histórico</span><b>${v.medianPe ? num(v.medianPe, 1) : '–'}</b></div>
        <div><span>PER esperado</span><b>${v.fpe ? num(v.fpe, 1) : '–'}</b></div>
        <div><span>Crecimiento ventas</span><b class="${cls(v.growth)}">${pctS(v.growth)}</b></div>
        ${v.epsGrowth != null ? `<div><span>Crecimiento BPA</span><b class="${cls(v.epsGrowth)}">${pctS(v.epsGrowth)}</b></div>` : ''}
        <div><span>PEG</span><b>${v.peg ? num(v.peg, 1) : '–'}</b></div></div>
        ${v.hist && v.hist.length ? `<div class="small muted" style="margin-top:6px">PER al cierre de cada ejercicio: ${v.hist.map(h => h.fy + ': ' + num(h.pe, 0)).join(' · ')}</div>` : ''}
        <div class="small muted" style="margin-top:4px">Fuente: ${esc(v.source || '')}${v.asOf ? ', datos hasta ' + esc(v.asOf) : ''}.</div></div>` : ''}
      <div class="card"><h2>Datos clave</h2><div class="kv">
        <div><span>1 semana</span><b class="${cls(m.ch1w)}">${pctS(m.ch1w)}</b></div>
        <div><span>1 mes</span><b class="${cls(m.ch1m)}">${pctS(m.ch1m)}</b></div>
        <div><span>3 meses</span><b class="${cls(m.ch3m)}">${pctS(m.ch3m)}</b></div>
        <div><span>1 año</span><b class="${cls(m.ch1y)}">${pctS(m.ch1y)}</b></div>
        <div><span>Máx. 52 semanas</span><b>${num(m.hi52)}</b></div>
        <div><span>Mín. 52 semanas</span><b>${num(m.lo52)}</b></div>
        <div><span>Media 50 días</span><b>${num(m.sma50)}</b></div>
        <div><span>Media 200 días</span><b>${num(m.sma200)}</b></div>
        <div><span>RSI (14)</span><b>${m.rsi == null ? '–' : m.rsi.toFixed(0)}</b></div>
        <div><span>Volatilidad anual</span><b>${m.vol == null ? '–' : num(m.vol * 100, 0) + '%'}</b></div>
      </div></div>
      <div class="disclaimer">${DISCLAIMER} La orientación suma tendencia, RSI, distancia a las medias, valoración, tono de las noticias, miedo y codicia, compras de directivos y grandes fondos. La confianza baja cuando faltan datos o las señales se contradicen.</div>`;
  }

  // Gráfica interactiva tipo plataforma de trading (velas, volumen, indicadores, zoom con dos dedos).
  const CANDLES = [['15m', '15 min', '5d', '15m', 140], ['1h', '1 hora', '1mo', '60m', 120], ['1d', '1 día', '5y', '1d', 120], ['1s', '1 semana', 'max', '1wk', 110], ['1me', '1 mes', 'max', '1mo', 400]];
  let chartHandle = null;
  async function tabChart(a, d, body) {
    const prefs = Object.assign({ candle: '1d', type: 'velas', main: ['ma'], sub: 'kdj', vol: true }, load('chartPrefs', {}));
    const setP = ch => { Object.assign(prefs, ch); save('chartPrefs', prefs); tabChart(a, d, body); };
    const price = d.meta.price || d.c[d.c.length - 1];
    const perf = [['Hoy', 1], ['7 días', 7], ['30 días', 30], ['90 días', 90], ['180 días', 180], ['1 año', 365]].map(([lab, days]) => {
      let ch;
      if (days === 1) ch = d.meta.prev ? price / d.meta.prev - 1 : null;
      else { const base = A.changeSince(d.t, d.c, days); ch = base == null ? null : (1 + base) * price / d.c[d.c.length - 1] - 1; }
      return `<div><span>${lab}</span><b class="${cls(ch)}">${pctS(ch)}</b></div>`;
    }).join('');
    const chip = (attr, k, label, on) => `<button class="chip ${on ? 'on' : ''}" data-${attr}="${k}">${label}</button>`;
    body.innerHTML = `<div class="card pc-card">
      <div class="pc-top">${CANDLES.map(([k, l]) => chip('cd', k, l, prefs.candle === k)).join('')}
        <span class="pc-sep"></span>${chip('ty', prefs.type === 'velas' ? 'linea' : 'velas', prefs.type === 'velas' ? 'Velas' : 'Línea', true)}<button class="chip" id="pcFit">Ver todo</button></div>
      <div id="pcRoot"><div class="muted" style="padding:20px">Cargando gráfica…</div></div>
      <div class="pc-ind">${window.ProChart.MAIN.map(([k, l]) => chip('mi', k, l, prefs.main.includes(k))).join('')}<span class="pc-sep"></span>${chip('vo', 'vol', 'VOL', prefs.vol)}${window.ProChart.SUB.filter(x => x[0] !== 'vol').map(([k, l]) => chip('si', k, l, prefs.sub === k)).join('')}</div>
      <div class="perf">${perf}</div>
      <div class="small muted" style="margin-top:6px">Abre o cierra dos dedos para ampliar, arrastra para moverte y toca un punto para ver fecha, precio y volumen. Volumen: verde si esa vela cerró al alza y rojo si cerró a la baja (Yahoo no separa compras y ventas reales). Precios en la moneda de cotización${d.meta.currency ? ' (' + esc(d.meta.currency) + ')' : ''}.</div>
      <details class="small" style="margin-top:6px"><summary style="color:var(--accent)">¿Qué es cada indicador?</summary><div class="muted" style="margin-top:4px">
        <b>MA</b>: media de los últimos 7, 25 y 99 cierres. Si el precio está por encima, la tendencia es alcista.<br>
        <b>EMA</b>: media que da más peso a lo reciente (12 y 26). Reacciona antes.<br>
        <b>BOLL</b>: bandas de Bollinger. Cuando el precio toca la de arriba suele estar caro a corto plazo, y la de abajo, barato.<br>
        <b>SAR</b>: puntos bajo el precio = tendencia alcista; sobre el precio = bajista. Cuando cambian de lado, posible giro.<br>
        <b>Tendencia</b>: línea que mejor se ajusta al tramo que estás viendo, con un canal de ±2 desviaciones. Cambia al hacer zoom.<br>
        <b>KDJ</b>: por encima de 80 sobrecompra, por debajo de 20 sobreventa. Cruces de K sobre D pueden anticipar giros.<br>
        <b>RSI</b>: por encima de 70 caro a corto plazo, por debajo de 30 barato.<br>
        <b>MACD</b>: barras verdes y crecientes = impulso alcista; rojas = bajista.<br>
        Ningún indicador acierta siempre; úsalos juntos y como orientación.</div></details></div>
      <div class="card" id="histCard"></div>`;
    body.querySelectorAll('[data-cd]').forEach(b => b.onclick = () => setP({ candle: b.dataset.cd }));
    body.querySelectorAll('[data-ty]').forEach(b => b.onclick = () => setP({ type: b.dataset.ty }));
    body.querySelectorAll('[data-mi]').forEach(b => b.onclick = () => { const k = b.dataset.mi; setP({ main: prefs.main.includes(k) ? prefs.main.filter(x => x !== k) : prefs.main.concat(k) }); });
    body.querySelectorAll('[data-vo]').forEach(b => b.onclick = () => setP({ vol: !prefs.vol }));
    body.querySelectorAll('[data-si]').forEach(b => b.onclick = () => setP({ sub: prefs.sub === b.dataset.si ? '' : b.dataset.si }));
    const cd = CANDLES.find(x => x[0] === prefs.candle) || CANDLES[2];
    let data;
    try { data = await yahoo(a.yahoo, cd[2], cd[3]); }
    catch (e) { data = cd[3] === '1d' ? d : null; }
    if (!data || !data.c || data.c.length < 2) { $('#pcRoot').innerHTML = '<div class="muted" style="padding:20px">No hay datos para este intervalo. Prueba otro.</div>'; return; }
    if (!data.o) data = { ...data, o: data.c, h: data.c, l: data.c, v: data.c.map(() => 0) }; // datos antiguos sin velas
    if (chartHandle) { try { chartHandle.destroy(); } catch (e) {} chartHandle = null; }
    const root = $('#pcRoot');
    const pos = window.Portfolio.position(a);
    chartHandle = window.ProChart.render(root, data, { intraday: /m$/.test(cd[3]), cost: pos.avg > 0 ? pos.avg : null, currency: data.meta && data.meta.currency, prefs, visible: cd[4] });
    $('#pcFit').onclick = () => chartHandle && chartHandle.fit();
    if (!data.v.some(x => x > 0)) root.insertAdjacentHTML('beforeend', '<div class="small muted" style="margin-top:4px">Este activo no publica volumen en este intervalo.</div>');
    const w = cd[3] === '1wk' || cd[3] === '1mo' ? data : await yahoo(a.yahoo, 'max', '1wk').catch(() => null);
    if (w && w.c.length) {
      const first = w.c[0], last = price;
      $('#histCard').innerHTML = `<h2>Historial completo</h2><div class="kv">
        <div><span>Desde</span><b>${dateS(w.t[0])}</b></div><div><span>Variación</span><b class="${cls(last / first - 1)}">${pctS(last / first - 1)}</b></div>
        <div><span>Máximo</span><b>${num(Math.max(...(w.h || w.c)))}</b></div><div><span>Mínimo</span><b>${num(Math.min(...(w.l || w.c)))}</b></div></div>
        <div class="small muted" style="margin-top:6px">Elige «1 semana» o «1 mes» y pulsa «Ver todo» para ver todo el historial desde que hay datos en Yahoo Finance.</div>`;
    }
  }

  function newsList(items, limit) {
    if (!items || !items.length) return '<div class="muted">No se han encontrado noticias recientes.</div>';
    return `<div class="news">${items.slice(0, limit || 30).map(n => {
      const s = A.headlineScore(n.title);
      return `<a href="${esc(n.link)}" target="_blank" rel="noopener"><span class="${s > 0 ? 'up' : s < 0 ? 'down' : 'muted'}">${s > 0 ? '▲' : s < 0 ? '▼' : '●'}</span> ${esc(n.title)}
        <div class="meta">${esc(n.source)} · ${ago(n.date)}${A.isGeo(n.title) ? ' <span class="badge">geopolítica</span>' : ''}</div></a>`;
    }).join('')}</div>`;
  }
  async function tabNews(a, body) {
    const items = await news(a.news);
    const s = A.newsSentiment(items);
    const imp = A.importantNews(items, 5);
    body.innerHTML = `<div class="card"><h2>Lo que cambia algo</h2>
      ${imp.length ? newsList(imp, 5) : '<div class="muted">Esta semana no hay noticias con impacto claro (resultados, previsiones, contratos, regulación, cambios de directivos…).</div>'}</div>
      <div class="card"><h2>Resto de noticias (2 semanas)</h2>
      ${s ? `<div class="small muted" style="margin-bottom:6px">Tono: ${s.pos} positivas, ${s.neg} negativas, ${s.n - s.pos - s.neg} neutras (lectura automática de titulares).</div>` : ''}
      <details><summary class="small" style="color:var(--accent)">Ver todas</summary>${newsList(items)}</details></div>`;
  }
  async function geoNews(a) {
    const themes = (a.themes || []).filter(k => window.THEMES[k]);
    const lists = await Promise.all(themes.map(k => news(window.THEMES[k].q, { days: 7, esOnly: true }).then(l => l.slice(0, 6).map(n => ({ ...n, theme: k }))).catch(() => [])));
    return lists.flat().sort((x, y) => y.date - x.date);
  }
  async function tabGeo(a, body) {
    const themes = (a.themes || []).filter(k => window.THEMES[k]);
    const items = await geoNews(a);
    body.innerHTML = `<div class="small muted" style="margin:0 2px 8px">Temas que pueden mover el precio de ${esc(a.name)}: ${themes.map(k => esc(window.THEMES[k].label)).join(', ') || 'ninguno asignado'}.</div>` +
      themes.map(k => `<div class="card"><h2>${esc(window.THEMES[k].label)}</h2>${newsList(items.filter(n => n.theme === k), 6)}</div>`).join('');
  }

  async function tabOfficial(a, body) {
    if (!a.sec) {
      body.innerHTML = `<div class="card"><h2>Publicaciones oficiales</h2><div class="muted">Este activo no presenta cuentas en la SEC de EE. UU. ${a.type === 'ETF' || a.type === 'Materia prima' ? 'Al ser un fondo o materia prima, lo relevante son su folleto y su composición, que publica la gestora.' : 'Sus cuentas se publican en su país de origen.'}</div>
        <div class="btns" style="margin-top:10px"><a class="btn sec" href="https://www.google.com/search?q=${encodeURIComponent(a.name + ' informe anual investor relations')}">Buscar su informe anual</a></div></div>`;
      return;
    }
    const sec = await secData();
    const s = sec.assets && sec.assets[a.sec];
    if (!s) { body.innerHTML = `<div class="card muted">Aún no hay datos de la SEC para ${esc(a.sec)}. Se actualizan una vez al día.</div>`; return; }
    const f = s.fundamentals || {};
    const LABELS = { revenue: 'Ingresos', netIncome: 'Beneficio neto', operatingIncome: 'Beneficio operativo', eps: 'BPA diluido', assets: 'Activos totales', liabilities: 'Pasivos totales', equity: 'Patrimonio neto', cash: 'Caja', longTermDebt: 'Deuda a largo plazo', opCashFlow: 'Flujo de caja operativo' };
    const years = [...new Set(Object.values(f).flat().map(x => x.fy))].sort().slice(-5);
    const table = years.length ? `<div class="scroll"><table><tr><th></th>${years.map(y => `<th>${y}</th>`).join('')}</tr>
      ${Object.keys(LABELS).filter(k => f[k] && f[k].length).map(k => `<tr><td>${LABELS[k]}</td>${years.map(y => { const v = (f[k].find(x => x.fy === y) || {}).val; return `<td>${k === 'eps' ? num(v, 2) : big(v)}</td>`; }).join('')}</tr>`).join('')}
      </table></div><div class="small muted" style="margin-top:6px">Cifras de las cuentas anuales presentadas a la SEC (${esc(s.currency || 'USD')}).</div>` : '<div class="muted">Sin cuentas anuales en formato de datos.</div>';
    const insiders = (s.insiders || []).slice(0, 20);
    const CODES = { P: 'Compra', S: 'Venta', A: 'Concesión', M: 'Ejercicio', F: 'Impuestos', G: 'Regalo', D: 'Devolución' };
    body.innerHTML = `
      <div class="card"><h2>Cuentas anuales</h2>${table}</div>
      <div class="card"><h2>Movimientos de directivos</h2>
        ${insiders.length ? insiders.map(x => `<div class="reason"><b>${esc(x.owner)}</b> <span class="muted small">${esc(x.title || '')}</span>
          <div class="small">${esc(x.date)} · ${(x.tx || []).map(tx => `<span class="${tx.code === 'P' ? 'up' : tx.code === 'S' ? 'down' : 'muted'}">${CODES[tx.code] || tx.code} ${num(tx.shares, 0)} acc.${tx.price ? ' a ' + num(tx.price) + ' $' : ''}</span>`).join(', ') || 'sin detalle'}
          ${x.plan ? ' <span class="badge">plan 10b5-1</span>' : ''} · <a href="${esc(x.url)}" class="muted">ver</a></div></div>`).join('')
        : `<div class="muted">${s.foreign ? 'Empresa extranjera: sus directivos no presentan el formulario 4 en EE. UU.' : 'Sin movimientos recientes.'}</div>`}
        <div class="small muted" style="margin-top:6px">Compra/Venta son operaciones en el mercado; las demás suelen ser parte del sueldo.</div></div>
      <div class="card"><h2>Últimas publicaciones oficiales</h2>
        ${(s.filings || []).slice(0, 15).map(x => `<div class="reason"><a href="${esc(x.url)}" style="color:var(--text)"><b>${esc(x.form)}</b> ${esc(FORM_DESC[x.form] || '')}</a><div class="small muted">${esc(x.date)}${x.items ? ' · ' + esc(x.items) : ''}</div></div>`).join('') || '<div class="muted">Ninguna.</div>'}</div>
      <div class="small muted">Datos de SEC EDGAR, actualizados ${esc(sec.updated || '')}.</div>`;
  }
  const FORM_DESC = { '10-K': 'Informe anual', '10-Q': 'Informe trimestral', '8-K': 'Hecho relevante', '20-F': 'Informe anual (extranjera)', '6-K': 'Comunicado (extranjera)', '40-F': 'Informe anual (Canadá)', 'DEF 14A': 'Junta de accionistas', 'S-1': 'Folleto de emisión', 'N-CSR': 'Informe del fondo', 'N-2': 'Folleto del fondo', '424B3': 'Folleto' };

  async function tabFunds(a, body) {
    if (!a.sec) { body.innerHTML = '<div class="card muted">Los informes 13F de los grandes fondos solo incluyen valores cotizados en EE. UU. Para este activo no hay datos.</div>'; return; }
    const sec = await secData();
    const pos = (sec.funds && sec.funds.positions && sec.funds.positions[a.sec]) || [];
    const ST = { nueva: ['Compra nueva', 'up'], aumenta: ['Aumenta', 'up'], reduce: ['Reduce', 'down'], 'vende todo': ['Vende todo', 'down'], mantiene: ['Mantiene', 'muted'] };
    body.innerHTML = `<div class="card"><h2>Grandes fondos con ${esc(a.name)}</h2>
      ${pos.length ? `<div class="scroll"><table><tr><th>Fondo</th><th>Movimiento</th><th>Acciones</th><th>Valor</th></tr>
        ${pos.map(p => `<tr><td>${esc(p.fund)}<div class="small muted">${esc(p.manager || '')}</div></td><td class="${ST[p.status] ? ST[p.status][1] : ''}">${ST[p.status] ? ST[p.status][0] : esc(p.status)}${p.changePct != null && isFinite(p.changePct) ? ' ' + pctS(p.changePct) : ''}</td><td>${big(p.shares)}</td><td>${big(p.value)} $</td></tr>`).join('')}</table></div>`
        : '<div class="muted">Ninguno de los fondos seguidos tiene este valor en su último informe.</div>'}
      <div class="small warn" style="margin-top:8px">⚠️ Pista retrasada, no señal de compra: muestran lo que tenían al cierre del trimestre, no lo que tienen hoy.</div><div class="small muted" style="margin-top:4px">Informes 13F del trimestre ${esc((sec.funds && sec.funds.period) || '')}. Se publican hasta 45 días después del cierre del trimestre, así que reflejan el pasado. Fondos seguidos: ${esc(((sec.funds && sec.funds.tracked) || []).join(', '))}.</div></div>`;
  }

  function renderPosition(a, d) {
    const body = $('#tabBody');
    const P = window.Portfolio;
    const ccy = d ? d.meta.currency || '' : '';
    const price = d ? (d.meta.price || d.c[d.c.length - 1]) : null;
    const pos = P.position(a);
    const rules = a.rules || {};
    const ops = (a.ops || []).slice().sort((x, y) => y.date.localeCompare(x.date));
    const pl = price && pos.avg > 0 ? price / pos.avg - 1 : null;
    body.innerHTML = `
      <div class="card"><h2>Resumen</h2><div id="fxBox" style="margin-bottom:10px"></div><div class="kv">
        <div><span>Cantidad</span><b>${num(pos.qty, pos.qty % 1 ? 4 : 0)}</b></div>
        <div><span>Precio medio (${esc(ccy)})</span><b>${pos.avg ? num(pos.avg) : '–'}</b></div>
        <div><span>Resultado en ${esc(ccy)}</span><b class="${cls(pl)}">${pctS(pl)}</b></div>
        <div><span>Pagado en euros</span><b>${pos.costEur ? eur(pos.costEur) : '–'}</b></div></div>
        ${a.seeded && !ops.length && String(a.seeded).startsWith('exacta') ? `<div class="small muted" style="margin-top:6px">Datos de tu posición en Trade Republic${a.avgEur ? ': precio medio ' + num(a.avgEur, 2) + ' €' : ''}.</div>` : ''}${a.seeded && !ops.length && !String(a.seeded).startsWith('exacta') ? `<div class="small warn" style="margin-top:6px">Posición estimada a partir de tu captura de Trade Republic (${esc(typeof a.seeded === 'string' ? a.seeded : '')}). La cantidad y el precio medio son aproximados; apunta tus operaciones para tener la cifra exacta.</div>` : ''}</div>
      <div class="card"><h2>Mis operaciones</h2>
        ${ops.length ? ops.map(o => `<div class="asset"><div class="grow"><b class="${o.type === 'compra' ? 'up' : 'down'}">${o.type === 'compra' ? 'Compra' : 'Venta'}</b> ${num(o.qty, o.qty % 1 ? 4 : 0)} a ${num(o.price)} ${esc(ccy)}
          <div class="small muted">${esc(o.date)}${o.eur != null ? ' · ' + num(o.eur, 2) + ' €' : ''}</div></div><button class="icon" data-del="${esc(o.id)}">✕</button></div>`).join('')
          : `<div class="small muted">Apunta cada compra y venta con lo que pagaste o cobraste en euros (con comisiones). Así se calcula la ganancia real, el efecto de la moneda y la renta.</div>`}
        <h3>Añadir operación</h3>
        <div class="row"><select id="oType" class="grow"><option value="compra">Compra</option><option value="venta">Venta</option></select>
          <input id="oDate" type="date" class="grow" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="row"><div class="grow"><label>Cantidad</label><input id="oQty" type="number" inputmode="decimal" step="any"></div>
          <div class="grow"><label>Precio (${esc(ccy)})</label><input id="oPrice" type="number" inputmode="decimal" step="any"></div></div>
        <label>Importe total en euros, con comisiones (lo que ves en el bróker)</label><input id="oEur" type="number" inputmode="decimal" step="any">
        <button class="btn" id="oAdd">Añadir</button></div>
      ${!ops.length ? `<div class="card"><h2>Modo rápido (sin operaciones)</h2>
        <label>Cantidad que tengo</label><input id="pQty" type="number" inputmode="decimal" step="any" value="${a.qty || ''}">
        <label>Precio medio de compra (${esc(ccy)})</label><input id="pCost" type="number" inputmode="decimal" step="any" value="${a.cost || ''}">
        <label>Total pagado en euros (opcional, para ver el efecto de la moneda)</label><input id="pCostEur" type="number" inputmode="decimal" step="any" value="${a.costEur || ''}">
        <button class="btn sec" id="pSave">Guardar</button></div>` : ''}
      <div class="card"><h2>Mis reglas</h2><div class="small muted">Te aviso en Cartera y con una notificación en el móvil cuando el precio cruce estos niveles (en ${esc(ccy)}).</div>
        <label>Comprar más si baja de</label><input id="rBuy" type="number" inputmode="decimal" step="any" value="${rules.buyBelow || ''}">
        <label>Precio objetivo para vender</label><input id="rSell" type="number" inputmode="decimal" step="any" value="${rules.sellAbove || ''}">
        <label>Precio de salida (stop) si cae por debajo de</label><input id="rStop" type="number" inputmode="decimal" step="any" value="${rules.stopBelow || ''}">
        <button class="btn sec" id="rSave">Guardar reglas</button></div>
      <div class="card"><h2>Mis notas</h2><textarea id="pNotes" rows="3">${esc(a.notes || '')}</textarea>
        <div class="btns"><button class="btn sec" id="nSave">Guardar notas</button><button class="btn sec" id="pEdit">Editar símbolo y temas</button></div></div>`;
    if (d && pos.qty > 0 && pos.avg > 0) {
      fxToEur(ccy).then(fx => {
        const value = pos.qty * price * fx;
        const box = $('#fxBox'); if (!box) return;
        if (pos.costEur) {
          const eurRet = value / pos.costEur - 1, fxEff = eurRet - pl;
          box.innerHTML = `<div class="kv"><div><span>Valor actual</span><b style="font-size:20px">${eur(value)}</b></div>
            <div><span>Ganancia / pérdida</span><b style="font-size:20px" class="${cls(eurRet)}">${value - pos.costEur >= 0 ? '+' : ''}${eur(value - pos.costEur)}</b><div class="small ${cls(eurRet)}">${pctS(eurRet)}</div></div></div>
            ${Math.abs(fxEff) < 0.0005 ? '' : `<div class="small" style="margin-top:6px">Del precio: <span class="${cls(pl)}">${pctS(pl)}</span> · De la moneda: <span class="${cls(fxEff)}">${pctS(fxEff)}</span>${ccy !== 'EUR' ? ` (si el ${esc(ccy)} se debilita frente al euro, pierdes aunque el precio no baje)` : ''}.</div>`}`;
        } else box.innerHTML = `<div><span class="small muted">Valor actual</span><div style="font-size:20px;font-weight:700">${eur(value)}</div></div><div class="small muted">Apunta el importe pagado en euros para ver la ganancia en euros y el efecto de la moneda.</div>`;
      }).catch(() => {});
    }
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '¿Borrar?'; return; }
      a.ops = (a.ops || []).filter(o => o.id !== b.dataset.del); persist(); renderPosition(a, d);
    });
    $('#oAdd').onclick = () => {
      const op = { id: 'o' + Date.now(), type: $('#oType').value, date: $('#oDate').value, qty: parseFloat($('#oQty').value), price: parseFloat($('#oPrice').value) };
      const e = parseFloat($('#oEur').value); if (isFinite(e)) op.eur = e;
      if (!op.date || !(op.qty > 0) || !(op.price > 0)) return toast('Faltan fecha, cantidad o precio');
      if (op.type === 'venta' && op.qty > pos.qty + 1e-9) return toast('Vendes más de lo que tienes');
      if (!a.ops || !a.ops.length) { // al pasar a operaciones, la posición rápida se convierte en una compra inicial
        a.ops = [];
        if (a.qty > 0 && a.cost > 0) a.ops.push({ id: 'o0', type: 'compra', date: '2000-01-01', qty: a.qty, price: a.cost, eur: a.costEur || undefined, initial: true });
      }
      a.ops.push(op); persist(); toast('Operación guardada'); renderPosition(a, d);
    };
    if ($('#pSave')) $('#pSave').onclick = () => { a.qty = parseFloat($('#pQty').value) || 0; a.cost = parseFloat($('#pCost').value) || 0; a.costEur = parseFloat($('#pCostEur').value) || 0; persist(); renderPosition(a, d); toast('Guardado'); };
    $('#rSave').onclick = () => { a.rules = { buyBelow: parseFloat($('#rBuy').value) || null, sellAbove: parseFloat($('#rSell').value) || null, stopBelow: parseFloat($('#rStop').value) || null }; persist(); toast('Reglas guardadas'); };
    $('#nSave').onclick = () => { a.notes = $('#pNotes').value; persist(); toast('Guardado'); };
    $('#pEdit').onclick = () => go('editar', a.id);
  }

  // ---------- Vista: Riesgo y reparto ----------
  function bars(rows, fmt) {
    return rows.map(r => `<div style="margin:6px 0"><div class="row small"><span class="grow">${esc(r.k)}</span><b>${(r.w * 100).toFixed(1)}%</b>${fmt ? `<span class="muted" style="width:70px;text-align:right">${fmt(r.v)}</span>` : ''}</div>
      <div style="height:6px;background:var(--card2);border-radius:4px"><div style="height:6px;width:${(r.w * 100).toFixed(1)}%;background:var(--accent);border-radius:4px"></div></div></div>`).join('');
  }
  async function renderRisk() {
    $('#title').textContent = 'Reparto y riesgo';
    const P = window.Portfolio;
    view.innerHTML = '<div class="loading">Calculando…</div>';
    const snaps = (await Promise.all(assets.map(a => snapshot(a).catch(() => null)))).filter(Boolean);
    btCache = await backtestData();
    if (current.name !== 'riesgo') return;
    const held = snaps.filter(s => s.value > 0);
    const items = held.map(s => { const m = metaOf(s.a); return { k: s.a.name, name: s.a.name, value: s.value, sector: m.sector, country: m.country, fx: m.fx || s.ccy }; });
    const byAsset = P.allocation(items.map(i => ({ ...i, asset: i.name })), 'asset');
    const bySector = P.allocation(items, 'sector'), byCountry = P.allocation(items, 'country'), byFx = P.allocation(items, 'fx');
    const warns = P.concentrationWarnings(byAsset, bySector, byCountry, byFx);
    // Riesgo por activo con todo el historial semanal.
    const rows = await Promise.all(snaps.map(async s => {
      const w = await yahoo(s.a.yahoo, 'max', '1wk').catch(() => null);
      const dd = w && w.c.length > 10 ? P.maxDrawdown(w.c, w.t) : null;
      return { s, dd, vol: A.volatility(s.d.c, 250) };
    }));
    const series = {}; snaps.forEach(s => { series[s.a.id] = s.d; });
    const aligned = P.alignReturns(series, 365);
    const weights = {}; held.forEach(s => { weights[s.a.id] = s.value; });
    const pr = P.portfolioRisk(weights, aligned);
    // Correlaciones.
    const ids = (held.length >= 2 ? held : snaps).map(s => s.a.id).filter(id => aligned.rets[id]);
    const name = id => (assets.find(a => a.id === id) || {}).name || id;
    const pairs = [];
    const M = {};
    for (const i of ids) for (const j of ids) {
      if (i >= j) continue;
      const c = P.correlation(aligned.rets[i], aligned.rets[j]);
      M[i + '|' + j] = M[j + '|' + i] = c;
      if (c != null) pairs.push({ i, j, c });
    }
    pairs.sort((x, y) => y.c - x.c);
    const short = id => (assets.find(a => a.id === id) || {}).yahoo.replace(/\..*$/, '').replace('-USD', '').slice(0, 5);
    const color = c => c == null ? 'transparent' : c > 0 ? `rgba(239,68,68,${Math.min(1, c) * 0.85})` : `rgba(34,197,94,${Math.min(1, -c) * 0.85})`;
    const total = held.reduce((s, x) => s + x.value, 0);
    const plan = riskPlan(held);
    view.innerHTML = `
      ${held.length ? '<div class="card" id="crisisCard"><h2>Simulador de crisis</h2><div class="muted small">Calculando cómo le habría ido a tu cartera en crisis pasadas…</div></div>' : ''}
      ${plan ? `<div class="card"><h2>Reparto propuesto</h2>
        <div class="pills" style="margin-bottom:6px"><button class="pill ${plan.mode === 'igual' ? 'on' : ''}" data-pm="igual">Mismo peso</button><button class="pill ${plan.mode === 'riesgo' ? 'on' : ''}" data-pm="riesgo">Menos peso a lo que más se mueve</button></div>
        <div class="small muted" style="margin-bottom:8px">${plan.mode === 'igual' ? 'Todos tus activos con el mismo peso: al reequilibrar vendes parte de lo que más ha subido y compras lo que se ha quedado atrás. En la prueba histórica fue lo que más rentabilidad dio.' : 'Cada activo pesa menos cuanto más se mueve, para que ninguno domine las subidas y bajadas. En la prueba histórica dio algo menos de rentabilidad, pero con caídas mucho más pequeñas.'} Topes: ${PLAN_CAPS.asset * 100}% por activo y ${PLAN_CAPS.groups.Cripto * 100}% entre todas las criptos. Solo se avisa cuando un activo se separa bastante (más de un 25% de su peso o 2 puntos).</div>
        ${plan.rows.filter(r => r.out).length ? `<div class="reason warn" style="margin-bottom:6px">${plan.rows.filter(r => r.out).length} activo(s) fuera de su banda: conviene reequilibrar.</div>` : '<div class="reason up" style="margin-bottom:6px">Tu reparto está dentro de las bandas: no hace falta tocar nada.</div>'}
        <div class="scroll"><table style="font-size:12px"><tr><th></th><th>Ahora</th><th>Prop.</th><th>Ajuste</th></tr>
        ${plan.rows.map(r => `<tr><td>${esc(r.name)}${r.out ? ' <span class="warn">●</span>' : ''}</td><td>${num(r.cw * 100, 1)}%</td><td>${num(r.tw * 100, 1)}%</td><td class="${r.out ? (r.diff > 0 ? 'up' : 'down') : 'muted'}">${r.out ? (r.diff > 0 ? '+' : '') + eur(r.eur) : '–'}</td></tr>`).join('')}
        </table></div>
        <h3>Plan de aportación del mes</h3>
        <div class="row" style="gap:8px;align-items:center"><input id="contrib" type="number" inputmode="decimal" min="0" step="10" style="max-width:130px" value="${settings.monthly || ''}" placeholder="€ este mes"><button class="btn sec" id="contribBtn">Calcular</button></div>
        <div id="contribOut" class="small" style="margin-top:6px"></div>
        <div class="small muted" style="margin-top:6px">Consejo: reequilibra sobre todo con el dinero nuevo que metas (comprando lo que está por debajo), porque vender con ganancias paga impuestos en España. ${plan.test ? esc(plan.test) : ''} No es asesoramiento financiero.</div></div>` : ''}
      ${!held.length ? '<div class="card warn">Aún no has puesto cantidades: el reparto aparecerá cuando apuntes tus compras. El riesgo y la correlación se muestran igualmente.</div>' : ''}
      ${warns.length ? `<div class="card"><h2>Avisos de concentración</h2>${warns.map(w => `<div class="reason warn">${esc(w)}</div>`).join('')}</div>` : held.length ? '<div class="card"><h2>Concentración</h2><div class="small up">Sin concentraciones excesivas.</div></div>' : ''}
      ${held.length ? `<div class="card"><h2>Reparto por activo</h2>${bars(byAsset, eur)}</div>
      <div class="card"><h2>Por sector</h2>${bars(bySector)}</div>
      <div class="card"><h2>Por país</h2>${bars(byCountry)}</div>
      <div class="card"><h2>Por moneda real</h2>${bars(byFx)}<div class="small muted">Moneda a la que estás expuesta de verdad, aunque el fondo cotice en dólares.</div></div>` : ''}
      ${pr ? `<div class="card"><h2>Riesgo de tu cartera (último año, con tu reparto actual)</h2><div class="kv">
        <div><span>Volatilidad anual</span><b>${num(pr.vol * 100, 0)}%</b></div>
        <div><span>Máxima caída</span><b class="down">${pctS(pr.maxDD)}</b></div>
        <div><span>Peor día</span><b class="down">${pctS(pr.worstDay)}</b></div>
        <div><span>Un día malo (1 de cada 20)</span><b class="down">${pctS(pr.var95)} ≈ ${eur(pr.var95 * total)}</b></div></div>
        <div class="small muted" style="margin-top:6px">Calculado en la moneda de cada activo, sin el efecto del euro.</div></div>` : ''}
      <div class="card"><h2>Riesgo por activo</h2><div class="scroll"><table><tr><th></th><th>Volat.</th><th>Máx. caída histórica</th><th>Desde máx.</th></tr>
        ${rows.sort((x, y) => (y.vol || 0) - (x.vol || 0)).map(r => `<tr><td>${esc(r.s.a.name)}</td><td>${r.vol == null ? '–' : num(r.vol * 100, 0) + '%'}</td>
          <td class="down">${r.dd ? pctS(r.dd.dd) + ' <span class="muted small">' + new Date(r.dd.troughT * 1000).getFullYear() + '</span>' : '–'}</td><td class="${r.dd && r.dd.current < -0.2 ? 'down' : ''}">${r.dd ? pctS(r.dd.current) : '–'}</td></tr>`).join('')}
        </table></div><div class="small muted" style="margin-top:6px">La máxima caída histórica te dice cuánto puede llegar a bajar en una mala racha. Pregúntate si aguantarías esa caída sin vender.</div></div>
      ${ids.length >= 2 ? `<div class="card"><h2>Correlación (último año)</h2>
        <div class="small muted" style="margin-bottom:6px">Cerca de 1 (rojo): se mueven juntos, no diversifican. Cerca de 0 o negativo (verde): se compensan.</div>
        <div class="scroll"><table style="font-size:10px"><tr><th></th>${ids.map(j => `<th style="writing-mode:vertical-rl;text-align:left;padding:2px">${esc(short(j))}</th>`).join('')}</tr>
        ${ids.map(i => `<tr><td style="padding:2px 4px">${esc(short(i))}</td>${ids.map(j => { const c = i === j ? 1 : M[i + '|' + j]; return `<td style="padding:2px;text-align:center;background:${color(c)}">${c == null ? '' : (c * 10).toFixed(0)}</td>`; }).join('')}</tr>`).join('')}
        </table></div><div class="small muted">Valores ×10 (8 = 0,8).</div>
        <h3>Los que más se mueven juntos</h3>${pairs.slice(0, Math.min(5, Math.max(1, pairs.length - 3))).map(p => `<div class="reason">${esc(name(p.i))} y ${esc(name(p.j))}: <b class="${p.c > 0.7 ? 'down' : ''}">${num(p.c, 2)}</b></div>`).join('')}
        ${pairs.length >= 8 ? `<h3>Los que más diversifican</h3>${pairs.slice(-3).reverse().map(p => `<div class="reason">${esc(name(p.i))} y ${esc(name(p.j))}: <b class="up">${num(p.c, 2)}</b></div>`).join('')}` : ''}</div>` : ''}
      <div class="disclaimer">${DISCLAIMER}</div>`;
    view.querySelectorAll('[data-pm]').forEach(b => b.onclick = () => { settings.planMode = b.dataset.pm; save('settings', settings); renderRisk(); });
    const showContrib = () => {
      const amt = parseFloat(($('#contrib') || {}).value || '0'); const out = $('#contribOut'); if (!out || !plan) return;
      if (!(amt > 0)) { out.innerHTML = '<span class="muted">Escribe cuánto vas a invertir este mes y te digo en qué activos ponerlo, sin vender nada.</span>'; return; }
      settings.monthly = amt; save('settings', settings);
      const cur = {}, tg = {}; plan.rows.forEach(r => { cur[r.id] = r.cw * plan.total; tg[r.id] = r.tw; });
      const cp = window.Portfolio.contributionPlan(cur, tg, amt, 10);
      out.innerHTML = cp.length ? cp.map(x => `<div class="reason"><b>${esc((assets.find(a => a.id === x.id) || {}).name || x.id)}</b>: ${eur(x.eur)} <span class="muted">(quedaría en ${num(x.after * 100, 1)}%, objetivo ${num(x.target * 100, 1)}%)</span></div>`).join('') +
        '<div class="muted" style="margin-top:4px">En Trade Republic puedes hacerlo con un plan de inversión o con órdenes sueltas. Las cantidades menores de 10 € se han juntado con las demás.</div>' : '<span class="muted">Con esa cantidad no hace falta repartir nada.</span>';
    };
    if ($('#contribBtn')) { $('#contribBtn').onclick = showContrib; showContrib(); }
    loadCrisis(held, total);
  }

  // ---------- Vista: Agenda ----------
  async function renderAgenda() {
    $('#title').textContent = 'Agenda';
    view.innerHTML = '<div class="loading">Buscando fechas…</div>';
    const today = new Date().toISOString().slice(0, 10);
    const limit = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
    const ev = [];
    (window.MACRO_EVENTS || []).forEach(([dt, label]) => ev.push({ date: dt, label, kind: 'macro' }));
    const sec = await secData().catch(() => null);
    await Promise.all(assets.map(async a => {
      let gotEarnings = false;
      if (!isCrypto(a)) {
        const ys = await yahooSummary(a.yahoo).catch(() => null);
        if (ys && (a.type === 'Acción' || a.type === 'Fondo cotizado')) {
          (ys.earnings || []).slice(0, 1).forEach(ts => { ev.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), label: `${a.name}: presenta resultados`, kind: 'res', a }); gotEarnings = true; });
        }
        if (ys && ys.exDiv) {
          ev.push({ date: new Date(ys.exDiv * 1000).toISOString().slice(0, 10), label: `${a.name}: fecha ex-dividendo${ys.divYield ? ' (rent. ' + num(ys.divYield * 100, 1) + '%)' : ''}`, kind: 'div', a });
        }
      }
      const s = a.sec && sec && sec.assets && sec.assets[a.sec];
      if (!gotEarnings && s && s.nextReport && a.type !== 'ETF') ev.push({ date: s.nextReport.estimate, label: `${a.name}: resultados (fecha estimada)`, kind: 'res', a, est: true });
      // Dividendos pasados para estimar el siguiente (útil en ETF de distribución).
      const d = await daily(a).catch(() => null);
      if (d && d.div && d.div.length >= 2) {
        const lastD = d.div[d.div.length - 1], prevD = d.div[d.div.length - 2];
        const step = lastD.t - prevD.t;
        const next = new Date((lastD.t + step) * 1000).toISOString().slice(0, 10);
        if (!ev.some(e => e.kind === 'div' && e.a === a && e.date >= today)) ev.push({ date: next, label: `${a.name}: próximo dividendo (estimado, último ${num(lastD.amount, 3)} ${esc(d.meta.currency || '')})`, kind: 'div', a, est: true });
      }
    }));
    if (current.name !== 'agenda') return;
    const kev = await keyEvents();
    const held = assets.filter(a => window.Portfolio.position(a).qty > 0);
    const big = kev.filter(e => e.date >= today && e.date <= new Date(Date.now() + 760 * 86400000).toISOString().slice(0, 10))
      .concat(ev.filter(e => e.kind === 'res' && e.a && window.Portfolio.position(e.a).qty > 0 && e.date >= today && e.date <= new Date(Date.now() + 75 * 86400000).toISOString().slice(0, 10))
        .map(e => ({ date: e.date, title: e.label, type: 'resultados', impact: 'alto', approx: e.est, only: e.a })))
      .sort((x, y) => x.date.localeCompare(y.date));
    const near = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    const chosen = big.filter(e => e.date <= near).slice(0, 8).concat(big.filter(e => e.date > near && (e.type === 'elecciones' || e.type === 'politica')));
    const tipSeen = new Set();
    const keyHtml = chosen.map(e => {
      const tip = tipSeen.has(e.type) ? '' : EVENT_TIPS[e.type] || ''; tipSeen.add(e.type);
      const dt = new Date(e.date + 'T12:00:00');
      const days = Math.round((dt - Date.now()) / 86400000);
      const aff = e.only ? [e.only] : held.filter(a => eventAffects(e, a));
      const affText = (e.themes || []).includes('todos') && !e.only ? 'toda tu cartera' : aff.map(a => a.name).join(', ') || 'ningún activo que tengas ahora';
      return `<div class="signal ${e.impact === 'alto' ? 'r' : 'y'}" style="margin-bottom:8px">
        <div class="row"><b class="grow">${esc(e.title)}</b><span class="badge">${e.impact === 'alto' ? 'impacto alto' : 'impacto medio'}</span></div>
        <div class="small">${dt.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${e.approx ? ' (aprox.)' : ''} · <b>${days <= 0 ? 'hoy' : days < 60 ? 'en ' + days + ' días' : 'en ' + Math.round(days / 30) + ' meses'}</b></div>
        <div class="small muted" style="margin-top:4px">Afecta a: ${esc(affText)}</div>
        ${tip ? `<div class="small" style="margin-top:4px">💡 ${esc(tip)}</div>` : ''}</div>`;
    }).join('');
    const up = ev.filter(e => e.date >= today && e.date <= limit).sort((x, y) => x.date.localeCompare(y.date));
    const icon = { macro: '🏦', res: '📊', div: '💶' };
    let lastMonth = '';
    view.innerHTML = `<div class="card"><h2>⚠️ Eventos clave que pueden mover mucho el precio</h2>${keyHtml || '<div class="muted">Ninguno próximo.</div>'}
      <div class="small muted">Para invertir a largo plazo, lo normal es no vender por un evento concreto, sino evitar comprar justo antes y no tener demasiado peso en un solo activo. La lista se actualiza sin instalar versiones nuevas.</div></div>
      <div class="card"><h2>Calendario completo (6 meses)</h2>
      ${up.map(e => {
        const dt = new Date(e.date + 'T12:00:00');
        const month = dt.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
        const head = month !== lastMonth ? `<h3 style="text-transform:capitalize">${month}</h3>` : '';
        lastMonth = month;
        const days = Math.round((dt - Date.now()) / 86400000);
        return head + `<div class="reason">${icon[e.kind]} <b>${dt.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' })}</b> ${esc(e.label)}${e.est ? ' <span class="badge">estimada</span>' : ''} <span class="muted small">${days <= 0 ? 'hoy' : 'en ' + days + ' d'}</span></div>`;
      }).join('') || '<div class="muted">Sin fechas.</div>'}</div>
      <div class="small muted">Las fechas de resultados y dividendos son de Yahoo Finance cuando están disponibles; si no, se estiman a partir de la última presentación. Las de la Fed y el BCE son oficiales. Antes de un resultado o una decisión de tipos el precio suele moverse más de lo normal.</div>`;
  }

  // ---------- Vista: Renta ----------
  function renderTax() {
    $('#title').textContent = 'Renta y plusvalías';
    const P = window.Portfolio;
    const all = [];
    assets.forEach(a => P.position(a).realized.forEach(r => all.push({ a, ...r })));
    const years = [...new Set(all.map(r => r.year))].sort((x, y) => y - x);
    const yr = current.year || years[0] || new Date().getFullYear();
    const rows = all.filter(r => r.year === yr).sort((x, y) => x.date.localeCompare(y.date));
    const known = rows.filter(r => r.gainEur != null);
    const gains = known.filter(r => r.gainEur > 0).reduce((s, r) => s + r.gainEur, 0);
    const losses = known.filter(r => r.gainEur < 0 && !r.washRisk).reduce((s, r) => s + r.gainEur, 0);
    const blocked = known.filter(r => r.gainEur < 0 && r.washRisk).reduce((s, r) => s + r.gainEur, 0);
    const net = gains + losses;
    const tax = P.savingsTax(net);
    const csv = ['Activo;Fecha venta;Cantidad;Valor transmisión €;Valor adquisición €;Ganancia/pérdida €']
      .concat(rows.map(r => [r.a.name, r.date, r.qty, r.proceedsEur ?? '', r.costEur != null ? r.costEur.toFixed(2) : '', r.gainEur != null ? r.gainEur.toFixed(2) : ''].join(';'))).join('\n');
    view.innerHTML = `
      <div class="pills">${(years.length ? years : [yr]).map(y => `<button class="pill ${y === yr ? 'on' : ''}" data-y="${y}">${y}</button>`).join('')}</div>
      <div class="card"><h2>Resumen ${yr}</h2><div class="kv">
        <div><span>Ganancias</span><b class="up">${eur(gains)}</b></div>
        <div><span>Pérdidas compensables</span><b class="down">${eur(losses)}</b></div>
        <div><span>Saldo neto</span><b class="${cls(net)}">${eur(net)}</b></div>
        <div><span>Impuesto estimado</span><b>${eur(tax)}</b></div></div>
        ${blocked ? `<div class="small warn" style="margin-top:8px">${eur(blocked)} de pérdidas no se pueden compensar todavía por la regla de los 2 meses (recompraste el mismo valor 2 meses antes o después). Se podrán usar cuando vendas esas acciones recompradas.</div>` : ''}
        ${net < 0 ? '<div class="small muted" style="margin-top:6px">Un saldo negativo se puede compensar con ganancias de los 4 años siguientes (y hasta un 25% con rendimientos como dividendos o intereses).</div>' : ''}
        <div class="small muted" style="margin-top:6px">Tramos del ahorro: 19% hasta 6.000 €, 21% hasta 50.000 €, 23% hasta 200.000 €, 27% hasta 300.000 €, 30% el resto. Se calcula por FIFO (primero en entrar, primero en salir), como exige Hacienda.</div></div>
      <div class="card"><h2>Ventas de ${yr}</h2>
        ${rows.length ? rows.map(r => `<div class="reason"><b>${esc(r.a.name)}</b> <span class="muted small">${esc(r.date)}</span><div class="small">
          Vendes ${num(r.qty, r.qty % 1 ? 4 : 0)} · cobras ${r.proceedsEur != null ? eur(r.proceedsEur) : '?'} · te costaron ${r.costEur != null ? eur(r.costEur) : '?'} ·
          <b class="${cls(r.gainEur)}">${r.gainEur != null ? (r.gainEur >= 0 ? '+' : '') + eur(r.gainEur) : 'falta el importe en euros'}</b>
          ${r.washRisk ? ' <span class="badge">regla 2 meses</span>' : ''}${r.oversold ? ' <span class="badge">vendes más de lo apuntado</span>' : ''}${isCrypto(r.a) ? ' <span class="badge">cripto</span>' : ''}</div></div>`).join('')
          : '<div class="muted">No hay ventas apuntadas este año. Apunta tus ventas en cada activo, en «Mi posición».</div>'}</div>
      <div class="card"><h2>Para el borrador de la renta</h2><div class="small muted">Copia esta tabla; tiene los datos que pide la declaración por cada venta.</div><textarea rows="5" readonly>${esc(csv)}</textarea></div>
      <div class="disclaimer">Estimación orientativa. No incluye dividendos, intereses ni otras rentas del ahorro, ni deducciones. Las criptomonedas también tributan por FIFO; las permutas entre criptos también generan ganancia o pérdida. Consúltalo con un asesor fiscal o con el borrador de Hacienda.</div>`;
    view.querySelectorAll('[data-y]').forEach(b => b.onclick = () => { current.year = +b.dataset.y; renderTax(); });
    if (yr === new Date().getFullYear()) yearEndTax().then(t => { if (current.name === 'renta') view.insertAdjacentHTML('afterbegin', yearEndCard(t)); }).catch(() => {});
  }

  // ---------- Simulador de crisis ----------
  const CRISES = [
    ['Crisis financiera 2008', '2007-10-09', '2009-03-09', 'Quiebra de Lehman Brothers y crisis bancaria mundial.'],
    ['Caída de finales de 2018', '2018-09-20', '2018-12-24', 'Subidas de tipos de la Fed y guerra comercial con China.'],
    ['Pandemia 2020', '2020-02-19', '2020-03-23', 'Confinamientos por la COVID-19: la caída más rápida de la historia.'],
    ['Inflación y tipos 2022', '2022-01-03', '2022-10-12', 'Inflación alta, subidas de tipos y caída de tecnológicas y criptos.'],
    ['Invierno cripto 2018', '2018-01-06', '2018-12-15', 'Pinchazo de la burbuja de las criptomonedas de 2017.']
  ];
  async function loadCrisis(held, total) {
    const card = $('#crisisCard'); if (!card || !held.length) return;
    const P = window.Portfolio;
    const spx = await yahoo('^GSPC', 'max', '1wk').catch(() => null);
    const btcA = assets.find(a => a.id === 'btc');
    const btc = await yahoo(btcA ? btcA.yahoo : 'BTC-USD', 'max', '1wk').catch(() => null);
    const day = s => Date.parse(s + 'T00:00:00Z') / 1000;
    // Peor caída dentro de la ventana, desde el precio del inicio.
    const drop = (w, a0, a1) => {
      if (!w || !w.t.length || w.t[0] > a0 + 8 * 86400) return null;
      let i0 = 0; while (i0 + 1 < w.t.length && w.t[i0 + 1] <= a0) i0++;
      let lo = w.c[i0]; for (let i = i0; i < w.t.length && w.t[i] <= a1 + 7 * 86400; i++) lo = Math.min(lo, w.c[i]);
      return lo / w.c[i0] - 1;
    };
    const months = (w, a0, a1) => { // meses hasta recuperar el nivel del inicio
      if (!w || !w.t.length || w.t[0] > a0 + 8 * 86400) return null; let i0 = 0; while (i0 + 1 < w.t.length && w.t[i0 + 1] <= a0) i0++;
      for (let i = i0 + 1; i < w.t.length; i++) if (w.t[i] > a1 && w.c[i] >= w.c[i0]) return Math.round((w.t[i] - w.t[i0]) / 2629800);
      return null;
    };
    const vol = w => { if (!w || w.c.length < 30) return null; const r = A.priceRanges(w, w.c[w.c.length - 1]); return r ? r[0].volYear : null; };
    const ws = {}; await Promise.all(held.map(async s => { ws[s.a.id] = await yahoo(s.a.yahoo, 'max', '1wk').catch(() => null); }));
    const vSpx = vol(spx), vBtc = vol(btc);
    const res = CRISES.map(([name, d0, d1, why]) => {
      const a0 = day(d0), a1 = day(d1);
      const mkt = drop(spx, a0, a1), mktB = drop(btc, a0, a1);
      let loss = 0, est = 0, worst = null;
      const items = held.map(s => {
        let d = drop(ws[s.a.id], a0, a1), estimated = false;
        if (d == null) { // sin historial: se estima con el mercado de referencia y su volatilidad relativa
          const v = vol(ws[s.a.id]);
          if (isCrypto(s.a) && mktB != null) d = Math.max(-0.95, mktB * (v && vBtc ? v / vBtc : 1));
          else if (mkt != null) d = Math.max(-0.95, mkt * (v && vSpx ? Math.min(3, v / vSpx) : 1.5));
          estimated = true;
        }
        if (d == null) return null;
        loss += s.value * d; if (estimated) est += s.value;
        if (!worst || d < worst.d) worst = { name: s.a.name, d };
        return { d, estimated };
      });
      if (!items.some(Boolean)) return null;
      return { name, why, d0, d1, mkt, loss, pct: total ? loss / total : null, estShare: total ? est / total : 0, worst, rec: months(spx, a0, a1) };
    }).filter(Boolean);
    if (!res.length) { card.innerHTML = '<h2>Simulador de crisis</h2><div class="muted small">No se ha podido descargar el historial del mercado. Prueba más tarde.</div>'; return; }
    card.innerHTML = `<h2>Simulador de crisis</h2><div class="small muted" style="margin-bottom:8px">Cuánto habría caído tu cartera actual (${eur(total)}) en el peor momento de cada crisis. Para los activos que aún no existían se estima a partir del mercado y de lo que se mueve cada uno.</div>
      ${res.map(r => `<div style="margin:10px 0"><div class="row"><b class="grow">${esc(r.name)}</b><b class="down">${r.pct != null ? pctS(r.pct) : '–'} · ${eur(r.loss)}</b></div>
        <div style="height:8px;border-radius:5px;background:var(--card2);margin:5px 0"><div style="height:8px;border-radius:5px;width:${Math.min(100, Math.abs((r.pct || 0) * 100)).toFixed(0)}%;background:var(--down)"></div></div>
        <div class="small muted">${esc(r.why)} S&P 500: ${r.mkt != null ? pctS(r.mkt) : '–'}${r.rec ? `, tardó ${r.rec} meses en recuperarse` : ''}. Lo que más habría caído: ${r.worst ? esc(r.worst.name) + ' (' + pctS(r.worst.d) + ')' : '–'}.${r.estShare > 0.05 ? ` Un ${num(r.estShare * 100, 0)}% de la cartera es estimado.` : ''}</div></div>`).join('')}
      <div class="small muted">Supone que todo toca fondo a la vez, así que es el peor caso. No incluye el efecto del euro. Pregúntate si aguantarías esa caída sin vender: quien vende en el fondo convierte la caída en pérdida real.</div>`;
  }

  // ---------- Oportunidades de compra ----------
  // La prueba histórica dice que la señal sola apenas acierta la dirección, pero que comprar lo que se ha quedado
  // por debajo del reparto propuesto (rebalancear con dinero nuevo) sí mejoró el resultado y redujo caídas.
  // Por eso la lista combina: hueco en el reparto (lo que más pesa), la señal de la app y si la señal ha funcionado antes en ese activo.
  function oppOut(r, i, del) {
    return `<div class="opp"><div class="row"><span class="badge">${del ? '★' : i + 1}</span><b class="grow" style="font-size:16px">${esc(r.w.name)}</b><span class="dot ${r.kind}"></span>${del ? `<button class="icon" data-wdel="${esc(del)}">✕</button>` : ''}</div>
      <div class="small muted">${esc(r.w.tag)} · ${esc(r.w.yahoo)}${r.y1 != null ? ` · último año <span class="${cls(r.y1)}">${pctS(r.y1)}</span>` : ''}</div>
      <div class="kv" style="margin-top:8px"><div><span>Precio ahora</span><b>${num(r.pxEur, 2)} €</b></div><div><span>Precio de entrada orientativo</span><b class="up">${num(r.limit, 2)} €</b></div></div>
      <div class="small muted" style="margin-top:4px">La app dice «${esc(r.label)}»${r.night ? ' (revisión de anoche, precio en dólares pasado a euros)' : ''}.</div></div>`;
  }
  async function renderOpps() {
    $('#title').textContent = 'Oportunidades de compra';
    view.innerHTML = `<div class="card"><div class="small muted">Analizando tus ${assets.length} activos y ${(window.WATCHLIST || []).length} más del mercado: reparto, señal, tendencia y precios… (tarda un poco la primera vez)</div></div>`;
    const fg = { stocks: await fearGreedStocks().catch(() => null), crypto: await fearGreedCrypto().catch(() => null) };
    const snaps = (await Promise.all(assets.map(a => snapshot(a).catch(() => null)))).filter(Boolean);
    if (current.name !== 'oportunidades') return;
    const plan = riskPlan(snaps);
    const gap = {}; if (plan) plan.rows.forEach(r => gap[r.id] = r);
    const regimes = {};
    const rows = await Promise.all(snaps.map(async sn => {
      const a = sn.a, d = sn.d;
      const key = isCrypto(a) ? 'c' : 's';
      if (!(key in regimes)) regimes[key] = marketRegime(a).catch(() => null);
      const regime = await regimes[key];
      const ev = A.evaluate(d, { fearGreed: isCrypto(a) ? fg.crypto : fg.stocks, rules: a.rules, regime });
      const bt = await assetBacktest(a).catch(() => null);
      const ver = bt ? A.backtestVerdict(bt, ev.score) : null;
      const b = A.bucketOf(ev.score);
      const g = gap[a.id] || null, diff = g ? g.diff : 0;
      // Precio de entrada: una bajada normal de una semana según lo que se mueve el activo (se toca más o menos la mitad de las veces).
      const c = d.c.slice(-61), lr = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) lr.push(Math.log(c[i] / c[i - 1]));
      const mu = lr.reduce((x, y) => x + y, 0) / (lr.length || 1);
      const sdD = lr.length > 20 ? Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / (lr.length - 1)) : 0.02;
      const pxEur = sn.price * sn.fx, limit = pxEur * Math.exp(-0.7 * sdD * Math.sqrt(5));
      const sma50 = c.length >= 50 ? c.slice(-50).reduce((x, y) => x + y, 0) / 50 * sn.fx : null;
      let rank = diff * 100 + ev.score * 1.5 + (ver && ver.worked && (b === 'buy' || b === 'acc') ? 0.5 : 0);
      return { sn, a, ev, b, ver, diff, g, pxEur, limit, sma50, rank, sdD };
    }));
    // Fuera de tu cartera: solo la señal (no hay reparto que completar), así que se exige que sea claramente favorable.
    const mine = new Set(assets.map(a => a.yahoo));
    const evalW = async w => {
      try {
        const d = await yahoo(w.yahoo, '2y', '1d'); if (d.c.length < 200) return null;
        const fx = await fxToEur(d.meta.currency); const key = isCrypto(w) ? 'c' : 's';
        if (!(key in regimes)) regimes[key] = marketRegime(w).catch(() => null);
        const ev = A.evaluate(d, { fearGreed: isCrypto(w) ? fg.crypto : fg.stocks, regime: await regimes[key] });
        const c = d.c.slice(-61), lr = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) lr.push(Math.log(c[i] / c[i - 1]));
        const mu = lr.reduce((x, y) => x + y, 0) / (lr.length || 1), sdD = Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / Math.max(1, lr.length - 1));
        const pxEur = (d.meta.price || d.c[d.c.length - 1]) * fx;
        return { w: { name: w.name, yahoo: w.yahoo, tag: w.tag || w.type || '' }, score: ev.score, label: ev.label, kind: ev.kind, b: A.bucketOf(ev.score), pxEur, limit: pxEur * Math.exp(-0.7 * sdD * Math.sqrt(5)), y1: A.changeSince(d.t, d.c, 365) };
      } catch (e) { return null; }
    };
    // Los ~100 de la lista se revisan como mucho cada 6 horas (se guarda el resultado), para no saturar a Yahoo.
    const [phoneRes, scan, usd] = await Promise.all([
      cached('opp-watch:' + (window.WATCHLIST || []).length, 360, async () => (await Promise.all((window.WATCHLIST || []).map(evalW))).filter(Boolean)).catch(() => []),
      cached('scan:' + settings.dataRepo, 360, async () => { const r = await http(`https://raw.githubusercontent.com/${settings.dataRepo}/${settings.branch}/data/scan.json`); return r.status === 200 ? JSON.parse(r.text) : null; }).catch(() => null),
      fxToEur('USD').catch(() => null)
    ]);
    const seen = new Set([...mine, ...(window.WATCHLIST || []).map(w => w.yahoo)]);
    const fromScan = scan && usd ? scan.top.filter(x => !seen.has(x.sym)).map(x => ({ w: { name: x.name, yahoo: x.sym, tag: [x.sector, x.idx].filter(Boolean).join(' · ') }, score: x.score, label: x.label, kind: x.kind, b: x.b, pxEur: x.px * usd, limit: x.limit * usd, y1: x.y1, night: true })) : [];
    const outside = [...phoneRes.filter(r => !mine.has(r.w.yahoo)), ...fromScan].filter(r => r.b === 'buy' || r.b === 'acc').sort((x, y) => y.score - x.score).slice(0, 8);
    const watchN = (window.WATCHLIST || []).length + (scan ? scan.scanned : 0);
    const own = (settings.watch || []).length ? (await Promise.all(settings.watch.map(evalW))) : [];
    if (current.name !== 'oportunidades') return;
    const good = rows.filter(r => r.b !== 'caut' && r.b !== 'sell' && (r.diff > 0.005 || r.b === 'buy' || r.b === 'acc')).sort((x, y) => y.rank - x.rank).slice(0, 5);
    const wait = rows.filter(r => r.b === 'caut' || r.b === 'sell' || (r.g && r.g.out && r.diff < 0)).sort((x, y) => x.ev.score - y.ev.score).slice(0, 6);
    const monthly = +settings.monthly || 0;
    const card = (r, i) => {
      const amt = r.g && r.diff > 0 ? Math.max(10, Math.round((monthly ? Math.min(monthly / 2, r.diff * plan.total) : r.diff * plan.total) / 10) * 10) : null;
      const why = [];
      if (r.diff > 0.005) why.push(`pesa ${num(r.g.cw * 100, 1)}% en tu cartera y el reparto propuesto es ${num(r.g.tw * 100, 1)}%`);
      why.push(`la app dice «${esc(r.ev.label)}»`);
      if (r.ver && (r.b === 'buy' || r.b === 'acc')) why.push(r.ver.worked ? 'y en su historial esta señal ha funcionado' : 'aunque en su historial esta señal no ha funcionado mucho');
      const when = r.b === 'buy' || r.b === 'acc'
        ? `Puedes comprar ahora o poner una <b>orden límite a ${num(r.limit, 2)} €</b> válida una semana.`
        : `Sin prisa: pon una <b>orden límite a ${num(r.limit, 2)} €</b> válida una semana. Si no se ejecuta, cómpralo con tu próxima aportación al precio que esté.`;
      return `<div class="opp"><div class="row"><span class="badge">${i + 1}</span><b class="grow" style="font-size:16px">${esc(r.a.name)}</b><span class="dot ${r.ev.kind}"></span></div>
        <div class="kv" style="margin-top:8px"><div><span>Precio ahora</span><b>${num(r.pxEur, 2)} €</b></div><div><span>Precio de entrada orientativo</span><b class="up">${num(r.limit, 2)} €</b></div>
        ${amt ? `<div><span>Cuánto, orientativo</span><b>${eur(amt)}</b></div>` : ''}${r.sma50 ? `<div><span>Media de 50 días</span><b>${num(r.sma50, 2)} €</b></div>` : ''}</div>
        <div class="small" style="margin-top:6px">${when}</div>
        <div class="small muted" style="margin-top:4px">Por qué: ${why.join(', ')}.</div></div>`;
    };
    view.innerHTML = `<div class="card"><h2>🎯 En tu cartera: mejores opciones hoy</h2>
        <div class="small muted" style="margin-bottom:6px">Ordenadas combinando tres cosas: lo que le falta a cada activo para llegar al reparto propuesto (lo que más ha funcionado en la prueba histórica), la señal de la app y si esa señal ha acertado antes en ese activo. El precio de entrada es una bajada normal de una semana para ese activo: se alcanza más o menos la mitad de las veces.</div>
        ${good.length ? good.map(card).join('') : '<div class="muted">Hoy ningún activo destaca para comprar: todos están cerca de su reparto o con señal de precaución. Esperar también es una decisión.</div>'}</div>
      <div class="card"><h2>🌍 Fuera de tu cartera</h2>
        <div class="small muted" style="margin-bottom:6px">Revisados ${num(watchN, 0)} activos: ${(window.WATCHLIST || []).length} en el móvil (ETFs, grandes de EE. UU., Euro Stoxx 50 e IBEX 35)${scan ? ` y ${scan.scanned} del S&P 500 y Nasdaq 100 cada noche (último: ${esc(scan.date)})` : ''}. Aquí solo cuenta la señal de la app, que es la parte menos fiable, así que si te interesa alguno empieza con poco (por ejemplo, un 2-3% de tu cartera).</div>
        ${outside.length ? outside.map((r, i) => oppOut(r, i)).join('') : '<div class="muted small">Hoy ninguno da una señal claramente favorable.</div>'}</div>
      <div class="card" id="ownCard"><h2>⭐ Tu lista</h2><div class="small muted" style="margin-bottom:6px">Activos que quieres vigilar aunque no los tengas. Aquí salen siempre, con la señal que tengan.</div>
        ${own.map((r, i) => r ? oppOut(r, i, settings.watch[i].yahoo) : `<div class="reason small">${esc(settings.watch[i].name)}: sin datos ahora <button class="icon" data-wdel="${esc(settings.watch[i].yahoo)}">✕</button></div>`).join('') || '<div class="muted small">Aún no has añadido ninguno.</div>'}
        <input id="wq" placeholder="Añadir: busca por nombre o ticker (ej. Coca-Cola, KO)" style="margin-top:8px"><div id="wres"></div></div>
      ${wait.length ? `<div class="card"><h2>⏸️ Mejor esperar</h2>${wait.map(r => `<div class="reason small"><b>${esc(r.a.name)}</b>: ${r.b === 'caut' || r.b === 'sell' ? `la app dice «${esc(r.ev.label)}»` : `ya pesa ${num(r.g.cw * 100, 1)}% (propuesto ${num(r.g.tw * 100, 1)}%)`}.</div>`).join('')}</div>` : ''}
      <div class="card small muted">Fear & Greed: bolsa ${fg.stocks ? Math.round(fg.stocks.score) : '–'}, cripto ${fg.crypto ? Math.round(fg.crypto.score) : '–'}. Los precios en euros son al cambio de hoy; en Trade Republic el precio puede variar un poco según la bolsa. ${monthly ? `Las cantidades parten de tu aportación de ${eur(monthly)} al mes (Riesgo).` : 'Si pones tu aportación mensual en Riesgo > Reparto propuesto, las cantidades se ajustan a ella.'}</div>
      <div class="disclaimer">Lista orientativa generada automáticamente, no es asesoramiento financiero. Nadie sabe si un precio va a subir o bajar: la prueba histórica muestra que la app acierta la dirección poco más que el azar, y que lo que más ayuda es repartir bien y comprar de forma regular. Decide tú y no inviertas dinero que puedas necesitar.</div>`;
    view.querySelectorAll('[data-wdel]').forEach(b => b.onclick = () => { settings.watch = (settings.watch || []).filter(x => x.yahoo !== b.dataset.wdel); save('settings', settings); renderOpps(); });
    let tm; $('#wq').oninput = () => { clearTimeout(tm); tm = setTimeout(async () => {
      const q = $('#wq').value.trim(); if (q.length < 2) { $('#wres').innerHTML = ''; return; }
      try {
        const r = await http(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
        const qs = (JSON.parse(r.text).quotes || []).filter(x => x.symbol && ['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'MUTUALFUND', 'FUTURE'].includes(x.quoteType));
        $('#wres').innerHTML = qs.map((x, i) => `<div class="asset" data-wi="${i}"><div class="grow"><div class="name">${esc(x.shortname || x.longname || x.symbol)}</div><div class="small muted">${esc(x.symbol)} · ${esc(x.exchDisp || '')}</div></div><b>+</b></div>`).join('') || '<div class="small muted">Sin resultados</div>';
        $('#wres').querySelectorAll('[data-wi]').forEach(el => el.onclick = () => {
          const x = qs[+el.dataset.wi];
          const type = { EQUITY: 'Acción', ETF: 'ETF', CRYPTOCURRENCY: 'Cripto', FUTURE: 'Materia prima', MUTUALFUND: 'Fondo cotizado' }[x.quoteType] || 'Acción';
          settings.watch = (settings.watch || []).filter(w => w.yahoo !== x.symbol).concat([{ name: x.shortname || x.longname || x.symbol, yahoo: x.symbol, type, tag: type }]);
          save('settings', settings); toast('Añadido a tu lista'); renderOpps();
        });
      } catch (e) { $('#wres').innerHTML = '<div class="small warn">No se pudo buscar ahora</div>'; }
    }, 400); };
  }

  // ---------- Diario de decisiones ----------
  const ACTIONS = { compra: 'Compro', venta: 'Vendo', mantener: 'Mantengo', idea: 'Vigilo' };
  function journal() { return settings.journal || (settings.journal = []); }
  async function renderJournal() {
    $('#title').textContent = 'Diario de decisiones';
    const J = journal();
    view.innerHTML = `<div class="card"><h2>Apuntar una decisión</h2>
        <label>Activo</label><select id="jAsset">${assets.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
        <label>Qué haces</label><select id="jAct">${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <label>Por qué (en tus palabras)</label><textarea id="jWhy" rows="3" placeholder="Ej.: ha caído mucho tras resultados pero el negocio sigue creciendo"></textarea>
        <label>Qué esperas que pase (opcional)</label><input id="jExp" placeholder="Ej.: que recupere 150 $ en 6 meses">
        <div class="btns"><button class="btn" id="jSave">Guardar</button></div>
        <div class="small muted">Se guarda también el precio y lo que decía la app ese día, para que con el tiempo veas qué te funciona.</div></div>
      <div class="card" id="jStats"><h2>Qué te funciona</h2><div class="muted small">Calculando…</div></div>
      <div class="card"><h2>Tus decisiones</h2><div id="jList">${J.length ? '' : '<div class="muted">Aún no has apuntado ninguna.</div>'}</div></div>
      <div class="disclaimer">El diario solo está en este móvil y en tu copia de seguridad (Ajustes).</div>`;
    $('#jSave').onclick = async () => {
      const a = assets.find(x => x.id === $('#jAsset').value); const why = $('#jWhy').value.trim();
      if (!why) { toast('Escribe el motivo'); return; }
      $('#jSave').disabled = true;
      let price = null, ccy = '', sig = null;
      try { const d = await daily(a); price = d.meta.price || d.c[d.c.length - 1]; ccy = d.meta.currency || '';
        const fg = await (isCrypto(a) ? fearGreedCrypto() : fearGreedStocks()).catch(() => null);
        const ev = A.evaluate(d, { fearGreed: fg }); sig = { label: ev.label, kind: ev.kind, score: Math.round(ev.score * 100) / 100 }; } catch (e) {}
      J.unshift({ id: Date.now().toString(36), date: new Date().toISOString().slice(0, 10), asset: a.id, action: $('#jAct').value, why, expect: $('#jExp').value.trim(), price, ccy, sig });
      save('settings', settings); toast('Decisión guardada'); renderJournal();
    };
    // Resultado de cada decisión: cómo ha ido el precio desde entonces.
    const rows = await Promise.all(J.map(async j => {
      const a = assets.find(x => x.id === j.asset); let now = null;
      if (a && j.price) { const d = await daily(a).catch(() => null); if (d) now = d.meta.price || d.c[d.c.length - 1]; }
      const ch = now && j.price ? now / j.price - 1 : null;
      const days = Math.round((Date.now() - Date.parse(j.date)) / 86400000);
      const good = ch == null || days < 30 || j.action === 'idea' ? null : j.action === 'venta' ? ch < 0 : ch > 0;
      const withApp = j.sig ? (j.action === 'compra' && j.sig.kind === 'g') || (j.action === 'venta' && j.sig.kind === 'r') || (j.action === 'mantener' && j.sig.kind !== 'r') : null;
      return { j, a, ch, days, good, withApp };
    }));
    if (current.name !== 'diario') return;
    $('#jList').innerHTML = rows.map(r => `<div class="reason"><div class="row"><b class="grow">${esc(ACTIONS[r.j.action])} ${esc(r.a ? r.a.name : r.j.asset)}</b><span class="muted small">${esc(r.j.date)}</span>
        <button class="icon" data-jdel="${esc(r.j.id)}">✕</button></div>
      <div class="small">${esc(r.j.why)}</div>${r.j.expect ? `<div class="small muted">Esperabas: ${esc(r.j.expect)}</div>` : ''}
      <div class="small muted">Precio entonces ${r.j.price ? num(r.j.price) + ' ' + esc(r.j.ccy) : '–'}${r.ch != null ? ` · desde entonces <b class="${cls(r.ch)}">${pctS(r.ch)}</b>` : ''}${r.j.sig ? ` · la app decía «${esc(r.j.sig.label)}»` : ''}
      ${r.good != null ? ` · <b class="${r.good ? 'up' : 'down'}">${r.good ? 'de momento, bien' : 'de momento, mal'}</b>` : r.days < 30 ? ' · demasiado pronto para valorar' : ''}</div></div>`).join('') || '<div class="muted">Aún no has apuntado ninguna.</div>';
    view.querySelectorAll('[data-jdel]').forEach(b => b.onclick = () => { settings.journal = J.filter(x => x.id !== b.dataset.jdel); save('settings', settings); renderJournal(); });
    const judged = rows.filter(r => r.good != null);
    const rate = L => L.length ? `${num(L.filter(r => r.good).length / L.length * 100, 0)}% bien (${L.length})` : '–';
    $('#jStats').innerHTML = `<h2>Qué te funciona</h2>${judged.length < 3 ? `<div class="muted small">Cuando tengas al menos 3 decisiones con más de un mes, aquí verás cuántas salieron bien, y si te va mejor cuando sigues a la app o cuando vas por libre. Llevas ${J.length}.</div>` :
      `<div class="kv"><div><span>Todas</span><b>${rate(judged)}</b></div><div><span>Compras</span><b>${rate(judged.filter(r => r.j.action === 'compra'))}</b></div>
        <div><span>Ventas</span><b>${rate(judged.filter(r => r.j.action === 'venta'))}</b></div><div><span>Mantener</span><b>${rate(judged.filter(r => r.j.action === 'mantener'))}</b></div>
        <div><span>Cuando coincidías con la app</span><b>${rate(judged.filter(r => r.withApp === true))}</b></div><div><span>Cuando ibas en contra</span><b>${rate(judged.filter(r => r.withApp === false))}</b></div></div>
        <div class="small muted" style="margin-top:6px">«Bien» = el precio fue en la dirección que te convenía. Con pocas decisiones, el azar pesa mucho: míralo con calma.</div>`}`;
  }

  // ---------- Impuestos antes de fin de año ----------
  async function yearEndTax() {
    const P = window.Portfolio, y = new Date().getFullYear();
    let realized = 0;
    assets.forEach(a => P.position(a).realized.forEach(r => { if (r.year === y && r.gainEur != null && !r.washRisk) realized += r.gainEur; }));
    const snaps = (await Promise.all(assets.map(a => snapshot(a).catch(() => null)))).filter(s => s && s.value > 0 && s.plEur != null);
    const now = Date.now(), two = 61 * 86400000;
    const losers = snaps.filter(s => s.plEur < -10).map(s => {
      const recentBuy = (s.a.ops || []).filter(o => o.type === 'compra' && now - Date.parse(o.date) < two).map(o => o.date).sort().pop();
      return { s, loss: s.plEur, recentBuy };
    }).sort((x, z) => x.loss - z.loss);
    const winners = snaps.filter(s => s.plEur > 10).map(s => ({ s, gain: s.plEur })).sort((x, z) => z.gain - x.gain);
    let saving = 0, used = 0;
    if (realized > 0) for (const l of losers) { if (l.recentBuy) continue; const take = Math.min(-l.loss, realized - used); if (take <= 0) break; used += take; }
    saving = P.savingsTax(realized) - P.savingsTax(realized - used);
    return { y, realized, losers, winners, saving, used };
  }
  function yearEndCard(t) {
    const until = new Date(Date.now() + 61 * 86400000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    let body = '';
    if (t.realized > 0) {
      body += `<div class="small">Este año llevas <b class="up">${eur(t.realized)}</b> de ganancias por ventas. Si vendes antes del 31 de diciembre posiciones que van en pérdidas, esas pérdidas restan y pagas menos.</div>`;
      body += t.losers.length ? t.losers.slice(0, 6).map(l => `<div class="reason small"><b>${esc(l.s.a.name)}</b>: ${eur(l.loss)}${l.recentBuy ? ` · <span class="warn">compraste el ${esc(l.recentBuy)}: por la regla de los 2 meses esa pérdida no contaría todavía</span>` : ''}</div>`).join('') + (t.losers.length > 6 ? `<div class="small muted">y ${t.losers.length - 6} más con pérdidas menores.</div>` : '') +
        (t.saving > 1 ? `<div class="reason up small">Ahorro estimado: unos ${eur(t.saving)} de impuestos.</div>` : '') : '<div class="small muted">No tienes posiciones con pérdidas para compensar.</div>';
    } else if (t.realized < 0) {
      body += `<div class="small">Llevas <b class="down">${eur(t.realized)}</b> de pérdidas por ventas este año. Puedes vender posiciones con ganancias por ese importe sin pagar impuestos (y volver a comprarlas, porque la regla de los 2 meses solo afecta a las pérdidas): así subes tu precio de compra a efectos fiscales.</div>` +
        t.winners.slice(0, 5).map(w => `<div class="reason small"><b>${esc(w.s.a.name)}</b>: +${eur(w.gain)}</div>`).join('') +
        '<div class="small muted">Si no las usas, las pérdidas se guardan para compensar en los 4 años siguientes.</div>';
    } else {
      body += `<div class="small">No hay ventas apuntadas este año, así que no hay ganancias que compensar. Vender ahora con pérdidas no te ahorra nada este año, aunque la pérdida se guardaría 4 años para el futuro.</div>`;
      if (t.losers.length) body += `<div class="small muted" style="margin-top:4px">Posiciones en pérdidas ahora: ${t.losers.slice(0, 6).map(l => `${esc(l.s.a.name)} (${eur(l.loss)})`).join(', ')}.</div>`;
    }
    body += `<div class="small muted" style="margin-top:6px"><b>Regla de los 2 meses:</b> si vendes acciones o ETFs con pérdidas y compras los mismos 2 meses antes o después (si vendes hoy, hasta el ${until}), Hacienda no deja restar esa pérdida hasta que vendas los recomprados. Según el criterio actual de Hacienda no se aplica a criptomonedas, pero confírmalo con un asesor. Importes en euros desde tu precio de compra; estimación orientativa.</div>`;
    return `<div class="card"><h2>Antes del 31 de diciembre de ${t.y}</h2>${body}</div>`;
  }

  // ---------- Vista: Mercado ----------
  const MACRO = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^STOXX50E', 'Euro Stoxx 50'], ['^IBEX', 'IBEX 35'], ['^VIX', 'VIX (miedo)'], ['^TNX', 'Bono EE. UU. 10 años'], ['GC=F', 'Oro'], ['HG=F', 'Cobre'], ['BZ=F', 'Petróleo Brent'], ['EURUSD=X', 'EUR/USD'], ['DX-Y.NYB', 'Índice dólar']];
  async function renderMarket() {
    $('#title').textContent = 'Mercado y geopolítica';
    const myThemes = [...new Set(assets.flatMap(a => a.themes || []))].filter(k => window.THEMES[k]);
    view.innerHTML = `
      <div class="card"><h2>Miedo y codicia</h2><div id="fg" class="muted">Cargando…</div></div>
      <div class="card"><h2>Indicadores del mercado</h2><div id="macro" class="muted">Cargando…</div></div>
      <div class="card" id="notesCard" style="display:none"></div>
      <h3 style="margin:14px 4px 8px">Geopolítica y macro que afectan a tu cartera</h3>
      <div id="geo">${myThemes.map(k => `<div class="card"><h2>${esc(window.THEMES[k].label)}</h2><div id="th-${k}" class="muted small">Cargando…</div></div>`).join('')}</div>
      <div class="disclaimer">${DISCLAIMER}</div>`;
    const [s, c] = await Promise.all([fearGreedStocks().catch(() => null), fearGreedCrypto().catch(() => null)]);
    const gauge = (name, x) => x ? `<div style="margin-bottom:10px"><div class="row"><b class="grow">${name}</b><b>${Math.round(x.score)}</b></div>
      <div class="gauge"><i style="left:calc(${x.score}% - 2px)"></i></div><div class="small muted">${esc(fgLabel(x.score))} · hace una semana ${Math.round(x.prevWeek)} · hace un mes ${Math.round(x.prevMonth)}</div></div>` : `<div class="small warn">${name}: sin datos</div>`;
    $('#fg').innerHTML = gauge('Bolsa (CNN)', s) + gauge('Cripto', c) + '<div class="small muted">0 = miedo extremo, 100 = codicia extrema (FOMO). Comprar con miedo y ser prudente con codicia suele funcionar mejor a largo plazo.</div>';
    const rows = await Promise.all(MACRO.map(async ([sym, name]) => {
      try { const d = await yahoo(sym, '1y', '1d'); const p = d.meta.price || d.c[d.c.length - 1]; return { name, p, d1: d.meta.prev ? p / d.meta.prev - 1 : null, m1: A.changeSince(d.t, d.c, 30), y1: A.changeSince(d.t, d.c, 365) }; }
      catch (e) { return { name, p: null }; }
    }));
    $('#macro').innerHTML = `<div class="scroll"><table><tr><th></th><th>Valor</th><th>Hoy</th><th>1 mes</th><th>1 año</th></tr>${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${num(r.p)}</td><td class="${cls(r.d1)}">${pctS(r.d1)}</td><td class="${cls(r.m1)}">${pctS(r.m1)}</td><td class="${cls(r.y1)}">${pctS(r.y1)}</td></tr>`).join('')}</table></div>`;
    const notes = await analysisNotes();
    if (notes && notes.market) { const nc = $('#notesCard'); nc.style.display = ''; nc.innerHTML = `<h2>Resumen del día <span class="badge">${esc(notes.date || '')}</span></h2><div style="white-space:pre-wrap">${esc(notes.market)}</div>`; }
    await Promise.all(myThemes.map(async k => {
      const items = await news(window.THEMES[k].q, { days: 7, esOnly: true }).catch(() => []);
      const el = $('#th-' + k); if (!el) return;
      const affected = assets.filter(a => (a.themes || []).includes(k)).map(a => a.name);
      el.className = '';
      el.innerHTML = `<div class="small muted" style="margin-bottom:4px">Afecta a: ${esc(affected.join(', '))}</div>${newsList(items, 5)}`;
    }));
  }
  function fgLabel(v) { return v < 25 ? 'Miedo extremo' : v < 45 ? 'Miedo' : v <= 55 ? 'Neutral' : v <= 75 ? 'Codicia' : 'Codicia extrema'; }

  // ---------- Vista: Ajustes ----------
  function renderSettings() {
    $('#title').textContent = 'Ajustes';
    view.innerHTML = `
      <div class="card"><h2>Mis activos</h2>
        ${assets.map((a, i) => `<div class="asset"><div class="grow"><div class="name">${esc(a.name)}</div><div class="small muted">${esc(a.yahoo)}${a.sec ? ' · SEC ' + esc(a.sec) : ''}</div></div>
          <button class="icon" data-up="${i}">↑</button><button class="icon" data-ed="${esc(a.id)}">✎</button></div>`).join('')}
        <div class="btns" style="margin-top:10px"><button class="btn" id="addBtn">+ Añadir activo</button></div></div>
      <div class="card"><h2>Copia de seguridad</h2><div class="small muted">Tus cantidades solo están en este móvil. Copia este texto y guárdalo para no perderlas.</div>
        <textarea id="backup" rows="4"></textarea>
        <div class="btns"><button class="btn sec" id="expBtn">Exportar</button><button class="btn sec" id="impBtn">Importar el texto pegado</button></div></div>
      <div class="card"><h2>Datos oficiales y análisis diario</h2>
        <label>Repositorio de GitHub (usuario/nombre)</label><input id="repo" value="${esc(settings.dataRepo)}">
        <button class="btn sec" id="repoBtn">Guardar</button>
        <div class="small muted" style="margin-top:8px">De ahí se leen cada día los datos de la SEC (cuentas, directivos, fondos 13F) y el comentario diario.</div></div>
      <div class="card"><h2>Comprobación de datos</h2><div id="chkBox" class="small muted">Cargando…</div>
        <div class="btns"><button class="btn sec" id="chkBtn">Comprobar ahora</button></div></div>
      ${notifCard()}
      <div class="card"><h2>Fuentes</h2><div class="small muted">Precios: Yahoo Finance. Noticias: Google Noticias. Miedo y codicia: CNN y alternative.me. Cuentas, directivos y 13F: SEC EDGAR.</div></div>
      <div class="disclaimer">${DISCLAIMER}</div>
      <div class="btns"><button class="btn danger" id="resetBtn">Restaurar lista inicial</button></div>
      <div class="small muted" style="text-align:center;margin:14px 0">Mi Cartera · versión ${esc((() => { try { return window.NativeNotif.version(); } catch (e) { return 'web'; } })() || '–')}</div>`;
    view.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => go('editar', b.dataset.ed));
    bindNotif();
    view.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [assets[i - 1], assets[i]] = [assets[i], assets[i - 1]]; persist(); renderSettings(); } });
    $('#addBtn').onclick = () => go('editar', null);
    const showChk = r => { const el = $('#chkBox'); if (!el) return;
      if (!r) { el.textContent = 'Todavía no se ha hecho ninguna comprobación.'; return; }
      const bad = r.items.filter(x => x.issues.length);
      el.innerHTML = `Se comprueba sola cada 4 horas al abrir la app: precio, que esté al día, historial y rango de 12 meses de cada activo. Última: ${new Date(r.at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}.<br>` +
        (bad.length ? `<span class="warn">${bad.length} con problemas:</span><br>` + bad.map(x => `<b>${esc(x.name)}</b>: ${esc(x.issues.join('; '))}`).join('<br>') : `<span class="up">Los ${r.items.length} activos están bien.</span>`) +
        `<details style="margin-top:6px"><summary style="color:var(--accent)">Ver detalle</summary>${r.items.map(x => `${esc(x.name)}: ${x.price ? num(x.price) + ' ' + esc(x.ccy || '') : '–'} · desde ${x.since ? dateS(x.since) : '–'} · 12 meses ${x.range ? pctS(x.range[0]) + ' / ' + pctS(x.range[1]) : '–'}`).join('<br>')}</details>`; };
    showChk(load('dataCheck', null));
    backtestData().then(bt => { const el = $('#chkBox'); if (!bt || !bt.validation || !el) return;
      const v = bt.validation, f = k => v[k] ? pctS(v[k].edge) : '–', c = bt.summary && bt.summary.coverage || {};
      el.insertAdjacentHTML('afterend', `<div class="small muted" style="margin-top:8px"><b>Prueba histórica</b> (${esc(bt.updated)}, ${Object.keys(bt.assets).length} activos): 3 meses después de una señal favorable, el activo rindió ${f('fava')} frente a su media antes de 2022 y ${f('favb')} desde 2022; tras «Precaución», ${f('unfa')} y ${f('unfb')}. Los rangos acertaron el ${c[4] ? (c[4] * 100).toFixed(0) : '–'}% a 1 mes, ${c[13] ? (c[13] * 100).toFixed(0) : '–'}% a 3 meses y ${c[52] ? (c[52] * 100).toFixed(0) : '–'}% a 12 meses (objetivo 80%). La ventaja es pequeña: sirve más para evitar caídas que para acertar subidas.</div>`); });
    $('#chkBtn').onclick = async () => { $('#chkBox').textContent = 'Comprobando los ' + assets.length + ' activos…'; showChk(await dataCheck(true).catch(() => null)); };
    $('#expBtn').onclick = () => { $('#backup').value = JSON.stringify({ assets, settings }); $('#backup').select(); };
    $('#impBtn').onclick = () => { try { const j = JSON.parse($('#backup').value);
      if (j.pos && !j.assets) { // posiciones exactas del bróker: {"pos":{"id":[acciones, precio medio en €]}}
        let n = 0;
        Object.entries(j.pos).forEach(([id, [q, avg]]) => { const a = assets.find(x => x.id === id); if (a) { a.qty = q; a.avgEur = avg; a.costEur = q * avg; a.cost = 0; a.ops = []; delete a.seed; a.seeded = j.date ? 'exacta ' + j.date : 'exacta'; n++; } });
        persist(); clearCache(); toast(`Cargadas ${n} posiciones`); stack.length = 0; current = { name: 'cartera' }; render(); return;
      }
      if (j.seed && !j.assets) { // formato corto: {"seed":{"id":[valor €, % desde la compra]}, "date": "..."}
        let n = 0;
        Object.entries(j.seed).forEach(([id, [v, pc]]) => { const a = assets.find(x => x.id === id); if (a) { a.seed = { valueEur: v, pct: pc / 100, date: j.date }; a.qty = 0; a.ops = []; n++; } });
        persist(); clearCache(); toast(`Cargadas ${n} posiciones`); stack.length = 0; current = { name: 'cartera' }; render(); return;
      }
      if (!Array.isArray(j.assets)) throw 0; assets = j.assets; settings = Object.assign(settings, j.settings || {}); persist(); save('settings', settings); toast('Importado'); renderSettings(); } catch (e) { toast('El texto no es una copia válida'); } };
    $('#repoBtn').onclick = () => { settings.dataRepo = $('#repo').value.trim(); save('settings', settings); clearCache(); toast('Guardado'); };
    $('#resetBtn').onclick = () => { if (!$('#resetBtn').dataset.sure) { $('#resetBtn').dataset.sure = 1; $('#resetBtn').textContent = 'Toca otra vez para confirmar (se borran tus cantidades)'; return; } assets = window.DEFAULT_ASSETS.map(a => Object.assign({ qty: 0, cost: 0 }, a)); persist(); renderSettings(); };
  }

  function renderEdit(id) {
    const isNew = !id;
    const a = isNew ? { id: 'a' + Date.now(), name: '', yahoo: '', type: 'Acción', sec: '', news: '', themes: [], qty: 0, cost: 0 } : assets.find(x => x.id === id);
    $('#title').textContent = isNew ? 'Añadir activo' : 'Editar ' + a.name;
    view.innerHTML = `<div class="card">
      ${isNew ? `<label>Buscar por nombre o ticker</label><input id="q" placeholder="ej. Microsoft, VWCE, BTC"><div id="results"></div>` : ''}
      <label>Nombre</label><input id="eName" value="${esc(a.name)}">
      <label>Símbolo en Yahoo Finance</label><input id="eYahoo" value="${esc(a.yahoo)}" autocapitalize="characters">
      <label>Tipo</label><select id="eType">${['Acción', 'ETF', 'Cripto', 'Materia prima', 'Fondo cotizado'].map(t => `<option ${t === a.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label>Ticker en la SEC (solo si presenta cuentas en EE. UU.)</label><input id="eSec" value="${esc(a.sec || '')}" autocapitalize="characters">
      <label>Texto para buscar noticias</label><input id="eNews" value="${esc(a.news)}">
      <label>Temas geopolíticos que le afectan</label>
      <div class="pills" style="flex-wrap:wrap">${Object.entries(window.THEMES).map(([k, t]) => `<button class="pill ${(a.themes || []).includes(k) ? 'on' : ''}" data-th="${k}">${esc(t.label)}</button>`).join('')}</div>
      <div class="btns" style="margin-top:8px"><button class="btn" id="eSave">Guardar</button>${isNew ? '' : '<button class="btn danger" id="eDel">Quitar de la cartera</button>'}</div></div>`;
    const themes = new Set(a.themes || []);
    view.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { const k = b.dataset.th; themes.has(k) ? themes.delete(k) : themes.add(k); b.classList.toggle('on'); });
    if (isNew) {
      let timer;
      $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
        const q = $('#q').value.trim(); if (q.length < 2) return;
        const r = await http(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
        let quotes = []; try { quotes = JSON.parse(r.text).quotes || []; } catch (e) { /* nada */ }
        $('#results').innerHTML = quotes.map((x, i) => `<div class="asset" data-i="${i}"><div class="grow"><div class="name">${esc(x.shortname || x.longname || x.symbol)}</div><div class="small muted">${esc(x.symbol)} · ${esc(x.exchDisp || '')} · ${esc(x.typeDisp || '')}</div></div></div>`).join('') || '<div class="small muted">Sin resultados</div>';
        $('#results').querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
          const x = quotes[+el.dataset.i];
          $('#eName').value = x.shortname || x.longname || x.symbol; $('#eYahoo').value = x.symbol; $('#eNews').value = x.shortname || x.symbol;
          const type = { EQUITY: 'Acción', ETF: 'ETF', CRYPTOCURRENCY: 'Cripto', FUTURE: 'Materia prima', MUTUALFUND: 'Fondo cotizado' }[x.quoteType] || 'Acción';
          $('#eType').value = type;
          if (type === 'Acción' && /^[A-Z.]{1,6}$/.test(x.symbol) && !x.symbol.includes('.')) $('#eSec').value = x.symbol;
          $('#results').innerHTML = '';
        });
      }, 400); };
    }
    $('#eSave').onclick = () => {
      Object.assign(a, { name: $('#eName').value.trim(), yahoo: $('#eYahoo').value.trim(), type: $('#eType').value, sec: $('#eSec').value.trim().toUpperCase(), news: $('#eNews').value.trim() || $('#eName').value.trim(), themes: [...themes] });
      if (!a.name || !a.yahoo) return toast('Faltan el nombre o el símbolo');
      delete a.note; delete a.resolveIsin;
      if (isNew) assets.push(a);
      persist(); toast('Guardado'); window.appBack();
    };
    if (!isNew) $('#eDel').onclick = () => { const b = $('#eDel'); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Toca otra vez para confirmar'; return; } assets = assets.filter(x => x.id !== a.id); persist(); stack.length = 0; current = { name: 'ajustes' }; render(); };
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:#1b2740;border:1px solid #26344f;padding:10px 16px;border-radius:10px;z-index:20';
    document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
  }

  // ---------- Notificaciones en el móvil (las envía Android aunque la app esté cerrada) ----------
  const NOTIF_DEF = { on: true, move: true, moveTh: 0.08, levels: true, signal: true, fg: true, ins: true, max: 3, quiet: true };
  const notifCfg = () => Object.assign({}, NOTIF_DEF, settings.notif || {});
  function syncNotif() {
    if (!window.NativeNotif) return;
    try {
      const n = notifCfg(), P = window.Portfolio;
      const held = assets.filter(a => { try { return P.position(a).qty > 0; } catch (e) { return a.qty > 0; } });
      const list = (held.length ? held : assets).map(a => ({ id: a.id, name: a.name, sym: a.yahoo, crypto: isCrypto(a),
        buy: (a.rules || {}).buyBelow || 0, sell: (a.rules || {}).sellAbove || 0, stop: (a.rules || {}).stopBelow || 0 }));
      window.NativeNotif.setConfig(JSON.stringify(Object.assign({}, n, { repo: settings.dataRepo, branch: settings.branch, assets: list })));
    } catch (e) {}
  }
  function notifStatus() { try { return JSON.parse(window.NativeNotif.status()); } catch (e) { return {}; } }
  function notifCard() {
    if (!window.NativeNotif) return '<div class="card"><h2>Notificaciones</h2><div class="small muted">Solo funcionan en la app instalada en el móvil.</div></div>';
    const n = notifCfg(), ck = (k, t, sub) => `<label class="row" style="gap:10px;align-items:flex-start;margin:8px 0"><input type="checkbox" data-nk="${k}" ${n[k] ? 'checked' : ''} style="width:auto;margin-top:3px"><span class="grow">${t}${sub ? `<div class="small muted">${sub}</div>` : ''}</span></label>`;
    return `<div class="card" id="notifCard"><h2>Notificaciones</h2>
      ${ck('on', '<b>Recibir avisos en el móvil</b>', 'La app revisa tu cartera cada 2 horas más o menos, aunque esté cerrada.')}
      <div id="notifOpts" style="${n.on ? '' : 'opacity:.45;pointer-events:none'}">
      ${ck('levels', 'Tus precios de aviso', 'Los que pones en cada activo, en «Mi posición»: comprar más, vender y precio de salida.')}
      ${ck('move', 'Movimientos fuertes del día', `Si un activo tuyo sube o baja más de <select id="nTh" style="width:auto;display:inline-block;padding:2px 6px;margin:0">${[0.05, 0.08, 0.1, 0.15].map(v => `<option value="${v}" ${v === n.moveTh ? 'selected' : ''}>${v * 100}%</option>`).join('')}</select> en un día (en criptos, 1,5 veces eso).`)}
      ${ck('signal', 'Cambios importantes de la señal', 'Cuando un activo pasa a «Comprar», «Reducir» o «Precaución», o sale de ahí. Una vez al día.')}
      ${ck('ins', 'Compras de directivos', 'Cuando un directivo compra acciones de su empresa con su dinero.')}
      ${ck('fg', 'Miedo o codicia extremos', 'Cuando el mercado entra en miedo extremo (15 o menos) o codicia extrema (85 o más).')}
      <label>Máximo de avisos al día</label><select id="nMax">${[1, 3, 5, 10].map(v => `<option ${v === n.max ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${ck('quiet', 'No avisar de noche', 'Entre las 22:00 y las 8:00 no llega nada.')}
      <div class="small muted">Si hay más avisos de los que caben, se juntan en una sola notificación.</div>
      </div>
      <div class="btns"><button class="btn sec" id="nTest">Probar</button><button class="btn sec" id="nNow">Comprobar ahora</button></div>
      <div class="small muted" id="nStat"></div></div>`;
  }
  function bindNotif() {
    if (!$('#notifCard')) return;
    const upd = () => { settings.notif = Object.assign(notifCfg(), { moveTh: +$('#nTh').value, max: +$('#nMax').value });
      $('#notifCard').querySelectorAll('[data-nk]').forEach(c => settings.notif[c.dataset.nk] = c.checked);
      save('settings', settings); syncNotif(); $('#notifOpts').style.cssText = settings.notif.on ? '' : 'opacity:.45;pointer-events:none';
      if (settings.notif.on) window.NativeNotif.askPermission(); showStat(); };
    $('#notifCard').querySelectorAll('[data-nk]').forEach(c => c.onchange = upd);
    $('#nTh').onchange = upd; $('#nMax').onchange = upd;
    $('#nTest').onclick = () => { window.NativeNotif.askPermission(); window.NativeNotif.test(); setTimeout(showStat, 800); };
    $('#nNow').onclick = () => { window.NativeNotif.askPermission(); window.NativeNotif.runNow(); toast('Comprobando… te llegará una notificación'); setTimeout(showStat, 15000); };
    const showStat = () => { const st = notifStatus(); if (!$('#nStat')) return;
      $('#nStat').innerHTML = (st.perm === false ? '<div class="warn">El móvil no deja a la app enviar notificaciones. Toca «Probar» para dar permiso, o actívalo en los ajustes de Android.</div>' : '') +
        (st.last ? `Última revisión: ${new Date(st.last).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${st.lastPrices} precios). Avisos hoy: ${st.today}.` : 'Aún no ha hecho ninguna revisión.') +
        '<div style="margin-top:4px">Si no te llegan, en Android pon la batería de Mi Cartera en «Sin restricciones».</div>'; };
    showStat();
  }
  window.openAsset = id => { if (assets.some(a => a.id === id)) { stack.length = 0; current = { name: 'cartera' }; go('detalle', id); } };
  try { syncNotif(); if (window.NativeNotif && notifCfg().on && !settings.notifAsked) { settings.notifAsked = 1; save('settings', settings); window.NativeNotif.askPermission(); } } catch (e) {}

  render();
})();
