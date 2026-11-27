// Gráfica interactiva: velas, volumen, indicadores (MA, EMA, BOLL, SAR, tendencia, KDJ, RSI, MACD).
// Usa TradingView Lightweight Charts (licencia Apache-2.0, incluida en lightweight-charts.LICENSE.txt).
(function () {
  const LWC = window.LightweightCharts;
  const COL = { up: '#22c55e', down: '#ef4444', grid: '#1c2740', text: '#8b9ab3', bg: '#121a2b', ma1: '#f5c542', ma2: '#e879f9', ma3: '#a78bfa', ema1: '#38bdf8', ema2: '#fb923c', boll: '#94a3b8', sar: '#f472b6', trend: '#e5ebf5', cost: '#22c55e' };

  // ---------- Indicadores ----------
  function sma(v, n) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
  function ema(v, n) { const o = new Array(v.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < v.length; i++) { if (i === n - 1) { let s = 0; for (let j = 0; j < n; j++) s += v[j]; e = s / n; } else if (i >= n) e = v[i] * k + e * (1 - k); o[i] = i >= n - 1 ? e : null; } return o; }
  function boll(v, n = 20, m = 2) {
    const mid = sma(v, n), up = [], lo = [];
    for (let i = 0; i < v.length; i++) {
      if (mid[i] == null) { up.push(null); lo.push(null); continue; }
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n); up.push(mid[i] + m * sd); lo.push(mid[i] - m * sd);
    }
    return { mid, up, lo };
  }
  function sar(h, l, step = 0.02, max = 0.2) {
    const n = h.length, o = new Array(n).fill(null); if (n < 3) return o;
    let up = h[1] >= h[0], af = step, ep = up ? h[1] : l[1], s = up ? l[0] : h[0];
    for (let i = 1; i < n; i++) {
      s = s + af * (ep - s);
      if (up) {
        s = Math.min(s, l[i - 1], i > 1 ? l[i - 2] : l[i - 1]);
        if (l[i] < s) { up = false; s = ep; ep = l[i]; af = step; }
        else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
      } else {
        s = Math.max(s, h[i - 1], i > 1 ? h[i - 2] : h[i - 1]);
        if (h[i] > s) { up = true; s = ep; ep = h[i]; af = step; }
        else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
      }
      o[i] = s;
    }
    return o;
  }
  function kdj(h, l, c, n = 9) {
    const K = [], D = [], J = []; let k = 50, d = 50;
    for (let i = 0; i < c.length; i++) {
      if (i < n - 1) { K.push(null); D.push(null); J.push(null); continue; }
      let hh = -Infinity, ll = Infinity; for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
      const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
      k = (2 * k + rsv) / 3; d = (2 * d + k) / 3;
      K.push(k); D.push(d); J.push(3 * k - 2 * d);
    }
    return { K, D, J };
  }
  function rsi(v, n = 14) {
    const o = new Array(v.length).fill(null); if (v.length <= n) return o;
    let g = 0, ls = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else ls -= d; }
    g /= n; ls /= n; o[n] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls);
    for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; ls = (ls * (n - 1) + Math.max(-d, 0)) / n; o[i] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls); }
    return o;
  }
  function macd(v) {
    const a = ema(v, 12), b = ema(v, 26), m = v.map((_, i) => a[i] != null && b[i] != null ? a[i] - b[i] : null);
    const first = m.findIndex(x => x != null); const sig = new Array(v.length).fill(null);
    if (first >= 0) { const e = ema(m.slice(first), 9); e.forEach((x, i) => sig[first + i] = x); }
    return { macd: m, signal: sig, hist: m.map((x, i) => x != null && sig[i] != null ? x - sig[i] : null) };
  }
  // Tendencia: regresión lineal sobre el logaritmo del precio en el tramo visible (crecimiento porcentual constante).
  function trend(t, c, i0, i1) {
    const n = i1 - i0 + 1; if (n < 5) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = i0; i <= i1; i++) { const x = i - i0, y = Math.log(c[i]); sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    let ss = 0; for (let i = i0; i <= i1; i++) ss += (Math.log(c[i]) - (a + b * (i - i0))) ** 2;
    const sd = Math.sqrt(ss / n);
    const pts = []; for (let i = i0; i <= i1; i++) pts.push({ i, mid: Math.exp(a + b * (i - i0)), up: Math.exp(a + b * (i - i0) + 2 * sd), lo: Math.exp(a + b * (i - i0) - 2 * sd) });
    return { pts, slopePerBar: Math.exp(b) - 1 };
  }

  const MAIN = [['ma', 'MA'], ['ema', 'EMA'], ['boll', 'BOLL'], ['sar', 'SAR'], ['tend', 'Tendencia']];
  const SUB = [['vol', 'VOL'], ['kdj', 'KDJ'], ['rsi', 'RSI'], ['macd', 'MACD']];

  function fmt(v) {
    if (v == null || !isFinite(v)) return '–';
    if (Math.abs(v) < 1e-9) return '0';
    const a = Math.abs(v), d = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function bigv(v) { if (!v) return '0'; const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(2) + ' mil M' : a >= 1e6 ? (v / 1e6).toFixed(2) + ' M' : a >= 1e3 ? (v / 1e3).toFixed(1) + ' K' : v.toFixed(0); }
  const sp = (color, txt) => `<span style="color:${color}">${txt}</span>`;

  /**
   * Dibuja la gráfica en `root`.
   * data = {t,o,h,l,c,v} (segundos UTC), opts = {intraday, cost, currency, prefs, onPrefs, visible}
   */
  function render(root, data, opts) {
    // Colores del tema elegido en Ajustes.
    try { const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
      if (v('--card')) { COL.bg = v('--card'); COL.grid = v('--line'); COL.text = v('--muted'); COL.trend = v('--text'); } } catch (e) {}
    if (!LWC) { root.innerHTML = '<div class="muted">No se pudo cargar la gráfica.</div>'; return () => {}; }
    const prefs = opts.prefs;
    const off = -new Date().getTimezoneOffset() * 60; // se muestra en hora local
    const n = data.c.length;
    const T = data.t.map(x => x + off);
    // Lightweight Charts exige tiempos estrictamente crecientes.
    const idx = []; for (let i = 0; i < n; i++) if (!idx.length || T[i] > T[idx[idx.length - 1]]) idx.push(i);
    const pick = arr => idx.map(i => arr[i]);
    const t = pick(T), o = pick(data.o), h = pick(data.h), l = pick(data.l), c = pick(data.c), v = pick(data.v);
    const hasVol = v.some(x => x > 0);
    const subs = SUB.filter(([k]) => prefs.sub === k && (k !== 'vol' || hasVol)).map(x => x[0]);
    const showVol = hasVol && prefs.vol !== false;

    root.innerHTML = `<div class="pc-wrap"><div class="pc-legend" id="pcLeg"></div><div id="pcMain" class="pc-pane"></div></div>
      ${showVol ? '<div class="pc-wrap"><div class="pc-legend" id="pcVolLeg"></div><div id="pcVol" class="pc-pane pc-sub"></div></div>' : ''}
      ${subs.map(k => `<div class="pc-wrap"><div class="pc-legend" id="pcSubLeg"></div><div id="pcSub" class="pc-pane pc-sub"></div></div>`).join('')}`;
    const W = root.clientWidth || 360;
    const base = (el, height, timeVisible, logo, pf) => LWC.createChart(el, {
      width: W, height,
      layout: { background: { type: 'solid', color: COL.bg }, textColor: COL.text, fontSize: 11, attributionLogo: !!logo },
      grid: { vertLines: { color: COL.grid }, horzLines: { color: COL.grid } },
      rightPriceScale: { borderColor: COL.grid, minimumWidth: 64 },
      timeScale: { borderColor: COL.grid, visible: timeVisible, timeVisible: !!opts.intraday, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: { locale: 'es-ES', priceFormatter: pf || fmt },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });
    const lastPane = subs.length ? 'sub' : showVol ? 'vol' : 'main';
    const charts = [];
    // Fechas siempre debajo de las velas (y también en el último panel), para que se vean sin bajar la pantalla.
    const main = base(root.querySelector('#pcMain'), 300, true, true); charts.push(main);
    const line = (ch, color, width = 1, extra = {}) => ch.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
    const ser = (arr) => { const out = []; arr.forEach((x, i) => { if (x != null && isFinite(x)) out.push({ time: t[i], value: x }); }); return out; };

    let price;
    if (prefs.type === 'linea') {
      price = main.addAreaSeries({ lineColor: '#38bdf8', topColor: 'rgba(56,189,248,0.25)', bottomColor: 'rgba(56,189,248,0)', lineWidth: 2 });
      price.setData(ser(c));
    } else {
      price = main.addCandlestickSeries({ upColor: COL.up, downColor: COL.down, borderUpColor: COL.up, borderDownColor: COL.down, wickUpColor: COL.up, wickDownColor: COL.down });
      price.setData(t.map((x, i) => ({ time: x, open: o[i], high: h[i], low: l[i], close: c[i] })));
    }
    price.applyOptions({ priceLineStyle: LWC.LineStyle.Dashed, priceLineColor: COL.trend });
    if (opts.cost) price.createPriceLine({ price: opts.cost, color: COL.cost, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'tu compra' });

    main.priceScale('right').applyOptions({ scaleMargins: { top: 0.22, bottom: 0.05 } });
    const anchors = new Map([[main, { s: price, val: i => c[i] }]]);
    const ind = {};
    if (prefs.main.includes('ma')) { ind.ma = [[7, COL.ma1], [25, COL.ma2], [99, COL.ma3]].map(([p, col]) => ({ p, col, v: sma(c, p) })); ind.ma.forEach(m => line(main, m.col).setData(ser(m.v))); }
    if (prefs.main.includes('ema')) { ind.ema = [[12, COL.ema1], [26, COL.ema2]].map(([p, col]) => ({ p, col, v: ema(c, p) })); ind.ema.forEach(m => line(main, m.col).setData(ser(m.v))); }
    if (prefs.main.includes('boll')) { ind.boll = boll(c); [['mid', 1], ['up', 1], ['lo', 1]].forEach(([k]) => line(main, COL.boll, 1, { lineStyle: k === 'mid' ? 0 : 2 }).setData(ser(ind.boll[k]))); }
    if (prefs.main.includes('sar')) { ind.sar = sar(h, l); line(main, COL.sar, 1, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }).setData(ser(ind.sar)); }
    let trendSeries = null;
    if (prefs.main.includes('tend')) trendSeries = [line(main, COL.trend, 2), line(main, COL.trend, 1, { lineStyle: 2 }), line(main, COL.trend, 1, { lineStyle: 2 })];

    let vol = null, volMa5, volMa10;
    if (showVol) {
      vol = base(root.querySelector('#pcVol'), 90, lastPane === 'vol', false, bigv); charts.push(vol);
      const hs = vol.addHistogramSeries({ priceFormat: { type: 'custom', formatter: bigv }, priceLineVisible: false, lastValueVisible: false });
      anchors.set(vol, { s: hs, val: i => v[i] });
      hs.setData(t.map((x, i) => ({ time: x, value: v[i], color: c[i] >= o[i] ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)' })));
      volMa5 = sma(v, 5); volMa10 = sma(v, 10);
      const vf = { priceFormat: { type: 'custom', formatter: bigv } };
      line(vol, COL.ma1, 1, vf).setData(ser(volMa5)); line(vol, COL.ma3, 1, vf).setData(ser(volMa10));
      vol.priceScale('right').applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    }
    let sub = null, subInd = null;
    if (subs.length) {
      sub = base(root.querySelector('#pcSub'), 110, true); charts.push(sub);
      const k = subs[0];
      if (k === 'kdj') { subInd = kdj(h, l, c); const sk = line(sub, COL.ma1); sk.setData(ser(subInd.K)); anchors.set(sub, { s: sk, val: i => subInd.K[i] }); line(sub, COL.ma2).setData(ser(subInd.D)); line(sub, COL.ma3).setData(ser(subInd.J)); }
      if (k === 'rsi') {
        subInd = { R: rsi(c) }; const s = line(sub, COL.ma3, 1.5); s.setData(ser(subInd.R)); anchors.set(sub, { s, val: i => subInd.R[i] });
        s.createPriceLine({ price: 70, color: COL.down, lineStyle: 2, lineWidth: 1, axisLabelVisible: true });
        s.createPriceLine({ price: 30, color: COL.up, lineStyle: 2, lineWidth: 1, axisLabelVisible: true });
      }
      if (k === 'macd') {
        subInd = macd(c);
        sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }).setData(t.map((x, i) => subInd.hist[i] == null ? null : { time: x, value: subInd.hist[i], color: subInd.hist[i] >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)' }).filter(Boolean));
        const sm = line(sub, COL.ema1); sm.setData(ser(subInd.macd)); anchors.set(sub, { s: sm, val: i => subInd.macd[i] }); line(sub, COL.ema2).setData(ser(subInd.signal));
      }
      subInd.kind = k;
      sub.priceScale('right').applyOptions({ scaleMargins: { top: 0.25, bottom: 0.05 } });
    }

    // Zoom y desplazamiento sincronizados entre los paneles.
    let syncing = false;
    charts.forEach(ch => ch.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (syncing || !r) return; syncing = true;
      charts.forEach(o2 => { if (o2 !== ch) o2.timeScale().setVisibleLogicalRange(r); });
      syncing = false;
      if (trendSeries) drawTrend(r);
    }));
    function drawTrend(r) {
      const i0 = Math.max(0, Math.ceil(r.from)), i1 = Math.min(c.length - 1, Math.floor(r.to));
      const tr = trend(t, c, i0, i1);
      if (!tr) { trendSeries.forEach(s => s.setData([])); return; }
      trendSeries[0].setData(tr.pts.map(p => ({ time: t[p.i], value: p.mid })));
      trendSeries[1].setData(tr.pts.map(p => ({ time: t[p.i], value: p.up })));
      trendSeries[2].setData(tr.pts.map(p => ({ time: t[p.i], value: p.lo })));
      lastTrend = tr;
      if (hover == null) legend(null);
    }
    let lastTrend = null, hover = null;

    // Leyendas (como en las apps de bolsa: se actualizan al tocar un punto).
    const legEl = root.querySelector('#pcLeg'), volLeg = root.querySelector('#pcVolLeg'), subLeg = root.querySelector('#pcSubLeg');
    const dateFmt = x => { const d = new Date((x - off) * 1000); return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) + (opts.intraday ? ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''); };
    function legend(i) {
      const k = i == null ? c.length - 1 : i;
      const ch = k > 0 ? c[k] / c[k - 1] - 1 : 0, amp = l[k] ? h[k] / l[k] - 1 : 0;
      const colr = ch >= 0 ? COL.up : COL.down;
      let s = `<div><b>${dateFmt(t[k])}</b>${opts.currency ? ' · ' + opts.currency : ''}</div>`;
      s += `<div>A ${sp(colr, fmt(o[k]))} M ${sp(colr, fmt(h[k]))} m ${sp(colr, fmt(l[k]))} C ${sp(colr, fmt(c[k]))} ${sp(colr, (ch >= 0 ? '+' : '') + (ch * 100).toFixed(2) + '%')} <span class="muted">rango ${(amp * 100).toFixed(2)}%</span></div>`;
      if (opts.cost) { const r = c[k] / opts.cost - 1; s += `<div>${sp(COL.cost, 'Frente a tu compra: ' + (r >= 0 ? '+' : '') + (r * 100).toFixed(1) + '%')}</div>`; }
      const ex = [];
      if (ind.ma) ex.push(ind.ma.map(m => sp(m.col, `MA(${m.p}) ${fmt(m.v[k])}`)).join(' '));
      if (ind.ema) ex.push(ind.ema.map(m => sp(m.col, `EMA(${m.p}) ${fmt(m.v[k])}`)).join(' '));
      if (ind.boll) ex.push(sp(COL.boll, `BOLL ${fmt(ind.boll.mid[k])} · sup ${fmt(ind.boll.up[k])} · inf ${fmt(ind.boll.lo[k])}`));
      if (ind.sar) ex.push(sp(COL.sar, `SAR ${fmt(ind.sar[k])} ${ind.sar[k] != null ? (ind.sar[k] < c[k] ? '(alcista)' : '(bajista)') : ''}`));
      if (lastTrend) ex.push(sp(COL.trend, `Tendencia del tramo visible: ${(lastTrend.slopePerBar * 100 >= 0 ? '+' : '')}${(lastTrend.slopePerBar * 100).toFixed(2)}% por vela`));
      legEl.innerHTML = s + (ex.length ? `<div>${ex.join('<br>')}</div>` : '');
      if (volLeg) volLeg.innerHTML = `Vol: ${sp(c[k] >= o[k] ? COL.up : COL.down, bigv(v[k]))} ${sp(COL.ma1, 'MA(5) ' + bigv(volMa5[k]))} ${sp(COL.ma3, 'MA(10) ' + bigv(volMa10[k]))}`;
      if (subLeg && subInd) {
        if (subInd.kind === 'kdj') subLeg.innerHTML = `${sp(COL.ma1, 'K ' + fmt(subInd.K[k]))} ${sp(COL.ma2, 'D ' + fmt(subInd.D[k]))} ${sp(COL.ma3, 'J ' + fmt(subInd.J[k]))}`;
        if (subInd.kind === 'rsi') subLeg.innerHTML = sp(COL.ma3, 'RSI(14) ' + fmt(subInd.R[k])) + ' <span class="muted">(&gt;70 caro · &lt;30 barato)</span>';
        if (subInd.kind === 'macd') subLeg.innerHTML = `${sp(COL.ema1, 'MACD ' + fmt(subInd.macd[k]))} ${sp(COL.ema2, 'Señal ' + fmt(subInd.signal[k]))} ${sp((subInd.hist[k] || 0) >= 0 ? COL.up : COL.down, 'Hist ' + fmt(subInd.hist[k]))}`;
      }
    }
    const tIndex = new Map(t.map((x, i) => [x, i]));
    let crossSync = false;
    charts.forEach((ch, ci) => ch.subscribeCrosshairMove(p => {
      if (crossSync) return;
      const i = p && p.time != null ? tIndex.get(p.time) : undefined;
      hover = i == null ? null : i; legend(hover);
      if (!ch.setCrosshairPosition) return;
      crossSync = true;
      charts.forEach(o2 => { if (o2 === ch) return; const an = anchors.get(o2); try { if (hover == null || !an) o2.clearCrosshairPosition(); else { const y = an.val(hover); if (y == null) o2.clearCrosshairPosition(); else o2.setCrosshairPosition(y, p.time, an.s); } } catch (e) {} });
      crossSync = false;
    }));

    // Vista inicial: las últimas `visible` velas (se amplía o reduce con dos dedos).
    const vis = opts.visible || 120;
    if (c.length > vis) main.timeScale().setVisibleLogicalRange({ from: c.length - vis, to: c.length + 3 });
    else main.timeScale().fitContent();
    const r0 = main.timeScale().getVisibleLogicalRange();
    if (r0) { charts.forEach(o2 => { if (o2 !== main) o2.timeScale().setVisibleLogicalRange(r0); }); if (trendSeries) drawTrend(r0); }
    legend(null);

    const onResize = () => { const w = root.clientWidth; if (w) charts.forEach(ch => ch.applyOptions({ width: w })); };
    window.addEventListener('resize', onResize);
    return {
      fit: () => main.timeScale().fitContent(),
      destroy: () => { window.removeEventListener('resize', onResize); charts.forEach(ch => ch.remove()); }
    };
  }

  window.ProChart = { render, MAIN, SUB, sma, ema, boll, sar, kdj, rsi, macd, trend };
})();
