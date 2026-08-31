import numpy as np
import pandas as pd


def compute_adx(high, low, close, window=14):
    plus_dm = np.diff(high, prepend=high[0])
    minus_dm = np.diff(low, prepend=low[0])
    plus_dm = np.where((plus_dm > minus_dm) & (plus_dm > 0), plus_dm, 0)
    minus_dm = np.where((minus_dm > plus_dm) & (minus_dm > 0), minus_dm, 0)

    tr1 = high - low
    tr2 = np.abs(high - np.insert(close, 0, close[0])[:-1])
    tr3 = np.abs(low - np.insert(close, 0, close[0])[:-1])
    tr = np.maximum(tr1, np.maximum(tr2, tr3))

    alpha = 1.0 / window
    smoothed_tr = np.zeros_like(tr)
    smoothed_plus = np.zeros_like(plus_dm)
    smoothed_minus = np.zeros_like(minus_dm)

    smoothed_tr[0] = np.sum(tr[:window])
    smoothed_plus[0] = np.sum(plus_dm[:window])
    smoothed_minus[0] = np.sum(minus_dm[:window])

    for i in range(1, len(tr)):
        smoothed_tr[i] = smoothed_tr[i-1] + alpha * (tr[i] - smoothed_tr[i-1])
        smoothed_plus[i] = smoothed_plus[i-1] + alpha * (plus_dm[i] - smoothed_plus[i-1])
        smoothed_minus[i] = smoothed_minus[i-1] + alpha * (minus_dm[i] - smoothed_minus[i-1])

    di_plus = 100 * smoothed_plus / np.where(smoothed_tr == 0, 1, smoothed_tr)
    di_minus = 100 * smoothed_minus / np.where(smoothed_tr == 0, 1, smoothed_tr)
    dx = 100 * np.abs(di_plus - di_minus) / np.where((di_plus + di_minus) == 0, 1, (di_plus + di_minus))

    adx = np.zeros_like(dx)
    adx[:window] = np.nan
    adx_val = np.mean(dx[:window])
    adx[window-1] = adx_val
    for i in range(window, len(dx)):
        adx[i] = (adx[i-1] * (window - 1) + dx[i]) / window

    return adx, di_plus, di_minus


def compute_atr(high, low, close, window=14):
    tr1 = high - low
    tr2 = np.abs(high - np.insert(close, 0, close[0])[:-1])
    tr3 = np.abs(low - np.insert(close, 0, close[0])[:-1])
    tr = np.maximum(tr1, np.maximum(tr2, tr3))

    atr = np.zeros_like(tr)
    atr[:window] = np.nan
    atr[window-1] = np.mean(tr[:window])
    for i in range(window, len(tr)):
        atr[i] = (atr[i-1] * (window - 1) + tr[i]) / window
    return atr


def efficiency_ratio(close, window=10):
    n = len(close)
    er = np.full(n, np.nan)
    if n < window:
        return er
    for i in range(window - 1, n):
        start = i - window + 1
        net = abs(close[i] - close[start])
        gross = np.sum(np.abs(np.diff(close[start:i+1])))
        er[i] = net / gross if gross > 0 else 0
    return er


def classify_regimes(high, low, close, adx_window=14, atr_window=14, er_window=10):
    adx, di_plus, di_minus = compute_adx(high, low, close, adx_window)
    atr = compute_atr(high, low, close, atr_window)
    er = efficiency_ratio(close, er_window)

    regimes = np.full(len(close), "UNKNOWN", dtype=object)

    for i in range(len(close)):
        if np.isnan(adx[i]) or np.isnan(atr[i]) or np.isnan(er[i]):
            regimes[i] = "UNKNOWN"
            continue

        # Volatility filter
        vol_percentile = 75
        atr_val = atr[i]
        atr_percentile = np.percentile(atr[~np.isnan(atr)], vol_percentile)
        high_vol = atr_val > atr_percentile

        # Regime classification
        if adx[i] >= 25 and di_plus[i] > di_minus[i]:
            regimes[i] = "TREND_UP"
        elif adx[i] >= 25 and di_minus[i] >= di_plus[i]:
            regimes[i] = "TREND_DOWN"
        elif adx[i] < 20 and er[i] < 0.15:
            regimes[i] = "RANGE"
        elif high_vol and adx[i] >= 20:
            regimes[i] = "VOLATILE"
        else:
            regimes[i] = "RANGE"

    return regimes, adx, di_plus, di_minus, atr, er


def regime_stats(regimes):
    unique, counts = np.unique(regimes, return_counts=True)
    return dict(zip(unique.tolist(), counts.tolist()))
