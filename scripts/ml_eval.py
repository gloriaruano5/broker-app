"""Compara modelos de predicción con el método actual de la app, sin mirar al futuro.

Rangos de precio (80%) a 4 y 13 semanas:
  - vol:      método inicial (volatilidad de 3 años, campana simétrica)
  - vol_cal:  método actual de la app (calibrado con los percentiles reales del propio activo, solo pasado)
  - chronos:  Chronos-Bolt de Amazon (modelo fundacional de series temporales, sin entrenar con estos datos)
  - timesfm:  TimesFM de Google (si se puede instalar)
Señal (subirá o no en los próximos 3 meses):
  - app:      puntuación técnica actual de la app
  - lgbm:     gradient boosting (LightGBM) entrenado año a año solo con datos anteriores
  - chronos:  dirección de la mediana de Chronos

Uso: python scripts/ml_eval.py /tmp/hist  -> imprime el resumen y escribe data/ml.json
"""
import json, math, os, sys, time, traceback
import numpy as np
import pandas as pd

D = sys.argv[1] if len(sys.argv) > 1 else '/tmp/hist'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'ml.json')
meta = json.load(open(os.path.join(D, 'meta.json')))
START = pd.Timestamp('2019-01-01')
Z = 1.2816
lines, result = [], {'updated': time.strftime('%Y-%m-%d')}
def log(s):
    print(s, flush=True); lines.append(s)

# ---------- Datos ----------
S, W, SC = {}, {}, {}
for aid in meta:
    s = pd.read_csv(os.path.join(D, f'{aid}.csv'), parse_dates=['date']).drop_duplicates('date').set_index('date')['close'].astype(float)
    s = s[s > 0]
    S[aid] = s
    W[aid] = s.resample('W-FRI').last().dropna()
    sc = pd.read_csv(os.path.join(D, f'{aid}_score.csv'), parse_dates=['date']).set_index('date')['score']
    SC[aid] = sc
log(f'Activos: {len(S)} ({", ".join(S)})')

# ---------- 1. Rangos ----------
H = [4, 13]
def vol_interval(w_hist, h):
    lr = np.clip(np.diff(np.log(w_hist.values[-157:])), -0.7, 0.7)
    if len(lr) < 26: return None
    sd = lr.std(ddof=1) * math.sqrt(h)
    return -Z * sd, Z * sd, sd

rows = []  # (aid, date, h, method, lo, hi, actual)
tasks = []  # para los modelos: (aid, date, índice semanal)
for aid, w in W.items():
    lw = np.log(w.values)
    lr = np.clip(np.diff(lw), -0.7, 0.7)
    # desviación semanal de las 156 semanas anteriores a cada semana i (solo pasado)
    sdw = np.full(len(w), np.nan)
    for i in range(27, len(w)):
        seg = lr[max(0, i - 156):i]
        sdw[i] = seg.std(ddof=1)
    idx = [i for i, d in enumerate(w.index) if d >= START]
    for i in idx[::4]:
        if i < 60 or np.isnan(sdw[i]): continue
        for h in H:
            if i + h >= len(w): continue
            actual = lw[i + h] - lw[i]
            sd = sdw[i] * math.sqrt(h)
            rows.append((aid, w.index[i], h, 'vol', -Z * sd, Z * sd, actual))
            # calibrado como en la app: percentiles 10 y 90 de rendimientos estandarizados ya conocidos (j + h <= i)
            us = [(lw[j + h] - lw[j]) / (sdw[j] * math.sqrt(h)) for j in range(60, i - h + 1) if not np.isnan(sdw[j])]
            if len(us) >= 40:
                q10 = max(-2.5, min(-0.5, float(np.quantile(us, 0.1)))); q90 = min(2.5, max(0.5, float(np.quantile(us, 0.9))))
                lo, hi = q10 * sd, q90 * sd
            else:
                lo, hi = -Z * sd, Z * sd
            rows.append((aid, w.index[i], h, 'vol_cal', lo, hi, actual))
        tasks.append((aid, w.index[i], i))
log(f'Puntos de prueba de rangos: {len(tasks)}')

