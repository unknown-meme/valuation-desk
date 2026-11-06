# -*- coding: utf-8 -*-
"""
估值决策台 · 本地数据服务
------------------------------------------------------------
纯标准库 HTTP 服务。点一次「刷新」，就去抓最新的指数点位与估值，
算出四条线（买入线 / 深入线 / 深水线 / 清仓线），判当前站在哪一档。

数据源：
  指数点位、全收益、中证全债、红利低波股息率  -> 中证指数官网（官方）
  沪深300 加权滚动PE、创业板指加权PB           -> 乐咕乐股
  十年国债收益率                               -> 新浪/东财（经 akshare）
所有原始数据落在 data/raw/*.csv，某次抓不到就用上次的缓存，页面不会白屏。
"""
import argparse
import json
import math
import os
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DATA_DIR = os.path.join(ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
CACHE_FILE = os.path.join(DATA_DIR, "latest.json")
os.makedirs(RAW_DIR, exist_ok=True)

# ---------------------------------------------------------------- 参数
PARAMS = {
    "hs300_buy_factor": 1.10,      # 买入线 = 历史底部估值中位数 x 1.10
    "hs300_sell_val": 14.34,       # 原文回测用的清仓线（PE，加权滚动）
    "cyb_buy_factor": 1.10,
    "cyb_sell_quantile": 0.75,     # 创业板清仓线 = 历史 PB 的 75% 分位
    "dividend_threshold": 5.0,     # 红利低波股息率门槛 (%)
    "trough_dd": 0.20,             # 判定“底部”的最小回撤
    "trough_rebound": 0.10,        # 底部须有的最小反弹（确认底部）
}

WARNINGS = []
FORCE = False


def warn(msg):
    WARNINGS.append(str(msg)[:200])
    print("[warn]", msg, flush=True)


SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
})


def rnd(x, n=2):
    try:
        v = float(x)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, n)


# ---------------------------------------------------------------- 抓取
def norm_dates(df):
    for col in ("date", "日期"):
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


def cached_fetch(key, fn, max_age_hours=20):
    """当天抓过就复用；抓失败且有过缓存就降级，两种情况都记一条 warning。"""
    path = os.path.join(RAW_DIR, key + ".csv")
    fresh = (not FORCE) and os.path.exists(path) and (time.time() - os.path.getmtime(path)) < max_age_hours * 3600
    if fresh:
        try:
            return norm_dates(pd.read_csv(path))
        except Exception:
            pass
    try:
        df = norm_dates(fn())
        df.to_csv(path, index=False, encoding="utf-8-sig")
        return df
    except Exception as exc:
        msg = "%s 抓取失败：%s" % (key, str(exc)[:90])
        if os.path.exists(path):
            warn(msg + "（用本地缓存顶着）")
            return norm_dates(pd.read_csv(path))
        warn(msg + "（且无缓存）")
        raise


def fetch_legulegu(kind, code):
    """乐咕乐股 index-basic-pe / index-basic-pb，token = hex(日期)，用 akshare 里的 JS 生成。"""
    from py_mini_racer import MiniRacer
    import akshare as ak
    import inspect as _inspect

    mod = _inspect.getmodule(ak.stock_index_pb_lg)
    js = MiniRacer()
    js.eval(mod.hash_code)
    token = js.call("hex", datetime.now().date().isoformat()).lower()
    SESSION.get("https://legulegu.com/stockdata/zz500-ttm-lyr", timeout=25)
    r = SESSION.get("https://legulegu.com/api/stockdata/" + kind,
                    params={"token": token, "indexCode": code}, timeout=40)
    r.raise_for_status()
    data = (r.json() or {}).get("data") or []
    if not data:
        raise RuntimeError("返回空数据")
    df = pd.DataFrame(data)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df.sort_values("date").drop_duplicates("date").reset_index(drop=True)


def fetch_csindex(code):
    """中证指数官网日线：收盘 + 滚动市盈率。"""
    import akshare as ak
    df = ak.stock_zh_index_hist_csindex(symbol=code, start_date="20040101", end_date="20991231")
    out = pd.DataFrame({
        "date": pd.to_datetime(df["日期"]),
        "close": pd.to_numeric(df["收盘"], errors="coerce"),
    })
    if "滚动市盈率" in df.columns:
        out["pe"] = pd.to_numeric(df["滚动市盈率"], errors="coerce")
    return out.dropna(subset=["close"]).sort_values("date").reset_index(drop=True)


