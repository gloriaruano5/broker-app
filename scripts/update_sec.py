#!/usr/bin/env python3
"""Descarga de SEC EDGAR los datos oficiales de los activos de EE. UU. y los movimientos de grandes fondos (13F).

Genera data/sec.json, que la app lee desde GitHub. Solo usa la biblioteca estándar.
La SEC pide un User-Agent con contacto: se toma de la variable SEC_CONTACT (secreto opcional del repositorio).
"""
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTACT = os.environ.get("SEC_CONTACT") or "broker-app-github-actions@users.noreply.github.com"
UA = f"BrokerApp personal research {CONTACT}"
CFG = json.load(open(os.path.join(ROOT, "scripts", "sec_config.json"), encoding="utf-8"))

_last = [0.0]


def get(url, as_json=True):
    """Petición con pausa para respetar el límite de la SEC (10 por segundo)."""
    for attempt in range(4):
        wait = 0.15 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            return json.loads(data) if as_json else data
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < 3:
                time.sleep(2)
                continue
            raise


def cik10(cik):
    return str(int(cik)).zfill(10)


def strip_ns(root):
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def txt(el, path):
    x = el.find(path)
    return x.text.strip() if x is not None and x.text else None


def fnum(s):
    try:
        return float(str(s).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ---------------- Empresas ----------------

ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
METRICS = {
    "revenue": [("us-gaap", "Revenues"), ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
                ("us-gaap", "SalesRevenueNet"), ("ifrs-full", "Revenue")],
    "operatingIncome": [("us-gaap", "OperatingIncomeLoss"), ("ifrs-full", "ProfitLossFromOperatingActivities")],
    "netIncome": [("us-gaap", "NetIncomeLoss"), ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"), ("ifrs-full", "ProfitLoss")],
    "eps": [("us-gaap", "EarningsPerShareDiluted"), ("ifrs-full", "DilutedEarningsLossPerShare")],
    "assets": [("us-gaap", "Assets"), ("ifrs-full", "Assets")],
    "liabilities": [("us-gaap", "Liabilities"), ("ifrs-full", "Liabilities")],
    "equity": [("us-gaap", "StockholdersEquity"), ("ifrs-full", "EquityAttributableToOwnersOfParent"), ("ifrs-full", "Equity")],
    "cash": [("us-gaap", "CashAndCashEquivalentsAtCarryingValue"), ("ifrs-full", "CashAndCashEquivalents")],
    "longTermDebt": [("us-gaap", "LongTermDebtNoncurrent"), ("us-gaap", "LongTermDebt"), ("ifrs-full", "NoncurrentFinancialLiabilities")],
    "opCashFlow": [("us-gaap", "NetCashProvidedByUsedInOperatingActivities"), ("ifrs-full", "CashFlowsFromUsedInOperatingActivities")],
}


def fundamentals(cik):
    facts = get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10(cik)}.json")["facts"]
    out, currency = {}, None
    for key, candidates in METRICS.items():
        best = None
        for ns, tag in candidates:
            node = facts.get(ns, {}).get(tag)
            if not node:
                continue
            for unit, rows in node["units"].items():
                by_year = {}
                for r in rows:
                    if r.get("form") not in ANNUAL_FORMS or r.get("fp") not in ("FY", None):
                        continue
                    if r.get("start"):  # partidas de periodo: solo años completos
                        d = (date.fromisoformat(r["end"]) - date.fromisoformat(r["start"])).days
                        if d < 330 or d > 400:
                            continue
                    fy = int(r["end"][:4])
                    if fy not in by_year or r["filed"] > by_year[fy]["filed"]:
                        by_year[fy] = r
                if by_year and (best is None or max(by_year) > max(x["fy"] for x in best[1])):
                    best = (unit, [{"fy": fy, "end": r["end"], "val": r["val"]} for fy, r in sorted(by_year.items())])
        if best:
            out[key] = best[1][-6:]
            if key == "revenue":
                currency = best[0]
    ttm = {}
    for key in ("eps", "revenue", "netIncome"):
        rows = best_rows(facts, METRICS[key])
        if rows:
            r = trailing(rows)
            if r:
                ttm[key], ttm[key + "Growth"], ttm["end"] = r[0], r[1], max(ttm.get("end", ""), r[2])
    return out, currency or "USD", ttm


def best_rows(facts, candidates):
    """Filas (sin filtrar) de la etiqueta con datos más recientes."""
    best = None
    for ns, tag in candidates:
        node = facts.get(ns, {}).get(tag)
        if not node:
            continue
        for unit, rows in node["units"].items():
            if not rows:
                continue
            last = max(r["end"] for r in rows)
            if best is None or last > best[0]:
                best = (last, rows)
    return best[1] if best else None


def _dur(r):
    return (date.fromisoformat(r["end"]) - date.fromisoformat(r["start"])).days if r.get("start") else None


def trailing(rows):
    """Últimos 12 meses = último ejercicio + acumulado del año en curso - mismo acumulado del año anterior.
    Devuelve (valor 12 meses, crecimiento interanual, fecha)."""
    uniq = {}
    for r in rows:
        d = _dur(r)
        if d is None:
            continue
        k = (r["start"], r["end"])
        if k not in uniq or r["filed"] > uniq[k]["filed"]:
            uniq[k] = r
    rows = list(uniq.values())
    annual = sorted([r for r in rows if 330 <= _dur(r) <= 400], key=lambda r: r["end"])
    if not annual:
        return None
    fy = annual[-1]
    ytd = sorted([r for r in rows if 80 <= _dur(r) <= 300 and r["start"] > fy["start"] and r["end"] > fy["end"]],
                 key=lambda r: (r["end"], _dur(r)))
    if ytd:
        cur = ytd[-1]
        target_end = date.fromisoformat(cur["end"]) - timedelta(days=365)
        prev = [r for r in rows if abs(_dur(r) - _dur(cur)) <= 10
                and abs((date.fromisoformat(r["end"]) - target_end).days) <= 12]
        if prev:
            p = prev[0]
            val = fy["val"] + cur["val"] - p["val"]
            growth = cur["val"] / p["val"] - 1 if p["val"] > 0 else None
            return val, growth, cur["end"]
    prev_fy = annual[-2] if len(annual) > 1 else None
    growth = fy["val"] / prev_fy["val"] - 1 if prev_fy and prev_fy["val"] > 0 else None
    return fy["val"], growth, fy["end"]


def form4(cik, acc, primary):
    """Lee un formulario 4 (compras y ventas de directivos)."""
    acc_nd = acc.replace("-", "")
    raw = primary.split("/")[-1]  # quita el prefijo de la hoja de estilo (xslF345X05/)
    url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/{raw}"
    root = strip_ns(ET.fromstring(get(url, as_json=False)))
    owner = txt(root, "reportingOwner/reportingOwnerId/rptOwnerName") or "?"
    rel = root.find("reportingOwner/reportingOwnerRelationship")
    title = None
    if rel is not None:
        title = txt(rel, "officerTitle")
        if not title and (txt(rel, "isDirector") or "").lower() in ("1", "true"):
            title = "Consejero"
        if not title and (txt(rel, "isTenPercentOwner") or "").lower() in ("1", "true"):
            title = "Accionista >10%"
    tx = []
    for t in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        tx.append({
            "code": txt(t, "transactionCoding/transactionCode"),
            "shares": fnum(txt(t, "transactionAmounts/transactionShares/value")),
            "price": fnum(txt(t, "transactionAmounts/transactionPricePerShare/value")),
            "ad": txt(t, "transactionAmounts/transactionAcquiredDisposedCode/value"),
        })
    plan = b"10b5-1" in ET.tostring(root)
    return {"owner": owner.title(), "title": title, "tx": tx, "plan": plan,
            "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/{primary}"}


def company(ticker, cik):
    sub = get(f"https://data.sec.gov/submissions/CIK{cik10(cik)}.json")
    rec = sub["filings"]["recent"]
    rows = [dict(zip(rec.keys(), vals)) for vals in zip(*rec.values())]
    forms = set(r["form"] for r in rows)
    foreign = not ({"10-K", "10-Q"} & forms) and bool({"20-F", "6-K", "40-F"} & forms)
    keep = {"10-K", "10-Q", "8-K", "20-F", "6-K", "40-F", "DEF 14A", "N-CSR", "N-CSRS", "N-2", "10-K/A", "S-1"}
    filings = []
    for r in rows:
        if r["form"] in keep and len(filings) < 25:
            acc_nd = r["accessionNumber"].replace("-", "")
            filings.append({"form": r["form"], "date": r["filingDate"], "items": r.get("items") or "",
                            "desc": r.get("primaryDocDescription") or "",
                            "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/{r['primaryDocument']}"})
    insiders = []
    cutoff = (date.today() - timedelta(days=365)).isoformat()
    for r in rows:
        if r["form"] != "4" or r["filingDate"] < cutoff or len(insiders) >= 30:
            continue
        try:
            f = form4(cik, r["accessionNumber"], r["primaryDocument"])
            f["date"] = r["filingDate"]
            insiders.append(f)
        except Exception as e:  # un formulario defectuoso no debe parar todo
            print(f"  aviso form4 {ticker} {r['accessionNumber']}: {e}", file=sys.stderr)
    try:
        fund, ccy, ttm = fundamentals(cik)
    except Exception as e:
        print(f"  aviso fundamentales {ticker}: {e}", file=sys.stderr)
        fund, ccy, ttm = {}, "USD", {}
    # El PER solo es fiable si las cifras están en dólares y por acción ordinaria (no ADR extranjero).
    if foreign or ccy != "USD":
        ttm = {}
    nxt = next_report(rows)
    return {"cik": int(cik), "name": sub.get("name"), "foreign": foreign, "filings": filings,
            "insiders": insiders, "fundamentals": fund, "currency": ccy, "ttm": ttm, "nextReport": nxt}


def next_report(rows):
    """Estimación de la próxima presentación de resultados: último 10-Q/10-K/20-F + ~3 meses."""
    reports = [r for r in rows if r["form"] in ("10-Q", "10-K", "20-F", "6-K") and r.get("reportDate")]
    reports = [r for r in reports if r["form"] != "6-K"] or reports
    if not reports:
        return None
    last = max(reports, key=lambda r: r["filingDate"])
    period = date.fromisoformat(last["reportDate"])
    lag = (date.fromisoformat(last["filingDate"]) - period).days
    step = 365 if last["form"] == "20-F" else 91
    nxt_period = period + timedelta(days=step)
    return {"estimate": (nxt_period + timedelta(days=lag)).isoformat(), "lastFiled": last["filingDate"], "lastForm": last["form"]}


# ---------------- Fondos 13F ----------------

def holdings_13f(cik, acc):
    acc_nd = acc.replace("-", "")
    idx = get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/index.json")
    files = [i["name"] for i in idx["directory"]["item"] if i["name"].lower().endswith(".xml")]
    table = [f for f in files if "primary_doc" not in f.lower()]
    if not table:
        return []
    root = strip_ns(ET.fromstring(get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/{table[0]}", as_json=False)))
    out = []
    for it in root.iter("infoTable"):
        out.append({"name": (txt(it, "nameOfIssuer") or "").upper(), "cusip": (txt(it, "cusip") or "").upper(),
                    "cls": (txt(it, "titleOfClass") or "").upper(), "value": fnum(txt(it, "value")) or 0,
                    "shares": fnum(txt(it, "shrsOrPrnAmt/sshPrnamt")) or 0,
                    "put": (txt(it, "putCall") or "").upper()})
    return out


def match(h, rule):
    if h["put"]:  # opciones put/call no son posición directa
        return False
    if rule.get("cusips") and h["cusip"][:6] in [c[:6] for c in rule["cusips"]]:
        return True
    return bool(re.search(rule["pattern"], h["name"]))


def sum_positions(holdings, rule):
    shares = value = 0.0
    for h in holdings:
        if match(h, rule):
            shares += h["shares"]
            value += h["value"]
    return shares, value


def funds(tickers):
    positions = {t: [] for t in tickers}
    period = None
    tracked = []
    for fund in CFG["funds"]:
        try:
            sub = get(f"https://data.sec.gov/submissions/CIK{cik10(fund['cik'])}.json")
            rec = sub["filings"]["recent"]
            rows = [dict(zip(rec.keys(), v)) for v in zip(*rec.values())]
            f13 = [r for r in rows if r["form"] in ("13F-HR", "13F-HR/A")]
            # Un informe por trimestre (la última versión de cada periodo).
            by_period = {}
            for r in f13:
                p = r.get("reportDate") or r["filingDate"]
                if p not in by_period:
                    by_period[p] = r
            periods = sorted(by_period, reverse=True)[:2]
            if not periods:
                continue
            # Fondos que ya no presentan informes (cerrados o con otro registro): se ignoran.
            if periods[0] < (date.today() - timedelta(days=200)).isoformat():
                print(f"  13F {fund['name']}: último informe {periods[0]}, demasiado antiguo; se omite")
                continue
            latest = holdings_13f(fund["cik"], by_period[periods[0]]["accessionNumber"])
            prev = holdings_13f(fund["cik"], by_period[periods[1]]["accessionNumber"]) if len(periods) > 1 else []
            tracked.append(fund["name"])
            period = max(period or periods[0], periods[0])
            # Desde 2023 los valores se dan en dólares; antes en miles.
            mult = 1000 if periods[0] < "2022-12-31" else 1
            for t in tickers:
                rule = CFG["match"].get(t)
                if not rule:
                    continue
                s1, v1 = sum_positions(latest, rule)
                s0, _ = sum_positions(prev, rule)
                if s1 == 0 and s0 == 0:
                    continue
                if s0 == 0:
                    status, chg = "nueva", None
                elif s1 == 0:
                    status, chg = "vende todo", -1.0
                else:
                    chg = s1 / s0 - 1
                    status = "aumenta" if chg > 0.02 else "reduce" if chg < -0.02 else "mantiene"
                positions[t].append({"fund": fund["name"], "manager": (sub.get("name") or "").title(), "shares": s1,
                                     "value": v1 * mult, "prevShares": s0, "changePct": chg, "status": status,
                                     "period": periods[0]})
            print(f"  13F {fund['name']}: {periods[0]} ({len(latest)} posiciones)")
        except Exception as e:
            print(f"  aviso 13F {fund['name']}: {e}", file=sys.stderr)
    for t in positions:
        positions[t].sort(key=lambda p: -p["value"])
    return {"period": period, "tracked": tracked, "positions": positions}


def main():
    tickers_map = get("https://www.sec.gov/files/company_tickers.json")
    by_ticker = {v["ticker"].upper(): v["cik_str"] for v in tickers_map.values()}
    result = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "assets": {}}
    tickers = CFG["tickers"]
    for t in tickers:
        cik = CFG.get("ciks", {}).get(t) or by_ticker.get(t)
        if not cik:
            print(f"  aviso: {t} no encontrado en la SEC", file=sys.stderr)
            continue
        try:
            print(f"Empresa {t} (CIK {cik})")
            result["assets"][t] = company(t, cik)
        except Exception as e:
            print(f"  aviso {t}: {e}", file=sys.stderr)
    result["funds"] = funds(tickers)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "sec.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("OK data/sec.json")


if __name__ == "__main__":
    main()