def run_chronos():
    import torch
    from chronos import BaseChronosPipeline
    pipe = BaseChronosPipeline.from_pretrained('amazon/chronos-bolt-small', device_map='cpu', torch_dtype=torch.float32)
    out = {}
    B = 64
    for k in range(0, len(tasks), B):
        batch = tasks[k:k + B]
        ctx = [torch.tensor(W[a].values[max(0, i - 511):i + 1], dtype=torch.float32) for a, d, i in batch]
        q, _ = pipe.predict_quantiles(context=ctx, prediction_length=max(H), quantile_levels=[0.1, 0.5, 0.9])
        q = q.numpy()
        for (a, d, i), qq in zip(batch, q):
            out[(a, d)] = qq  # [h, 3]
    return out

def run_timesfm():
    import timesfm
    tfm = timesfm.TimesFm(hparams=timesfm.TimesFmHparams(backend='cpu', per_core_batch_size=32, horizon_len=max(H)),
                          checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id='google/timesfm-1.0-200m-pytorch'))
    out = {}
    B = 64
    for k in range(0, len(tasks), B):
        batch = tasks[k:k + B]
        ctx = [W[a].values[max(0, i - 511):i + 1].astype(np.float32) for a, d, i in batch]
        _, qf = tfm.forecast(ctx, freq=[1] * len(ctx))
        for (a, d, i), qq in zip(batch, qf):
            out[(a, d)] = qq[:, [1, 5, 9]]  # columnas: media, q0.1..q0.9
    return out

MODEL_FC = {}
for name, fn in [('chronos', run_chronos), ('timesfm', run_timesfm)]:
    t0 = time.time()
    try:
        MODEL_FC[name] = fn()
        log(f'{name}: {len(MODEL_FC[name])} predicciones en {time.time() - t0:.0f} s')
    except Exception as e:
        log(f'{name}: no disponible ({type(e).__name__}: {str(e)[:200]})')
        traceback.print_exc()

for name, fc in MODEL_FC.items():
    for aid, d, i in tasks:
        qq = fc.get((aid, d))
        if qq is None: continue
        w = W[aid]; lw = np.log(w.values); p0 = w.values[i]
        for h in H:
            if i + h >= len(w): continue
            lo, hi = math.log(max(qq[h - 1, 0], 1e-9) / p0), math.log(max(qq[h - 1, 2], 1e-9) / p0)
            rows.append((aid, d, h, name, lo, hi, lw[i + h] - lw[i]))

R = pd.DataFrame(rows, columns=['aid', 'date', 'h', 'method', 'lo', 'hi', 'actual'])
# Solo puntos donde todos los métodos tienen predicción, para comparar en igualdad.
key = R.groupby(['aid', 'date', 'h'])['method'].transform('nunique')
R = R[key == R['method'].nunique()]
R['inside'] = (R.actual >= R.lo) & (R.actual <= R.hi)
R['width'] = R.hi - R.lo
R['score'] = R.width + (2 / 0.2) * ((R.lo - R.actual).clip(lower=0) + (R.actual - R.hi).clip(lower=0))  # interval score (menor = mejor)
R['period'] = np.where(R.date < pd.Timestamp('2023-01-01'), '2019-22', '2023-26')
log('')
log('RANGOS 80% (acierto = % dentro, objetivo 80%; puntuación de intervalo: menor es mejor; anchura en % de precio)')
summ = {}
for h in H:
    for m, g in R[R.h == h].groupby('method'):
        per = {p: gg for p, gg in g.groupby('period')}
        txt = ' | '.join(f"{p}: dentro {gg.inside.mean()*100:.0f}%, punt. {gg.score.mean():.3f}" for p, gg in per.items())
        log(f'  {h:>2} sem · {m:<8} dentro {g.inside.mean()*100:.0f}% · anchura {(np.exp(g.width.mean())-1)*100:.0f}% · puntuación {g.score.mean():.3f} · ganan los activos: {txt}')
        summ[f'{h}|{m}'] = {'coverage': float(g.inside.mean()), 'score': float(g.score.mean()), 'n': int(len(g)),
                            'byPeriod': {p: {'coverage': float(gg.inside.mean()), 'score': float(gg.score.mean())} for p, gg in per.items()}}
    # ¿En cuántos activos gana cada modelo al método actual?
    base = R[(R.h == h) & (R.method == 'vol_cal')].groupby('aid').score.mean()
    for m in R.method.unique():
        if m == 'vol_cal': continue
        other = R[(R.h == h) & (R.method == m)].groupby('aid').score.mean()
        log(f'     {m} mejor que el actual en {(other < base).sum()} de {len(base)} activos')