def fetch_csindex_value(code):
    """中证指数官网估值（只给最近 20 个交易日）：市盈率1/股息率1 等。"""
    import akshare as ak
    df = ak.stock_zh_index_value_csindex(symbol=code)
    out = pd.DataFrame({
        "date": pd.to_datetime(df["日期"]),
        "pe1": pd.to_numeric(df["市盈率1"], errors="coerce"),
        "pe2": pd.to_numeric(df["市盈率2"], errors="coerce"),
        "dy1": pd.to_numeric(df["股息率1"], errors="coerce"),
        "dy2": pd.to_numeric(df["股息率2"], errors="coerce"),
    })
    return out.sort_values("date").reset_index(drop=True)


def fetch_y10():
    import akshare as ak
    df = ak.bond_zh_us_rate(start_date="20050101")
    out = pd.DataFrame({
        "date": pd.to_datetime(df["日期"]),
        "y10": pd.to_numeric(df["中国国债收益率10年"], errors="coerce"),
    })
    return out.dropna().sort_values("date").reset_index(drop=True)


def fetch_em_index(symbol):
    import akshare as ak
    df = ak.stock_zh_index_daily_em(symbol=symbol)
    out = pd.DataFrame({
        "date": pd.to_datetime(df["date"]),
        "close": pd.to_numeric(df["close"], errors="coerce"),
    })
    return out.dropna().sort_values("date").reset_index(drop=True)

# ---------------------------------------------------------------- 计算
def detect_troughs(close_series):
    """月度序列上找大底：回撤 >= 20% 的局部最低点，且之后 18 个月内反弹 >= 10% 才算确认。"""
    idx = close_series.index
    vals = close_series.values.astype(float)
    s = pd.Series(vals, index=idx)
    roll = s.rolling("1095D", min_periods=20).max()
    dd = s / roll - 1.0
    cand = []
    W = 12
    for i in range(len(vals)):
        lo, hi = max(0, i - W), min(len(vals), i + W + 1)
        if dd.iloc[i] <= -PARAMS["trough_dd"] and vals[i] == np.nanmin(vals[lo:hi]):
            cand.append(i)
    merged = []
    for i in cand:
        if merged and (idx[i] - idx[merged[-1]]).days < 300:
            if vals[i] < vals[merged[-1]]:
                merged[-1] = i
        else:
            merged.append(i)
    out = []
    for i in merged:
        fwd = vals[i + 1:i + 19]
        confirmed = bool(len(fwd) and np.nanmax(fwd) >= vals[i] * (1 + PARAMS["trough_rebound"]))
        out.append({"i": int(i), "confirmed": confirmed})
    return out


def zone_of(v, buy, deep, deep2, sell):
    if v >= sell:
        return "clear"
    if v > buy:
        return "wait"
    if v > deep:
        return "tier1"
    if v > deep2:
        return "tier2"
    return "tier3"


def replay(m, buy, deep, deep2, sell):
    """按月机械执行：进哪一档买一份，档内每再跌 10% 追加一份，最多 7 份；上穿清仓线一次性清掉。"""
    trades, mark_buys, mark_sells = [], [], []
    cur = None
    for _, row in m.iterrows():
        d = row["date"]
        c = float(row["close"])
        v = float(row["val"])
        if v >= sell:
            if cur is not None:
                avg = cur["cost"] / cur["units"]
                trades.append({
                    "entry": str(cur["entry"].date()),
                    "exit": str(d.date()),
                    "months": rnd((d - cur["entry"]).days / 30.44, 1),
                    "units": int(cur["units"]),
                    "entry_price": rnd(cur["entry_price"], 1),
                    "exit_price": rnd(c, 1),
                    "avg_price": rnd(avg, 1),
                    "ret": rnd((c / avg - 1) * 100, 2),
                })
                mark_sells.append([str(d.date()), rnd(c, 1)])
                cur = None
            continue
        if v > buy:
            continue
        tier = 3 if v <= deep2 else (2 if v <= deep else 1)
        if cur is None:
            cur = {"entry": d, "entry_price": c, "cost": 0.0, "units": 0, "tier": 0, "last": c}
        add = 0
        if tier > cur["tier"]:
            add = tier - cur["tier"]
            cur["tier"] = tier
        elif c <= cur["last"] * 0.90:
            add = 1
        if add and cur["units"] < 7:
            add = min(add, 7 - cur["units"])
            cur["cost"] += c * add
            cur["units"] += add
            cur["last"] = c
            mark_buys.append([str(d.date()), rnd(c, 1)])
    open_pos = None
    if cur is not None:
        avg = cur["cost"] / cur["units"]
        last = m.iloc[-1]
        open_pos = {
            "entry": str(cur["entry"].date()),
            "entry_price": rnd(cur["entry_price"], 1),
            "units": int(cur["units"]),
            "avg": rnd(avg, 1),
            "floating": rnd((float(last["close"]) / avg - 1) * 100, 2),
        }
    return trades, mark_buys, mark_sells, open_pos

