#!/usr/bin/env python3
"""用 Panda Data 核对游戏数据的最后一项待核内容（在用户自己的终端运行）。

核对三件事：
  1. 2004 腾讯控股（0700.HK）：发行价 3.70 港元 → 2021-01-25 收盘，
     经拆股与分红调整的最高倍数（游戏文案写「涨超 1000 倍」，m=1046）
  2. 盲盒窗口：上证50（000016.SH）2004-07-21 ~ 2004-10-12，55 根日线
  3. 盲盒窗口：中证500（000905.SH）2008-03-26 ~ 2008-06-16，55 根日线

用法（在仓库根目录）：
    python3 tools/verify_panda.py
凭证来源：环境变量 PANDA_USER / PANDA_PASS，没有则 getpass 交互输入。
密码不写入任何文件、不出现在命令参数里。
"""
import os
import re
import sys
import json
import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def init():
    import panda_data
    user = os.environ.get("PANDA_USER", "")
    pwd = os.environ.get("PANDA_PASS", "")
    if not user:
        user = input("PandaAI 手机号（直接输 11 位，脚本自动加 86 前缀）: ").strip()
    if not user.startswith("86"):
        user = "86" + user
    if not pwd:
        pwd = getpass.getpass("PandaAI 官网密码: ")
    token = panda_data.init_token(username=user, password=pwd)
    print(f"登录 OK，token 有效期 {panda_data.get_token_ttl()}")
    return panda_data


def load_pool_windows():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    pool = json.loads(re.search(r"var POOL = (\[.*?\]);", src, re.S).group(1))
    return [w for w in pool if w.get("decDate", "")[:4] in ("2004", "2008")]


def fetch_hk_daily(pd, sym="0700.HK"):
    """分段拉腾讯日线（单次 ≤5 年），返回 {YYYYMMDD: row_dict}。"""
    segs = [(20040616, 20090615), (20090616, 20140615), (20140616, 20190615),
            (20190616, 20210205)]
    rows = {}
    for a, b in segs:
        df = pd.get_hk_daily(symbol=[sym], start_date=str(a), end_date=str(b))
        for _, r in df.iterrows():
            rows[str(r.get("date") or r.get("trade_date"))] = dict(r)
    return rows


def fetch_hk_adj(pd, sym="0700.HK"):
    """尝试拉复权因子；接口失败或返回空则返回 {}。"""
    try:
        df = pd.get_adj_factor_hk(symbol=[sym], start_date="20040616", end_date="20210205")
        if df is None or len(df) == 0:
            return {}
        return {str(r.get("date") or r.get("trade_date")): dict(r) for _, r in df.iterrows()}
    except Exception as e:
        print(f"  （复权因子接口不可用：{e}）")
        return {}


def col(row, *names):
    for n in names:
        if n in row and row[n] is not None:
            return float(row[n])
    return None


def verify_tencent(pd):
    print("\n== 1. 腾讯 0700.HK ==")
    rows = fetch_hk_daily(pd)
    if not rows:
        print("  ✗ 未拉到日线数据")
        return
    print(f"  日线 {len(rows)} 根，字段示例: {sorted(next(iter(rows.values())).keys())}")
    d1, dp = "20040616", "20210125"
    if d1 not in rows or dp not in rows:
        print(f"  ✗ 缺关键日期：首日 {d1 in rows}，2021-01-25 {dp in rows}")
        return
    c1, cp = col(rows[d1], "close", "close_price"), col(rows[dp], "close", "close_price")
    print(f"  首日收盘 {c1}（公开报道 4.025 港元）| 2021-01-25 收盘 {cp}")
    adj = fetch_hk_adj(pd)
    if adj:
        a1 = col(adj[d1], "adj_factor", "factor", "adj")
        ap = col(adj[dp], "adj_factor", "factor", "adj")
        if a1 and ap and c1:
            m = (cp * ap) / (3.70 * a1)
            print(f"  复权因子 2004-06-16={a1}, 2021-01-25={ap}")
            print(f"  ★ 发行价3.70 → 2021-01-25（分红+拆股调整）= {m:.0f} 倍  （游戏用 1046）")
            return
    # 没有复权因子时：只给参考比值，不下结论
    if c1 and cp:
        print(f"  参考：2021-01-25 收盘 / 首日收盘 = {cp / c1:.0f} 倍（口径未含分红，自发行价需再乘 首日收盘/3.70）")
        print("  （未拿到复权因子，正式核对需复权因子）")


def verify_window(pd, w):
    sym = "000016.SH" if "000016" in w["sym"] else "000905.SH"
    days = [b[0] for b in w["vis"]]
    print(f"\n== 盲盒窗口 {w['name']} {sym} {days[0]}~{days[-1]} ==")
    df = pd.get_index_daily(symbol=[sym], start_date=days[0], end_date=days[-1])
    got = {}
    for _, r in df.iterrows():
        d = str(r.get("date") or r.get("trade_date"))
        c = r.get("close", r.get("close_price"))
        if c is not None:
            got[d] = float(c)
    bad = miss = 0
    for bar in w["vis"]:
        day, c = bar[0], float(bar[4])
        if day not in got:
            miss += 1
            continue
        if abs(got[day] - c) > 0.051:
            bad += 1
            print(f"  不符: {day} 游戏 {c} vs Panda {got[day]}")
    print(f"  K线 {len(w['vis'])} | 缺日 {miss} | 收盘不符 {bad} → {'✓ 一致' if bad == 0 and miss == 0 else '✗ 需人工看'}")


def main():
    pd = init()
    verify_tencent(pd)
    for w in load_pool_windows():
        verify_window(pd, w)
    print("\n完成。把以上全部输出贴回给助手即可。")


if __name__ == "__main__":
    sys.exit(main())