result['ranges'] = summ

# ---------- 2. Señal ----------
def rsi(c, n=14):
    d = c.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))
def feats(s):
    f = pd.DataFrame(index=s.index)
    f['dist200'] = s / s.rolling(200).mean() - 1
    f['g50_200'] = s.rolling(50).mean() / s.rolling(200).mean() - 1
    f['rsi'] = rsi(s)
    for n in (21, 63, 126, 252): f[f'mom{n}'] = s / s.shift(n) - 1
    f['vol63'] = np.log(s).diff().rolling(63).std() * math.sqrt(252)
    f['dd252'] = s / s.rolling(252).max() - 1
    return f
mkt = {'stock': feats(S['sp500'])[['dist200', 'mom63']].add_prefix('mkt_') if 'sp500' in S else None,
       'crypto': feats(S['btc'])[['dist200', 'mom63']].add_prefix('mkt_') if 'btc' in S else None}
frames = []
for aid, s in S.items():
    f = feats(s)
    crypto = meta[aid]['type'] == 'Cripto'
    m = mkt['crypto' if crypto else 'stock']
    if m is not None: f = f.join(m.reindex(f.index, method='ffill'))
    f['crypto'] = int(crypto)
    # objetivo: rentabilidad a 91 días naturales (≈3 meses)
    fut = s.reindex(f.index + pd.Timedelta(days=91), method='ffill').values
    f['fwd'] = np.log(fut / s.values)
    f.loc[f.index + pd.Timedelta(days=91) > s.index[-1], 'fwd'] = np.nan
    f['app'] = SC[aid].reindex(f.index, method='ffill').values
    f['aid'] = aid
    f = f.iloc[260::5]
    frames.append(f)