def monthly_frame(df, val_col):
    m = pd.DataFrame({
        "date": pd.to_datetime(df["date"]),
        "close": pd.to_numeric(df["close"], errors="coerce"),
        "val": pd.to_numeric(df[val_col], errors="coerce"),
    })
    m = m.dropna(subset=["close", "val"])
    m = m[m["close"] > 0].sort_values("date").drop_duplicates("date").reset_index(drop=True)
    return m


def weekly_frames(daily, m):
    """把“月度估值”摊到每一周。

    做法：先算每个月的隐含每股盈利 EPS = 点位 / 估值；相邻两个月之间做对数线性插值
    （公司盈利是平滑变化的，不会在月末跳一下），于是每周都有平滑的 EPS，
    四条线 = 各档估值 x EPS，自然就是光滑的曲线。
    """
    d = daily[["date", "close"]].dropna().set_index("date").sort_index()
    d = d[~d.index.duplicated(keep="last")]
    w = d.resample("W-FRI").last().dropna()
    imp = pd.Series(m["close"].values.astype(float) / m["val"].values.astype(float),
                    index=pd.DatetimeIndex(m["date"])).sort_index()
    imp = imp[~imp.index.duplicated(keep="last")]
    imp = imp[np.isfinite(imp) & (imp > 0)]
    if not len(imp):
        raise RuntimeError("估值序列为空，无法推算每股盈利")
    grid = pd.date_range(imp.index.min(), max(imp.index.max(), w.index.max()), freq="D")
    log_imp = np.log(imp)
    log_imp = log_imp.reindex(log_imp.index.union(grid)).interpolate(method="time")
    imp_w = np.exp(log_imp.reindex(grid)).reindex(w.index, method="ffill")
    val_w = w["close"] / imp_w
    keep = imp_w.notna() & w["close"].notna() & np.isfinite(val_w)
    return w[keep], val_w[keep], imp_w[keep]


