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
  const DEFAULTS_VERSION = 4;
  if (load('defaultsVersion', 1) < DEFAULTS_VERSION) {
    assets.forEach(a => {
      const def = window.DEFAULT_ASSETS.find(d => d.id === a.id);
      if (def) ['yahoo', 'note', 'isin', 'name', 'resolveIsin'].forEach(k => { if (def[k] !== undefined) a[k] = def[k]; else if (k !== 'name') delete a[k]; });
    });
    // Activos nuevos de la lista inicial que aún no estén en el móvil.
    window.DEFAULT_ASSETS.forEach((d, i) => { if (!assets.some(a => a.id === d.id)) assets.splice(Math.min(i, assets.length), 0, Object.assign({ qty: 0, cost: 0 }, d)); });
    save('defaultsVersion', DEFAULTS_VERSION);
    save('assets', assets);
  }
  let settings = Object.assign({ dataRepo: 'gloriaruano5/broker-app', branch: 'main' }, load('settings', {}));
  const persist = () => save('assets', assets);

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
    return cached(`y:${sym}:${range}:${interval}`, range === 'max' ? 720 : 20, async () => {
      let last;
      for (const host of ['query1', 'query2']) {
        const r = await http(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false&events=div`);
        last = r;
        if (r.status !== 200) continue;
        const j = JSON.parse(r.text);
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res) continue;
        const q = res.indicators.quote[0] || {};
        const t = [], c = [];
        (res.timestamp || []).forEach((ts, i) => { const v = q.close && q.close[i]; if (v != null && isFinite(v)) { t.push(ts); c.push(v); } });
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
        return { t, c, div, meta: { price: meta.regularMarketPrice, prev: prev, currency: meta.currency, name: meta.longName || meta.shortName, exchange: meta.fullExchangeName } };
      }
      throw new Error('Yahoo no responde (' + (last ? last.status : '?') + ')');
    });
  }
  async function daily(a) {
    if (a.resolveIsin && a.isin && !a.resolved) await resolveListing(a).catch(() => {});
    return yahoo(a.yahoo, '2y', '1d');
  }
  /** Busca por ISIN la cotización en euros (Xetra, luego otras bolsas alemanas) y la guarda. */
  async function resolveListing(a) {
    const r = await http(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(a.isin)}&quotesCount=15&newsCount=0`);
    const quotes = (JSON.parse(r.text).quotes || []).map(q => q.symbol).filter(Boolean);
    const pick = quotes.find(s => s.endsWith('.DE')) || quotes.find(s => /\.(F|MU|SG|DU|BE|HM)$/.test(s)) || quotes.find(s => /\.(MI|AS|PA)$/.test(s)) || quotes[0];
    if (pick) { a.yahoo = pick; a.resolved = true; persist(); }
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
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === (['detalle', 'editar', 'renta'].includes(current.name) ? 'x' : current.name)));
    window.scrollTo(0, 0);
    ({ cartera: renderPortfolio, detalle: renderDetail, mercado: renderMarket, ajustes: renderSettings, editar: renderEdit, riesgo: renderRisk, agenda: renderAgenda, renta: renderTax })[current.name](current.arg);
  }

  // ---------- Vista: Cartera ----------
  async function renderPortfolio() {
    $('#title').textContent = 'Mi Cartera';
    view.innerHTML = `
      <div class="card"><div class="muted small">Valor de la cartera</div>
        <div class="big" id="total">…</div><div id="totalPl" class="small"></div>
        <div class="btns" style="margin-top:10px"><button class="btn sec" id="taxBtn">Renta y plusvalías</button></div></div>
      <div class="card" id="alertsCard"><h2>Avisos</h2><div id="alerts" class="muted small">Analizando tus activos…</div></div>
      <div class="card"><h2>Tus activos</h2><div id="list"></div></div>
      <div class="disclaimer">${DISCLAIMER}</div>`;
    $('#taxBtn').onclick = () => go('renta');
    const list = $('#list');
    list.innerHTML = assets.map(a => `
      <div class="asset" data-id="${esc(a.id)}">
        <span class="dot" id="dot-${esc(a.id)}"></span>
        <div class="grow"><div class="name">${esc(a.name)}</div><div class="small muted" id="sub-${esc(a.id)}">${esc(a.type)} · ${esc(a.yahoo)}</div></div>
        <div class="right"><div id="px-${esc(a.id)}">…</div><div class="small" id="ch-${esc(a.id)}"></div></div>
      </div>`).join('');
    list.querySelectorAll('.asset').forEach(el => el.onclick = () => go('detalle', el.dataset.id));

    let total = 0, invested = 0, plSum = 0, fxSum = 0, missing = 0;
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
        $('#sub-' + a.id).textContent = `${a.type} · ${num(sn.price * sn.fx, 2)} €${sn.ccy && sn.ccy !== 'EUR' ? ' (' + num(sn.price) + ' ' + sn.ccy + ')' : ''}`;
        if (sn.pos.qty > 0) {
          $('#px-' + a.id).textContent = eur(sn.value);
          chEl.textContent = sn.eurRet != null ? pctS(sn.eurRet) + ' desde la compra' : '';
          chEl.className = 'small ' + cls(sn.eurRet);
        } else {
          $('#px-' + a.id).textContent = num(sn.price * sn.fx, 2) + ' €';
          chEl.textContent = pctS(ch) + ' hoy'; chEl.className = 'small ' + cls(ch);
        }
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

  async function gatherExtra(a, d) {
    const [nw, fg, sec, geo] = await Promise.all([
      news(a.news).catch(() => null),
      (isCrypto(a) ? fearGreedCrypto() : fearGreedStocks()).catch(() => null),
      a.sec ? secData().catch(() => null) : null,
      geoNews(a).catch(() => null)
    ]);
    const s = sec && sec.assets && sec.assets[a.sec];
    const funds = sec && sec.funds && sec.funds.positions && sec.funds.positions[a.sec];
    const extra = { news: nw, fearGreed: fg, insiders: s && s.insiders, filings: s && s.filings, funds, geoNews: geo, sec, rules: a.rules };
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

  async function tabChart(a, d, body) {
    const ranges = [['1S', 7], ['1M', 30], ['3M', 91], ['6M', 182], ['1A', 365], ['2A', 730], ['5A', 1826], ['MAX', 0]];
    const r = current.range || 'MAX';
    body.innerHTML = `<div class="card"><div class="pills">${ranges.map(([k]) => `<button class="pill ${k === r ? 'on' : ''}" data-r="${k}">${k}</button>`).join('')}</div>
      <div id="chartInfo" class="small muted">&nbsp;</div><canvas id="cv"></canvas>
      <div class="small muted" style="margin-top:6px"><span style="color:#38bdf8">━</span> precio ${r !== 'MAX' && r !== '5A' ? '· <span style="color:#f59e0b">━</span> media 50 · <span style="color:#a78bfa">━</span> media 200' : ''}${window.Portfolio.position(a).avg > 0 ? ' · <span style="color:#22c55e">┅</span> tu precio medio de compra' : ''}</div></div>
      <div class="card" id="histCard"></div>`;
    body.querySelectorAll('.pill[data-r]').forEach(b => b.onclick = () => { current.range = b.dataset.r; tabChart(a, d, body); });
    let t, c, overlays = [];
    if (r === 'MAX' || r === '5A') {
      const w = await yahoo(a.yahoo, 'max', '1wk');
      t = w.t; c = w.c;
      if (r === '5A') { const from = t[t.length - 1] - 1826 * 86400; const i0 = Math.max(0, t.findIndex(x => x >= from)); t = t.slice(i0); c = c.slice(i0); }
    } else {
      const days = ranges.find(x => x[0] === r)[1];
      const s50 = A.sma(d.c, 50), s200 = A.sma(d.c, 200);
      const from = d.t[d.t.length - 1] - days * 86400;
      const i0 = Math.max(0, d.t.findIndex(x => x >= from));
      t = d.t.slice(i0); c = d.c.slice(i0);
      overlays = [{ v: s50.slice(i0), color: '#f59e0b' }, { v: s200.slice(i0), color: '#a78bfa' }];
    }
    drawChart($('#cv'), t, c, overlays, window.Portfolio.position(a).avg || null);
    if (t.length) {
      const first = c[0], last = c[c.length - 1];
      $('#histCard').innerHTML = `<h2>Historial ${r === 'MAX' ? 'completo' : r}</h2><div class="kv">
        <div><span>Desde</span><b>${dateS(t[0])}</b></div><div><span>Variación</span><b class="${cls(last / first - 1)}">${pctS(last / first - 1)}</b></div>
        <div><span>Máximo</span><b>${num(Math.max(...c))}</b></div><div><span>Mínimo</span><b>${num(Math.min(...c))}</b></div></div>
        ${r === 'MAX' ? '<div class="small muted" style="margin-top:6px">Datos semanales desde que hay registros en Yahoo Finance.</div>' : ''}`;
    }
  }

  function drawChart(cv, t, c, overlays, costLine) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    if (c.length < 2) { g.fillStyle = '#8b9ab3'; g.fillText('Sin datos suficientes', 10, 20); return; }
    let lo = Math.min(...c), hi = Math.max(...c);
    overlays.forEach(o => o.v.forEach(x => { if (x != null) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }));
    if (costLine) { lo = Math.min(lo, costLine); hi = Math.max(hi, costLine); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const L = 4, R = 52, T = 6, B = 18;
    const X = i => L + (i / (c.length - 1)) * (W - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const paint = (cross) => {
      g.clearRect(0, 0, W, H);
      g.font = '11px system-ui'; g.fillStyle = '#8b9ab3'; g.strokeStyle = '#26344f'; g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const v = lo + (hi - lo) * k / 4, y = Y(v);
        g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
        g.fillText(num(v), W - R + 4, y + 4);
      }
      [0, Math.floor(c.length / 2), c.length - 1].forEach((i, k) => {
        const s = new Date(t[i] * 1000).toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
        g.fillText(s, Math.min(Math.max(X(i) - (k === 2 ? 40 : k === 1 ? 18 : 0), 0), W - R - 40), H - 4);
      });
      if (costLine) { g.setLineDash([5, 4]); g.strokeStyle = '#22c55e'; g.beginPath(); g.moveTo(L, Y(costLine)); g.lineTo(W - R, Y(costLine)); g.stroke(); g.setLineDash([]); }
      overlays.forEach(o => {
        g.strokeStyle = o.color; g.lineWidth = 1.2; g.beginPath(); let started = false;
        o.v.forEach((v, i) => { if (v == null) return; if (!started) { g.moveTo(X(i), Y(v)); started = true; } else g.lineTo(X(i), Y(v)); });
        g.stroke();
      });
      const grad = g.createLinearGradient(0, T, 0, H - B);
      grad.addColorStop(0, 'rgba(56,189,248,0.25)'); grad.addColorStop(1, 'rgba(56,189,248,0)');
      g.beginPath(); c.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
      g.strokeStyle = '#38bdf8'; g.lineWidth = 2; g.stroke();
      g.lineTo(X(c.length - 1), H - B); g.lineTo(X(0), H - B); g.closePath(); g.fillStyle = grad; g.fill();
      if (cross != null) {
        g.strokeStyle = '#e5ebf5'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(cross), T); g.lineTo(X(cross), H - B); g.stroke();
        g.fillStyle = '#e5ebf5'; g.beginPath(); g.arc(X(cross), Y(c[cross]), 4, 0, 7); g.fill();
      }
    };
    paint(null);
    const info = $('#chartInfo');
    const pick = ev => {
      const rect = cv.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const i = Math.round(Math.min(Math.max((x - L) / (W - L - R), 0), 1) * (c.length - 1));
      paint(i);
      info.innerHTML = `${dateS(t[i])}: <b>${num(c[i])}</b> <span class="${cls(c[c.length - 1] / c[i] - 1)}">(${pctS(c[c.length - 1] / c[i] - 1)} hasta hoy)</span>`;
    };
    cv.ontouchstart = cv.ontouchmove = pick; cv.onmousemove = pick;
    cv.onmouseleave = () => { paint(null); info.innerHTML = '&nbsp;'; };
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
        ${a.seeded && !ops.length ? `<div class="small warn" style="margin-top:6px">Posición estimada a partir de tu captura de Trade Republic (${esc(typeof a.seeded === 'string' ? a.seeded : '')}). La cantidad y el precio medio son aproximados; apunta tus operaciones para tener la cifra exacta.</div>` : ''}</div>
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
      <div class="card"><h2>Mis reglas</h2><div class="small muted">Te aviso en la pantalla de Cartera cuando el precio cruce estos niveles (en ${esc(ccy)}).</div>
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
    view.innerHTML = `
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
      <div class="card"><h2>Fuentes</h2><div class="small muted">Precios: Yahoo Finance. Noticias: Google Noticias. Miedo y codicia: CNN y alternative.me. Cuentas, directivos y 13F: SEC EDGAR.</div></div>
      <div class="disclaimer">${DISCLAIMER}</div>
      <div class="btns"><button class="btn danger" id="resetBtn">Restaurar lista inicial</button></div>`;
    view.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => go('editar', b.dataset.ed));
    view.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [assets[i - 1], assets[i]] = [assets[i], assets[i - 1]]; persist(); renderSettings(); } });
    $('#addBtn').onclick = () => go('editar', null);
    $('#expBtn').onclick = () => { $('#backup').value = JSON.stringify({ assets, settings }); $('#backup').select(); };
    $('#impBtn').onclick = () => { try { const j = JSON.parse($('#backup').value);
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

  render();
})();