F = pd.concat(frames).dropna(subset=['dist200', 'mom252', 'vol63'])
F['date'] = F.index
F.index.name = None
FEATS = ['dist200', 'g50_200', 'rsi', 'mom21', 'mom63', 'mom126', 'mom252', 'vol63', 'dd252', 'mkt_dist200', 'mkt_mom63', 'crypto']
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr
preds = []
for year in range(2019, 2027):
    t0 = pd.Timestamp(f'{year}-01-01')
    train = F[(F.date + pd.Timedelta(days=95) < t0) & F.fwd.notna()]
    test = F[(F.date >= t0) & (F.date < pd.Timestamp(f'{year + 1}-01-01'))].copy()
    if len(train) < 500 or not len(test): continue
    y = (train.fwd > 0).astype(int)
    clf = lgb.LGBMClassifier(n_estimators=200, learning_rate=0.03, num_leaves=15, min_child_samples=50, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    clf.fit(train[FEATS], y)
    test['lgbm'] = clf.predict_proba(test[FEATS])[:, 1]
    preds.append(test)
P = pd.concat(preds)
E = P[P.fwd.notna()].copy()
E['up'] = (E.fwd > 0).astype(int)
E['period'] = np.where(E.date < pd.Timestamp('2023-01-01'), '2019-22', '2023-26')
log('')
log('SEÑAL: ¿acierta si sube en 3 meses? (AUC: 0,5 = azar, 1 = perfecto; IC: correlación con la rentabilidad real)')
sig = {}
for col in ['app', 'lgbm']:
    if col not in E or E[col].isna().all(): continue
    out = []
    for p, g in [('todo', E)] + list(E.groupby('period')):
        g = g.dropna(subset=[col])
        if g.up.nunique() < 2: continue
        auc = roc_auc_score(g.up, g[col]); ic = spearmanr(g[col], g.fwd).correlation
        # IC medio por fecha (compara activos entre sí la misma semana)
        icd = g.groupby('date').apply(lambda x: spearmanr(x[col], x.fwd).correlation if len(x) >= 5 else np.nan).mean()
        out.append(f'{p}: AUC {auc:.3f}, IC {ic:.3f}, IC entre activos {icd:.3f} (n={len(g)})')
        sig[f'{col}|{p}'] = {'auc': float(auc), 'ic': float(ic), 'icCross': float(icd), 'n': int(len(g))}
    log(f'  {col:<8} ' + ' | '.join(out))
# Modelos fundacionales: dirección de su mediana a 13 semanas frente a la puntuación de la app en las mismas fechas
for name, fc in MODEL_FC.items():
    rr = []
    for aid, d, i in tasks:
        qq = fc.get((aid, d)); w = W[aid]
        if qq is None or i + 13 >= len(w): continue
        app = SC[aid][:d]
        rr.append((d, aid, math.log(max(qq[12, 1], 1e-9) / w.values[i]), float(app.iloc[-1]) if len(app) else np.nan, math.log(w.values[i + 13] / w.values[i])))
    G = pd.DataFrame(rr, columns=['date', 'aid', 'pred', 'app', 'fwd']).dropna()
    if len(G) > 50:
        up = (G.fwd > 0).astype(int)
        log(f'  {name:<8} AUC {roc_auc_score(up, G.pred):.3f}, IC {spearmanr(G.pred, G.fwd).correlation:.3f} · en esas mismas fechas la app: AUC {roc_auc_score(up, G.app):.3f}, IC {spearmanr(G.app, G.fwd).correlation:.3f} (n={len(G)})')
        sig[f'{name}|todo'] = {'auc': float(roc_auc_score(up, G.pred)), 'ic': float(spearmanr(G.pred, G.fwd).correlation), 'appAuc': float(roc_auc_score(up, G.app)), 'n': int(len(G))}
result['signal'] = sig

# Estrategia por activo: invertido solo cuando el modelo es optimista (revisión semanal, 0,2% por cambio)
def strat(g, rule):
    s = S[g.aid.iloc[0]]; dates = list(g.index); eq = bh = pk = 1.0; dd = 0.0; prev = True
    for k in range(len(dates) - 1):
        r = s.loc[dates[k + 1]] / s.loc[dates[k]]
        inside = rule(g.iloc[k])
        if inside != prev: eq *= 0.998; prev = inside
        bh *= r
        if inside: eq *= r
        pk = max(pk, eq); dd = min(dd, eq / pk - 1)
    yrs = (dates[-1] - dates[0]).days / 365.25
    return eq ** (1 / yrs) - 1, bh ** (1 / yrs) - 1, dd
log('')
log('ESTRATEGIA 2019-2026 por activo (salir cuando la señal es mala):')
st = {}
for nm, rule in [('app', lambda r: r.app > -0.75), ('lgbm', lambda r: r.lgbm >= 0.5)]:
    res = [strat(g.sort_index(), rule) for aid, g in P.groupby('aid') if len(g) > 50]
    c = np.mean([x[0] for x in res]); b = np.mean([x[1] for x in res]); d = np.mean([x[2] for x in res])
    w = sum(x[0] > x[1] for x in res)
    log(f'  {nm:<6} {c*100:+.1f}%/año, caída máx media {d*100:.0f}% · comprar y mantener {b*100:+.1f}%/año · gana en {w}/{len(res)}')
    st[nm] = {'cagr': c, 'bh': b, 'dd': d, 'wins': int(w), 'n': len(res)}
result['strategy'] = st
imp = dict(zip(FEATS, clf.feature_importances_.tolist()))
log('  Importancia de cada dato en el último modelo: ' + ', '.join(f'{k} {v}' for k, v in sorted(imp.items(), key=lambda x: -x[1])))
result['importance'] = imp
json.dump(result, open(OUT, 'w'))
if os.environ.get('GITHUB_STEP_SUMMARY'):
    open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('```\n' + '\n'.join(lines) + '\n```\n')