def build_index_block(name, code, unit, val_label, m, daily, buy_factor, sell_fixed, sell_quantile, extra=None):
    m = m.sort_values("date").reset_index(drop=True)
    clo = pd.Series(m["close"].values.astype(float), index=pd.DatetimeIndex(m["date"]))
    ser = pd.Series(m["val"].values.astype(float), index=pd.DatetimeIndex(m["date"]))

    tn = detect_troughs(clo)
    conf = [t for t in tn if t["confirmed"]] or tn
    tv = np.array([ser.iloc[t["i"]] for t in conf], dtype=float)
    median = float(np.median(tv)) if len(tv) else float(np.nanmedian(ser.values))

    buy_val = median * buy_factor
    deep_val = median
    deep2_val = median * 0.90
    if sell_fixed:
        sell_val = float(sell_fixed)
        sell_note = "原文参数 PE>%.2f" % sell_val
    else:
        sell_val = float(np.nanquantile(ser.values.astype(float), sell_quantile))
        sell_note = "历史 %.0f%% 分位" % (sell_quantile * 100)
    auto85 = float(np.nanquantile(ser.values.astype(float), 0.85))
    auto75 = float(np.nanquantile(ser.values.astype(float), 0.75))

    cur_val = float(ser.iloc[-1])
    cur_close = float(clo.iloc[-1])
    last_date = m["date"].iloc[-1]
    pct = float((ser.values <= cur_val).mean()) * 100

    w, vw, iw = weekly_frames(daily, m)
    dates, clos, vals = [], [], []
    lines = {"buy": [], "deep": [], "deep2": [], "sell": []}
    for dt, c, v, imp in zip(w.index, w["close"].values, vw.values, iw.values):
        if not np.isfinite(c) or not np.isfinite(v) or v <= 0 or not np.isfinite(imp):
            continue
        dates.append(str(dt.date()))
        clos.append(round(float(c), 1))
        vals.append(round(float(v), 2))
        for k, lv in (("buy", buy_val), ("deep", deep_val), ("deep2", deep2_val), ("sell", sell_val)):
            lines[k].append(round(float(imp) * lv, 1))

    trades, mark_buys, mark_sells, open_pos = replay(m, buy_val, deep_val, deep2_val, sell_val)

    troughs = []
    for t in tn:
        i = t["i"]
        troughs.append({
            "date": str(m["date"].iloc[i].date()),
            "close": rnd(m["close"].iloc[i], 1),
            "val": rnd(ser.iloc[i], 2),
            "confirmed": t["confirmed"],
            "used": t["confirmed"] or len(conf) == len(tn),
        })

    block = {
        "name": name,
        "code": code,
        "unit": unit,
        "val_label": val_label,
        "now": {
            "date": str(last_date.date()),
            "close": rnd(cur_close, 1),
            "val": rnd(cur_val, 2),
            "val_pct": rnd(pct, 1),
            "buy_val": rnd(buy_val, 2),
            "deep_val": rnd(deep_val, 2),
            "deep2_val": rnd(deep2_val, 2),
            "sell_val": rnd(sell_val, 2),
            "sell_note": sell_note,
            "buy_pts": rnd(cur_close * buy_val / cur_val, 0),
            "deep_pts": rnd(cur_close * deep_val / cur_val, 0),
            "deep2_pts": rnd(cur_close * deep2_val / cur_val, 0),
            "sell_pts": rnd(cur_close * sell_val / cur_val, 0),
            "to_buy_pct": rnd((buy_val / cur_val - 1) * 100, 1),
            "to_sell_pct": rnd((sell_val / cur_val - 1) * 100, 1),
            "zone": zone_of(cur_val, buy_val, deep_val, deep2_val, sell_val),
            "median_trough_val": rnd(median, 2),
            "auto85": rnd(auto85, 2),
            "auto75": rnd(auto75, 2),
        },
        "sample": {
            "start": str(m["date"].iloc[0].date()),
            "end": str(last_date.date()),
            "n": int(ser.notna().sum()),
        },
        "series": {"dates": dates, "close": clos, "val": vals, "lines": lines},
        "troughs": troughs,
        "trades": trades,
        "open_position": open_pos,
        "markers": {"buys": mark_buys, "sells": mark_sells},
    }
    block["labels"] = []
    for t in trades:
        block["labels"].append({"date": t["entry"], "price": t["entry_price"],
                               "text": "买×%d" % t["units"], "kind": "buy"})
        block["labels"].append({"date": t["exit"], "price": t["exit_price"],
                               "text": "卖", "kind": "sell"})
    if open_pos:
        block["labels"].append({"date": open_pos["entry"], "price": open_pos["entry_price"],
                               "text": "买×%d" % open_pos["units"], "kind": "buy", "open": True})
    if extra:
        block.update(extra)
    return block


def build_hs300():
    pe = cached_fetch("hs300_pe_monthly",
                      lambda: fetch_legulegu("index-basic-pe", "000300.SH"))
    daily = cached_fetch("hs300_daily", lambda: fetch_csindex("000300"))
    m = monthly_frame(pe, "addTtmPe")
    return build_index_block("沪深300", "000300", "PE", "加权滚动市盈率（TTM）",
                             m, daily, PARAMS["hs300_buy_factor"],
                             PARAMS["hs300_sell_val"], None)


def build_cyb():
    pb = cached_fetch("cyb_pb_monthly",
                      lambda: fetch_legulegu("index-basic-pb", "399006.SZ"))
    daily = cached_fetch("cyb_daily", lambda: fetch_em_index("sz399006"))
    m = monthly_frame(pb, "addPb")
    return build_index_block("创业板指", "399006", "PB", "加权市净率（PB）",
                             m, daily, PARAMS["cyb_buy_factor"],
                             None, PARAMS["cyb_sell_quantile"])


