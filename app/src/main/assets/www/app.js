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
        const r = await http(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`);
        last = r;
        if (r.status !== 200) continue;
        const j = JSON.parse(r.text);
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res) continue;
        const q = res.indicators.quote[0] || {};
        const t = [], c = [];
        (res.timestamp || []).forEach((ts, i) => { const v = q.close && q.close[i]; if (v != null && isFinite(v)) { t.push(ts); c.push(v); } });
        const meta = res.meta || {};
        return { t, c, meta: { price: meta.regularMarketPrice, prev: meta.chartPreviousClose ?? meta.previousClose, currency: meta.currency, name: meta.longName || meta.shortName, exchange: meta.fullExchangeName } };
      }
      throw new Error('Yahoo no responde (' + (last ? last.status : '?') + ')');
    });
  }
  async function daily(a) { return yahoo(a.yahoo, '2y', '1d'); }

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
  const isCrypto = a => a.type === 'Cripto';

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
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === (['detalle', 'editar'].includes(current.name) ? 'x' : current.name)));
    window.scrollTo(0, 0);
    ({ cartera: renderPortfolio, detalle: renderDetail, mercado: renderMarket, ajustes: renderSettings, editar: renderEdit })[current.name](current.arg);
  }

  // ---------- Vista: Cartera ----------
  async function renderPortfolio() {
    $('#title').textContent = 'Mi Cartera';
    view.innerHTML = `
      <div class="card"><div class="muted small">Valor de la cartera</div>
        <div class="big" id="total">…</div><div id="totalPl" class="small"></div></div>
      <div class="card" id="alertsCard"><h2>Avisos</h2><div id="alerts" class="muted small">Analizando tus activos…</div></div>
      <div class="card"><h2>Tus activos</h2><div id="list"></div></div>
      <div class="disclaimer">${DISCLAIMER}</div>`;
    const list = $('#list');
    list.innerHTML = assets.map(a => `
      <div class="asset" data-id="${esc(a.id)}">
        <span class="dot" id="dot-${esc(a.id)}"></span>
        <div class="grow"><div class="name">${esc(a.name)}</div><div class="small muted" id="sub-${esc(a.id)}">${esc(a.type)} · ${esc(a.yahoo)}</div></div>
        <div class="right"><div id="px-${esc(a.id)}">…</div><div class="small" id="ch-${esc(a.id)}"></div></div>
      </div>`).join('');
    list.querySelectorAll('.asset').forEach(el => el.onclick = () => go('detalle', el.dataset.id));

    let total = 0, invested = 0, missing = 0;
    const alerts = [];
    const fg = { stocks: await fearGreedStocks().catch(() => null), crypto: await fearGreedCrypto().catch(() => null) };
    await Promise.all(assets.map(async a => {
      try {
        const d = await daily(a);
        const price = d.meta.price || d.c[d.c.length - 1];
        const ch = d.meta.prev ? price / d.meta.prev - 1 : null;
        const ev = A.evaluate(d, { fearGreed: isCrypto(a) ? fg.crypto : fg.stocks });
        const dot = $('#dot-' + a.id); if (dot) dot.className = 'dot ' + ev.kind;
        $('#px-' + a.id).textContent = num(price) + ' ' + (d.meta.currency || '');
        const chEl = $('#ch-' + a.id); chEl.textContent = pctS(ch) + ' hoy'; chEl.className = 'small ' + cls(ch);
        if (a.qty > 0) {
          const fx = await fxToEur(d.meta.currency);
          const val = a.qty * price * fx; total += val;
          if (a.cost > 0) invested += a.qty * a.cost * fx;
          const pl = a.cost > 0 ? price / a.cost - 1 : null;
          $('#sub-' + a.id).innerHTML = `${eur(val)} · <span class="${cls(pl)}">${pl == null ? '' : pctS(pl)}</span>`;
        }
        ev.alerts.forEach(x => alerts.push({ a, ...x }));
      } catch (e) {
        missing++;
        $('#px-' + a.id).innerHTML = '<span class="warn small">sin datos</span>';
      }
    }));
    if (current.name !== 'cartera') return;
    $('#total').textContent = total > 0 ? eur(total) : 'Añade tus cantidades';
    if (invested > 0) { const pl = total - invested; $('#totalPl').innerHTML = `<span class="${cls(pl)}">${pl >= 0 ? '+' : ''}${eur(pl)} (${pctS(pl / invested)})</span> <span class="muted">sobre lo invertido</span>`; }
    else $('#totalPl').innerHTML = '<span class="muted">Toca un activo y pon cuánto tienes y a qué precio compraste.</span>';
    if (missing) $('#totalPl').innerHTML += `<div class="warn">${missing} activo(s) sin datos. Revisa su símbolo en Ajustes.</div>`;
    $('#alerts').innerHTML = alerts.length
      ? alerts.map(x => `<div class="reason"><span class="dot ${x.kind}" style="display:inline-block"></span> <b>${esc(x.a.name)}</b>: ${esc(x.text)}</div>`).join('')
      : 'Sin cambios destacados en precios ni tendencias.';
  }

  // ---------- Vista: Detalle ----------
  const DETAIL_TABS = [['analisis', 'Análisis'], ['grafica', 'Gráfica'], ['noticias', 'Noticias'], ['geo', 'Geopolítica'], ['oficial', 'Oficial'], ['fondos', 'Grandes fondos'], ['posicion', 'Mi posición']];
  async function renderDetail(id) {
    const a = assets.find(x => x.id === id); if (!a) return go('cartera', null, false);
    const tab = current.tab || 'analisis';
    $('#title').textContent = a.name;
    view.innerHTML = `
      <div class="card"><div class="row"><div class="grow"><div class="muted small">${esc(a.type)} · ${esc(a.yahoo)}${a.sec ? ' · SEC ' + esc(a.sec) : ''}</div>
        <div class="big" id="dPx">…</div><div id="dCh" class="small"></div></div></div>
        ${a.note ? `<div class="small warn" style="margin-top:6px">${esc(a.note)}</div>` : ''}</div>
      <div class="pills">${DETAIL_TABS.map(([k, l]) => `<button class="pill ${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
      <div id="tabBody"><div class="loading">Cargando…</div></div>`;
    view.querySelectorAll('.pill[data-t]').forEach(b => b.onclick = () => { current.tab = b.dataset.t; renderDetail(id); });
    let d;
    try { d = await daily(a); } catch (e) { $('#tabBody').innerHTML = `<div class="card warn">No hay datos de precio para «${esc(a.yahoo)}». Cambia el símbolo en Mi posición.</div>`; if (tab === 'posicion') renderPosition(a, null); return; }
    const price = d.meta.price || d.c[d.c.length - 1];
    $('#dPx').textContent = num(price) + ' ' + (d.meta.currency || '');
    const ch = d.meta.prev ? price / d.meta.prev - 1 : null;
    $('#dCh').innerHTML = `<span class="${cls(ch)}">${pctS(ch)} hoy</span> <span class="muted">· ${esc(d.meta.exchange || '')}</span>`;
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

  async function gatherExtra(a) {
    const [nw, fg, sec, geo] = await Promise.all([
      news(a.news).catch(() => null),
      (isCrypto(a) ? fearGreedCrypto() : fearGreedStocks()).catch(() => null),
      a.sec ? secData().catch(() => null) : null,
      geoNews(a).catch(() => null)
    ]);
    const s = sec && sec.assets && sec.assets[a.sec];
    const funds = sec && sec.funds && sec.funds.positions && sec.funds.positions[a.sec];
    return { news: nw, fearGreed: fg, insiders: s && s.insiders, filings: s && s.filings, funds, geoNews: geo, sec };
  }

  async function tabAnalysis(a, d, body) {
    const extra = await gatherExtra(a);
    const ev = A.evaluate(d, extra);
    const m = ev.metrics;
    const notes = await analysisNotes();
    const note = notes && notes.assets && notes.assets[a.id];
    body.innerHTML = `
      <div class="signal ${ev.kind}"><div class="small muted">Orientación actual</div><div style="font-size:17px;font-weight:700">${esc(ev.label)}</div>
        <div class="small muted">Puntuación ${ev.score >= 0 ? '+' : ''}${ev.score.toFixed(1)} (de -6 a +6)</div></div>
      ${ev.alerts.length ? `<div class="card"><h2>Qué ha cambiado</h2>${ev.alerts.map(x => `<div class="reason ${x.kind === 'g' ? 'up' : x.kind === 'r' ? 'down' : 'warn'}">${esc(x.text)}</div>`).join('')}</div>` : ''}
      ${note ? `<div class="card"><h2>Comentario del día <span class="badge">${esc(notes.date || '')}</span></h2><div style="white-space:pre-wrap">${esc(note)}</div></div>` : ''}
      <div class="card"><h2>Por qué</h2>${ev.reasons.map(r => `<div class="reason"><span class="${r.kind === 'g' ? 'up' : r.kind === 'r' ? 'down' : 'warn'}">${r.pts > 0 ? '▲' : r.pts < 0 ? '▼' : '●'}</span> ${esc(r.text)}</div>`).join('')}</div>
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
      <div class="disclaimer">${DISCLAIMER} La puntuación suma tendencia, RSI, distancia a las medias, tono de las noticias, miedo y codicia, compras de directivos y grandes fondos.</div>`;
  }

  async function tabChart(a, d, body) {
    const ranges = [['1M', 30], ['3M', 91], ['6M', 182], ['1A', 365], ['2A', 730], ['MAX', 0]];
    const r = current.range || '1A';
    body.innerHTML = `<div class="card"><div class="pills">${ranges.map(([k]) => `<button class="pill ${k === r ? 'on' : ''}" data-r="${k}">${k}</button>`).join('')}</div>
      <div id="chartInfo" class="small muted">&nbsp;</div><canvas id="cv"></canvas>
      <div class="small muted" style="margin-top:6px"><span style="color:#38bdf8">━</span> precio ${r !== 'MAX' ? '· <span style="color:#f59e0b">━</span> media 50 · <span style="color:#a78bfa">━</span> media 200' : ''}${a.cost > 0 ? ' · <span style="color:#22c55e">┅</span> tu precio de compra' : ''}</div></div>
      <div class="card" id="histCard"></div>`;
    body.querySelectorAll('.pill[data-r]').forEach(b => b.onclick = () => { current.range = b.dataset.r; tabChart(a, d, body); });
    let t, c, overlays = [];
    if (r === 'MAX') {
      const w = await yahoo(a.yahoo, 'max', '1wk');
      t = w.t; c = w.c;
    } else {
      const days = ranges.find(x => x[0] === r)[1];
      const s50 = A.sma(d.c, 50), s200 = A.sma(d.c, 200);
      const from = d.t[d.t.length - 1] - days * 86400;
      const i0 = Math.max(0, d.t.findIndex(x => x >= from));
      t = d.t.slice(i0); c = d.c.slice(i0);
      overlays = [{ v: s50.slice(i0), color: '#f59e0b' }, { v: s200.slice(i0), color: '#a78bfa' }];
    }
    drawChart($('#cv'), t, c, overlays, a.cost > 0 ? a.cost : null);
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
    body.innerHTML = `<div class="card"><h2>Noticias de las últimas 2 semanas</h2>
      ${s ? `<div class="small muted" style="margin-bottom:6px">Tono: ${s.pos} positivas, ${s.neg} negativas, ${s.n - s.pos - s.neg} neutras (lectura automática de titulares).</div>` : ''}
      ${newsList(items)}</div>`;
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
      <div class="small muted" style="margin-top:8px">Informes 13F del trimestre ${esc((sec.funds && sec.funds.period) || '')}. Se publican hasta 45 días después del cierre del trimestre, así que reflejan el pasado. Fondos seguidos: ${esc(((sec.funds && sec.funds.tracked) || []).join(', '))}.</div></div>`;
  }

  function renderPosition(a, d) {
    const body = $('#tabBody');
    const price = d ? (d.meta.price || d.c[d.c.length - 1]) : null;
    const pl = price && a.cost > 0 ? price / a.cost - 1 : null;
    body.innerHTML = `<div class="card"><h2>Mi posición</h2>
      <label>Cantidad que tengo (participaciones, acciones o monedas)</label><input id="pQty" type="number" inputmode="decimal" step="any" value="${a.qty || ''}">
      <label>Precio medio de compra (en ${esc(d ? d.meta.currency || '' : 'la moneda del activo')})</label><input id="pCost" type="number" inputmode="decimal" step="any" value="${a.cost || ''}">
      ${pl != null ? `<div style="margin-bottom:10px">Resultado: <b class="${cls(pl)}">${pctS(pl)}</b> · valor ${num(a.qty * price)} ${esc(d.meta.currency || '')}</div>` : ''}
      <label>Mis notas</label><textarea id="pNotes" rows="3">${esc(a.notes || '')}</textarea>
      <div class="btns"><button class="btn" id="pSave">Guardar</button><button class="btn sec" id="pEdit">Editar símbolo y temas</button></div></div>`;
    $('#pSave').onclick = () => { a.qty = parseFloat($('#pQty').value) || 0; a.cost = parseFloat($('#pCost').value) || 0; a.notes = $('#pNotes').value; persist(); renderPosition(a, d); toast('Guardado'); };
    $('#pEdit').onclick = () => go('editar', a.id);
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
    $('#impBtn').onclick = () => { try { const j = JSON.parse($('#backup').value); if (!Array.isArray(j.assets)) throw 0; assets = j.assets; settings = Object.assign(settings, j.settings || {}); persist(); save('settings', settings); toast('Importado'); renderSettings(); } catch (e) { toast('El texto no es una copia válida'); } };
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
      delete a.note;
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
