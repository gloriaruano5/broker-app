// Cálculos de cartera: operaciones (FIFO), fiscalidad española, reparto, correlación y riesgo. Funciones puras.
(function (root) {
  const DAY = 86400000;

  /**
   * Reconstruye la posición a partir de las operaciones (método FIFO, el que exige Hacienda).
   * op: { type: 'compra'|'venta', date: 'YYYY-MM-DD', qty, price (moneda del activo), eur (importe total en euros con comisiones) }
   * Sin operaciones se usan los campos simples qty / cost / costEur del activo.
   */
  function position(a) {
    const ops = (a.ops || []).slice().sort((x, y) => x.date.localeCompare(y.date));
    if (!ops.length) {
      return { qty: a.qty || 0, avg: a.cost || 0, costEur: a.costEur || null, realized: [], fromOps: false };
    }
    const lots = [];
    const realized = [];
    for (const op of ops) {
      if (op.type === 'compra') {
        lots.push({ date: op.date, qty: op.qty, price: op.price, eur: op.eur != null ? op.eur : null });
      } else {
        let left = op.qty, costEur = 0, costKnown = true, costLocal = 0;
        const used = [];
        while (left > 1e-12 && lots.length) {
          const lot = lots[0];
          const take = Math.min(left, lot.qty);
          const frac = take / lot.qty;
          if (lot.eur == null) costKnown = false; else costEur += lot.eur * frac;
          costLocal += take * lot.price;
          used.push({ date: lot.date, qty: take });
          if (lot.eur != null) lot.eur -= lot.eur * frac;
          lot.qty -= take; left -= take;
          if (lot.qty <= 1e-12) lots.shift();
        }
        const proceeds = op.eur != null ? op.eur : null;
        const gain = proceeds != null && costKnown ? proceeds - costEur : null;
        realized.push({ date: op.date, year: +op.date.slice(0, 4), qty: op.qty, price: op.price, proceedsEur: proceeds,
          costEur: costKnown ? costEur : null, gainEur: gain, gainLocal: op.qty * op.price - costLocal, lots: used, oversold: left > 1e-9 });
      }
    }
    // Regla antiaplicación: una pérdida no se puede compensar si se recompra en los 2 meses anteriores o posteriores.
    const buys = ops.filter(o => o.type === 'compra');
    for (const r of realized) {
      if (r.gainEur == null || r.gainEur >= 0) continue;
      const t = Date.parse(r.date);
      const rebuy = buys.some(b => Math.abs(Date.parse(b.date) - t) <= 61 * DAY && !r.lots.some(l => l.date === b.date));
      if (rebuy) r.washRisk = true;
    }
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const costLocal = lots.reduce((s, l) => s + l.qty * l.price, 0);
    const eurKnown = lots.every(l => l.eur != null);
    return { qty, avg: qty ? costLocal / qty : 0, costEur: eurKnown && qty ? lots.reduce((s, l) => s + l.eur, 0) : null, realized, fromOps: true, lots };
  }

  // Tramos de la base del ahorro (IRPF, desde 2025).
  const BRACKETS = [[6000, 0.19], [50000, 0.21], [200000, 0.23], [300000, 0.27], [Infinity, 0.30]];
  function savingsTax(base) {
    if (base <= 0) return 0;
    let tax = 0, prev = 0;
    for (const [lim, rate] of BRACKETS) {
      const part = Math.min(base, lim) - prev;
      if (part > 0) tax += part * rate;
      prev = lim;
      if (base <= lim) break;
    }
    return tax;
  }

  // ---------- Series ----------
  const dkey = ts => new Date(ts * 1000).toISOString().slice(0, 10);

  /** Rentabilidades diarias alineadas por fecha (solo días en que cotizan todos). */
  function alignReturns(series, days = 365) {
    const ids = Object.keys(series).filter(id => series[id] && series[id].c.length > 30);
    if (!ids.length) return { ids: [], dates: [], rets: {} };
    const maps = {};
    for (const id of ids) {
      const s = series[id]; const m = new Map();
      for (let i = 0; i < s.t.length; i++) m.set(dkey(s.t[i]), s.c[i]);
      maps[id] = m;
    }
    const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
    let dates = [...maps[ids[0]].keys()].filter(d => d >= cutoff);
    for (const id of ids.slice(1)) dates = dates.filter(d => maps[id].has(d));
    dates.sort();
    const rets = {};
    for (const id of ids) {
      rets[id] = [];
      for (let i = 1; i < dates.length; i++) rets[id].push(maps[id].get(dates[i]) / maps[id].get(dates[i - 1]) - 1);
    }
    return { ids, dates, rets };
  }

  function correlation(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 20) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  function maxDrawdown(c, t) {
    let peak = c[0], peakI = 0, best = { dd: 0, peakI: 0, troughI: 0 };
    for (let i = 1; i < c.length; i++) {
      if (c[i] > peak) { peak = c[i]; peakI = i; }
      const dd = c[i] / peak - 1;
      if (dd < best.dd) best = { dd, peakI, troughI: i };
    }
    if (t) { best.peakT = t[best.peakI]; best.troughT = t[best.troughI]; }
    // Caída actual desde el máximo histórico.
    best.current = c[c.length - 1] / Math.max(...c) - 1;
    return best;
  }

  function stdev(r) {
    if (r.length < 2) return null;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  }

  /** Riesgo de la cartera con los pesos actuales, simulado sobre el último año. */
  function portfolioRisk(weights, aligned) {
    const ids = aligned.ids.filter(id => weights[id] > 0);
    const tot = ids.reduce((s, id) => s + weights[id], 0);
    if (!ids.length || !tot || aligned.dates.length < 30) return null;
    const n = aligned.dates.length - 1;
    const pr = [];
    for (let i = 0; i < n; i++) pr.push(ids.reduce((s, id) => s + (weights[id] / tot) * aligned.rets[id][i], 0));
    const curve = [1]; pr.forEach(r => curve.push(curve[curve.length - 1] * (1 + r)));
    const sd = stdev(pr);
    const sorted = pr.slice().sort((a, b) => a - b);
    return { vol: sd * Math.sqrt(252), maxDD: maxDrawdown(curve).dd, ret: curve[curve.length - 1] - 1,
      worstDay: sorted[0], var95: sorted[Math.floor(sorted.length * 0.05)], days: n };
  }

  /** Agrupa el valor por una clave y avisa de concentraciones. */
  function allocation(items, key) {
    const total = items.reduce((s, i) => s + i.value, 0);
    const groups = {};
    for (const i of items) { const k = i[key] || 'Otro'; groups[k] = (groups[k] || 0) + i.value; }
    return Object.entries(groups).map(([k, v]) => ({ k, v, w: total ? v / total : 0 })).sort((a, b) => b.v - a.v);
  }
  function concentrationWarnings(byAsset, bySector, byCountry, byFx) {
    const w = [];
    byAsset.filter(x => x.w > 0.2).forEach(x => w.push(`${x.k} pesa un ${(x.w * 100).toFixed(0)}% de la cartera (más del 20%).`));
    bySector.filter(x => x.w > 0.35 && x.k !== 'Bolsa diversificada').forEach(x => w.push(`El sector «${x.k}» supone un ${(x.w * 100).toFixed(0)}%. Si le va mal, arrastra gran parte de la cartera.`));
    byCountry.filter(x => x.w > 0.6 && x.k !== 'Global').forEach(x => w.push(`${x.k} supone un ${(x.w * 100).toFixed(0)}% de la exposición por país.`));
    const nonEur = byFx.filter(x => x.k !== 'EUR').reduce((s, x) => s + x.w, 0);
    if (nonEur > 0.8) w.push(`Un ${(nonEur * 100).toFixed(0)}% está en monedas distintas del euro: si el euro se aprecia, pierdes aunque los activos no bajen.`);
    return w;
  }

  /** Valoración a partir de los datos oficiales (BPA de 12 meses) y del historial de precios semanal. */
  function valuation(price, sec, weekly) {
    if (!sec || !sec.ttm || !sec.ttm.eps) return null;
    const v = { eps: sec.ttm.eps, pe: sec.ttm.eps > 0 ? price / sec.ttm.eps : null, growth: sec.ttm.revenueGrowth, epsGrowth: sec.ttm.epsGrowth, asOf: sec.ttm.end };
    // PER histórico: precio al cierre de cada ejercicio / BPA de ese ejercicio.
    const hist = [];
    const epsYears = (sec.fundamentals && sec.fundamentals.eps) || [];
    if (weekly && weekly.t.length) {
      for (const e of epsYears) {
        if (!(e.val > 0)) continue;
        const ts = Date.parse(e.end) / 1000;
        let idx = -1;
        for (let i = 0; i < weekly.t.length; i++) if (weekly.t[i] <= ts) idx = i; else break;
        if (idx >= 0 && ts - weekly.t[idx] < 20 * 86400) hist.push({ fy: e.fy, pe: weekly.c[idx] / e.val });
      }
    }
    v.hist = hist;
    if (hist.length >= 2) {
      const s = hist.map(h => h.pe).sort((a, b) => a - b);
      const h = Math.floor(s.length / 2);
      v.medianPe = s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
    }
    if (v.pe && v.growth != null && v.growth > 0) v.peg = v.pe / (v.growth * 100);
    return v;
  }

  /**
   * Pesos según riesgo ("paridad de riesgo" sencilla): cada activo pesa en proporción inversa a su volatilidad,
   * para que ninguno domine las subidas y bajadas de la cartera. Con topes por activo y por grupo (p. ej. cripto).
   * vols = {id: volatilidad anual}, groups = {id: grupo}, caps = {asset: 0.15, groups: {Cripto: 0.15}}
   */
  function riskWeights(vols, groups = {}, caps = {}) {
    const ids = Object.keys(vols).filter(id => vols[id] > 0);
    if (!ids.length) return {};
    let w = {}; ids.forEach(id => w[id] = 1 / Math.max(0.05, vols[id]));
    const norm = () => { const t = ids.reduce((s, id) => s + w[id], 0); ids.forEach(id => w[id] /= t); };
    norm();
    const capA = caps.asset || 1, capG = caps.groups || {};
    for (let it = 0; it < 20; it++) {
      let excess = 0; const free = [];
      ids.forEach(id => { if (w[id] > capA) { excess += w[id] - capA; w[id] = capA; } });
      for (const [g, cap] of Object.entries(capG)) {
        const gi = ids.filter(id => groups[id] === g), gw = gi.reduce((s, id) => s + w[id], 0);
        if (gw > cap) { gi.forEach(id => { const nw = w[id] * cap / gw; excess += w[id] - nw; w[id] = nw; }); }
      }
      if (excess < 1e-9) break;
      // El sobrante se reparte entre los que no han tocado tope, en la misma proporción inversa a la volatilidad.
      ids.forEach(id => { const g = groups[id]; const gFull = g && capG[g] != null && ids.filter(j => groups[j] === g).reduce((s, j) => s + w[j], 0) >= capG[g] - 1e-9; if (w[id] < capA - 1e-9 && !gFull) free.push(id); });
      if (!free.length) break;
      const base = free.reduce((s, id) => s + 1 / Math.max(0.05, vols[id]), 0);
      free.forEach(id => w[id] += excess * (1 / Math.max(0.05, vols[id])) / base);
    }
    norm();
    return w;
  }
  /** Diferencias entre el reparto actual y el propuesto; avisa cuando un activo se separa más de la banda. */
  function rebalancePlan(current, target, total, band = 0.25, minPts = 0.02) {
    return Object.keys({ ...current, ...target }).map(id => {
      const cw = current[id] || 0, tw = target[id] || 0, diff = tw - cw;
      const out = Math.abs(diff) > Math.max(minPts, tw * band);
      return { id, cw, tw, diff, eur: diff * total, out };
    }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }

  /**
   * Aportación mensual sin vender nada: reparte `amount` € entre los activos que están por debajo de su peso propuesto,
   * para acercar la cartera al reparto ideal. current = {id: € actuales}, target = {id: peso}, minOrder = € mínimos por orden.
   */
  function contributionPlan(current, target, amount, minOrder = 10) {
    const ids = Object.keys(target);
    const T = ids.reduce((x, id) => x + (current[id] || 0), 0) + amount;
    let need = {}; ids.forEach(id => need[id] = Math.max(0, target[id] * T - (current[id] || 0)));
    const S = ids.reduce((x, id) => x + need[id], 0);
    let alloc = {};
    if (S >= amount && S > 0) ids.forEach(id => alloc[id] = need[id] * amount / S);
    else ids.forEach(id => alloc[id] = need[id] + (amount - S) * target[id]);
    // Órdenes muy pequeñas no compensan: se quitan y se reparte lo suyo entre las demás.
    for (let k = 0; k < 10; k++) {
      const small = ids.filter(id => alloc[id] > 0 && alloc[id] < minOrder);
      if (!small.length) break;
      const freed = small.reduce((x, id) => x + alloc[id], 0); small.forEach(id => alloc[id] = 0);
      const rest = ids.filter(id => alloc[id] > 0), rs = rest.reduce((x, id) => x + alloc[id], 0);
      if (!rest.length) { const best = ids.slice().sort((x, y) => need[y] - need[x])[0]; alloc[best] = amount; break; }
      rest.forEach(id => alloc[id] += freed * alloc[id] / rs);
    }
    return ids.filter(id => alloc[id] > 0.5).map(id => ({ id, eur: alloc[id], after: ((current[id] || 0) + alloc[id]) / T, target: target[id] })).sort((x, y) => y.eur - x.eur);
  }

  const api = { contributionPlan, riskWeights, rebalancePlan, position, savingsTax, alignReturns, correlation, maxDrawdown, stdev, portfolioRisk, allocation, concentrationWarnings, valuation, BRACKETS };
  root.Portfolio = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