def build_vs_bond():
    """沪深300全收益 vs 中证全债：全收益跌破债券曲线的时候，就是极端便宜。"""
    tri = cached_fetch("hs300_totalreturn", lambda: fetch_csindex("H00300"))
    bond = cached_fetch("bond_csi", lambda: fetch_csindex("H11001"))
    a = tri[["date", "close"]].dropna().set_index("date").sort_index()
    b = bond[["date", "close"]].dropna().set_index("date").sort_index()
    df = pd.DataFrame({"tri": a["close"], "bond": b["close"]}).dropna()
    df = df[df.index >= pd.Timestamp("2011-01-01")]
    w = df.resample("W-FRI").last().dropna()
    ratio = df["tri"] / df["bond"]

    def rebased(col):
        base = w[col].iloc[0]
        return [round(float(x / base) * 100, 2) for x in w[col].values]

    return {
        "name": "沪深300全收益 vs 中证全债",
        "series": {
            "dates": [str(d.date()) for d in w.index],
            "tri": rebased("tri"),
            "bond": rebased("bond"),
        },
        "now": {
            "date": str(df.index[-1].date()),
            "tri": rnd(float(df["tri"].iloc[-1]), 2),
            "bond": rnd(float(df["bond"].iloc[-1]), 2),
            "ratio": rnd(float(ratio.iloc[-1]), 4),
            "ratio_pct": rnd(float((ratio <= ratio.iloc[-1]).mean()) * 100, 1),
        },
    }


def build_spread():
    """股债性价比 = 盈利收益率(100/PE) - 十年国债收益率。"""
    pe = cached_fetch("hs300_pe_monthly",
                      lambda: fetch_legulegu("index-basic-pe", "000300.SH"))
    daily = cached_fetch("hs300_daily", lambda: fetch_csindex("000300"))
    y10 = cached_fetch("bond_y10", fetch_y10)
    m = monthly_frame(pe, "addTtmPe")
    d = daily[["date", "close"]].dropna().set_index("date").sort_index()
    val = pd.Series(m["val"].values.astype(float), index=pd.DatetimeIndex(m["date"])).sort_index()
    pe_d = val.reindex(d.index, method="ffill")
    y = y10.set_index("date")["y10"].sort_index()
    y_d = y.reindex(d.index, method="ffill")
    df = pd.DataFrame({"pe": pe_d, "y10": y_d}).dropna()
    df = df[(df["y10"] > 0) & (df["pe"] > 0)]
    df["spread"] = 100.0 / df["pe"] - df["y10"]
    w = df.resample("W-FRI").last().dropna()
    cur = float(df["spread"].iloc[-1])
    return {
        "name": "股债性价比",
        "series": {
            "dates": [str(x.date()) for x in w.index],
            "spread": [round(float(x), 2) for x in w["spread"].values],
            "y10": [round(float(x), 2) for x in w["y10"].values],
        },
        "now": {
            "date": str(df.index[-1].date()),
            "spread": rnd(cur, 2),
            "pe": rnd(float(df["pe"].iloc[-1]), 2),
            "y10": rnd(float(df["y10"].iloc[-1]), 2),
            "pct": rnd(float((df["spread"] <= cur).mean()) * 100, 1),
        },
    }


def build_dividend():
    dfv = cached_fetch("hldb_value", lambda: fetch_csindex_value("H30269"), max_age_hours=20)
    dfv = dfv.sort_values("date")
    cur = float(dfv["dy1"].iloc[-1])
    thr = float(PARAMS["dividend_threshold"])
    return {
        "name": "中证红利低波",
        "code": "H30269",
        "yield": rnd(cur, 2),
        "threshold": thr,
        "gap": rnd(cur - thr, 2),
        "ok": bool(cur >= thr),
        "as_of": str(dfv["date"].iloc[-1].date()),
        "pe": rnd(float(dfv["pe1"].iloc[-1]), 2),
        "series": {
            "dates": [str(x.date()) for x in dfv["date"]],
            "dy": [round(float(x), 2) for x in dfv["dy1"].values],
        },
    }


