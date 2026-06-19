#!/usr/bin/env python3
"""raw_all.json を読み、数値条件＋ラーメン店判定＋行政界(点包含)で src/data/shops.json を生成する。
- 残すのは「江東区・江戸川区・千葉県」のいずれかに含まれる店のみ（浅草=台東区/日本橋=中央区/墨田/葛飾 等を除外）
- 各店に region（tokyo / 千葉サブエリア）を付与
- mapsUrl は検証済みの ftid 形式（正確な店舗ページ＋口コミ着地）"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw_all.json")
OUT = os.path.join(HERE, "..", "src", "data", "shops.json")
BOUND = os.path.join(HERE, "boundaries.json")

GENRE_OK = ["ラーメン", "らーめん", "らぁめん", "ラー麺", "拉麺", "つけ麺", "つけめん", "中華そば", "麺"]
NAME_OK = ["ラーメン", "らーめん", "らぁめん", "ら〜めん", "ら～めん", "ラー麺", "拉麺", "中華そば",
           "中華蕎麦", "つけ麺", "つけめん", "油そば", "まぜそば", "家系", "二郎", "麺屋", "麺場",
           "麺処", "製麺", "らあめん", "担々麺", "担担麺", "タンメン", "ちゃんぽん"]


def is_ramen(s):
    g = s.get("g") or ""
    n = s.get("n") or ""
    return any(k in g for k in GENRE_OK) or any(k in n for k in NAME_OK)


def point_in_ring(x, y, ring):
    """ray casting。ring=[[lng,lat],...]"""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def point_in_geom(x, y, geom):
    """geom: Polygon or MultiPolygon。外環内かつ穴の外なら True"""
    t = geom["type"]
    polys = geom["coordinates"] if t == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if not poly:
            continue
        if point_in_ring(x, y, poly[0]):
            in_hole = any(point_in_ring(x, y, poly[k]) for k in range(1, len(poly)))
            if not in_hole:
                return True
    return False


def bbox(geom):
    xs, ys = [], []
    t = geom["type"]
    polys = geom["coordinates"] if t == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            for pt in ring:
                xs.append(pt[0]); ys.append(pt[1])
    return min(xs), min(ys), max(xs), max(ys)


def chiba_region(lat, lng):
    if lat <= 35.45:
        return "boso"
    if lng >= 140.3:
        return "tosou"
    if lat >= 35.72:
        return "inba" if lng >= 140.1 else "toukatsu"
    if lat >= 35.6 and lng < 140.08:
        return "keiyo"
    if lat >= 35.68 and lng >= 140.1:
        return "inba"
    return "chiba"


def main():
    raw = json.load(open(RAW))
    bd = json.load(open(BOUND))
    geoms = {k: (bd[k], bbox(bd[k])) for k in bd}

    def in_named(lat, lng, name):
        g, (minx, miny, maxx, maxy) = geoms[name]
        if not (minx <= lng <= maxx and miny <= lat <= maxy):
            return False
        return point_in_geom(lng, lat, g)

    base = [s for s in raw
            if s.get("lat") and s.get("lng")
            and s.get("r") is not None and s.get("c") is not None
            and s["r"] >= 3.9 and s["c"] >= 50 and is_ramen(s)]

    kept, dropped = [], 0
    for s in base:
        lat, lng = s["lat"], s["lng"]
        if in_named(lat, lng, "江東区") or in_named(lat, lng, "江戸川区"):
            region = "tokyo"
        elif in_named(lat, lng, "千葉県"):
            region = chiba_region(lat, lng)
        else:
            dropped += 1
            continue
        pid = s.get("pid")
        url = (f'https://www.google.com/maps?ftid={pid}&hl=ja' if pid
               else f'https://www.google.com/maps/search/?api=1&query={lat},{lng}')
        kept.append({"name": s["n"], "rating": s["r"], "reviews": s["c"],
                     "lat": lat, "lng": lng, "genre": s.get("g") or "ラーメン",
                     "address": s.get("a") or "", "placeId": pid,
                     "mapsUrl": url, "region": region})

    kept.sort(key=lambda x: (-x["rating"], -x["reviews"]))
    json.dump(kept, open(OUT, "w"), ensure_ascii=False, indent=1)

    from collections import Counter
    rc = Counter(s["region"] for s in kept)
    print(f"ラーメン数値条件 {len(base)} → 行政界フィルタで残り {len(kept)} 件 / 区界外で除外 {dropped} 件")
    print("region分布:", dict(rc))


if __name__ == "__main__":
    main()