def build_payload(trigger="manual", force=False):
    global FORCE
    FORCE = bool(force)
    t0 = time.time()
    WARNINGS.clear()
    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "trigger": trigger,
        "params": PARAMS,
        "source": {
            "index": "中证指数有限公司（官方日线/估值）",
            "valuation": "乐咕乐股 legulegu.com（加权滚动 PE / 加权 PB）",
            "yield10": "中国十年期国债到期收益率（经 akshare）",
        },
    }
    try:
        hs = build_hs300()
        payload["hs300"] = hs
        payload["as_of"] = hs["now"]["date"]
    except Exception:
        warn("沪深300 计算失败：" + traceback.format_exc(limit=1).replace("\n", " ")[:180])
    try:
        payload["cyb"] = build_cyb()
        payload.setdefault("as_of", payload["cyb"]["now"]["date"])
    except Exception:
        warn("创业板指 计算失败：" + traceback.format_exc(limit=1).replace("\n", " ")[:180])
    for key, fn in (("vs_bond", build_vs_bond),
                    ("spread", build_spread),
                    ("dividend", build_dividend)):
        try:
            payload[key] = fn()
        except Exception:
            warn("%s 计算失败：%s" % (key, traceback.format_exc(limit=1).replace("\n", " ")[:160]))
    payload["warnings"] = list(WARNINGS)
    payload["elapsed_ms"] = int((time.time() - t0) * 1000)
    return payload

# ---------------------------------------------------------------- 服务
PAYLOAD = None
REFRESH_LOCK = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def load_cache():
    global PAYLOAD
    if PAYLOAD is not None:
        return PAYLOAD
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as fh:
                PAYLOAD = json.load(fh)
            print("[cache] 已载入 %s（%s）" % (CACHE_FILE, PAYLOAD.get("generated_at")))
        except Exception as exc:
            print("[cache] 读取失败：", exc)
            PAYLOAD = None
    return PAYLOAD


def save_cache(payload):
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, CACHE_FILE)


class Handler(BaseHTTPRequestHandler):
    server_version = "ValuationDesk/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("  %s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _static(self, rel):
        rel = rel.lstrip("/")
        if rel == "":
            rel = "index.html"
        path = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(os.path.abspath(STATIC_DIR)):
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        if not os.path.isfile(path):
            return self._send(404, "not found: " + rel, "text/plain; charset=utf-8")
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as fh:
            self._send(200, fh.read(), CONTENT_TYPES.get(ext, "application/octet-stream"))

    def _refresh(self, trigger, force=False):
        global PAYLOAD
        if not REFRESH_LOCK.acquire(blocking=False):
            return self._json({"ok": False, "busy": True,
                               "message": "上一轮抓取还没结束，再等几秒"}, 409)
        try:
            print("[refresh] 开始抓取 …%s" % ("（强制重抓）" if force else ""))
            payload = build_payload(trigger, force=force)
            if "hs300" not in payload and "cyb" not in payload:
                cached = load_cache()
                if cached:
                    payload = cached
                    payload["warnings"] = payload.get("warnings", []) + ["本次抓取全部失败，显示的是上次结果"]
                    payload["stale"] = True
            else:
                PAYLOAD = payload
                save_cache(payload)
            print("[refresh] 完成 %.1fs" % (payload.get("elapsed_ms", 0) / 1000))
            return self._json(payload)
        except Exception:
            msg = traceback.format_exc()
            print(msg)
            return self._json({"ok": False, "message": msg[-400:]}, 500)
        finally:
            REFRESH_LOCK.release()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path == "/api/data":
            cached = load_cache()
            if cached is None:
                return self._refresh("first-load")
            return self._json(cached)
        if path == "/api/refresh":
            q = parse_qs(urlparse(self.path).query)
            return self._refresh("button", force=q.get("force", ["0"])[0] == "1")
        if path == "/api/health":
            return self._json({"ok": True, "generated_at": (PAYLOAD or {}).get("generated_at")})
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        return self._static(path[1:])

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/refresh":
            q = parse_qs(urlparse(self.path).query)
            return self._refresh("button", force=q.get("force", ["0"])[0] == "1")
        return self._json({"ok": False, "message": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    load_cache()
    port = args.port
    httpd = None
    for p in range(port, port + 12):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        print("端口全被占用，退出")
        return
    url = "http://127.0.0.1:%d/" % port
    print("=" * 58)
    print("  估值决策台已启动 ->  " + url)
    print("  关掉这个黑窗口就停止服务（页面会打不开）")
    print("=" * 58)
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()