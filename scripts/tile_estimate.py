#!/usr/bin/env python3
"""千葉県全域をタイルキャッシュした場合の枚数・容量を見積もる。
bbox実数 と ポリゴンクリップ(boundaries.jsonの千葉県MultiPolygon) の両方で算出。"""
import json, math

d = json.load(open('scripts/boundaries.json'))
geom = d['千葉県']
polys = geom['coordinates']  # MultiPolygon: [ [ring,[holes...]], ... ]

# --- bbox を実データから ---
lats, lngs = [], []
for poly in polys:
    for ring in poly:
        for lng, lat in ring:
            lngs.append(lng); lats.append(lat)
W, E = min(lngs), max(lngs)
S, N = min(lats), max(lats)
print(f"千葉県 bbox: lat {S:.3f}–{N:.3f}  lng {W:.3f}–{E:.3f}")
print(f"  Δlat {N-S:.3f}° Δlng {E-W:.3f}°")

def x_of(lng, z): return (lng + 180.0) / 360.0 * (2**z)
def y_of(lat, z):
    r = math.radians(lat)
    return (1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * (2**z)

def bbox_tiles(z):
    x0, x1 = int(x_of(W, z)), int(x_of(E, z))
    y0, y1 = int(y_of(N, z)), int(y_of(S, z))  # y increases southward
    return (x1 - x0 + 1) * (y1 - y0 + 1)

# --- ポリゴン内判定 (ray casting), タイル中心で ---
def point_in_multipoly(lng, lat):
    for poly in polys:
        ring = poly[0]  # outer ring (holes無視: 千葉に内陸湖の穴はほぼ無し)
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]; xj, yj = ring[j]
            if ((yi > lat) != (yj > lat)) and \
               (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        if inside: return True
    return False

def clipped_tiles(z):
    x0, x1 = int(x_of(W, z)), int(x_of(E, z))
    y0, y1 = int(y_of(N, z)), int(y_of(S, z))
    n = 2**z
    cnt = 0
    for ty in range(y0, y1 + 1):
        # タイル中心の緯度経度
        for tx in range(x0, x1 + 1):
            clng = (tx + 0.5) / n * 360.0 - 180.0
            ty_norm = (ty + 0.5) / n
            clat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty_norm))))
            if point_in_multipoly(clng, clat):
                cnt += 1
    return cnt

# クリップは重いので z14 まで実測、z15-17 は z14 の県/bbox比で外挿
frac = None
print("\n z |   bboxタイル |  千葉県内のみ |  bbox容量(22KB) | 県内容量(22KB)")
print("---+-------------+--------------+-----------------+----------------")
KB = 22 / 1024 / 1024  # MB per tile (avg land tile ~22KB)
cum_bbox = cum_clip = 0
rows = []
for z in range(6, 18):
    bt = bbox_tiles(z)
    if z <= 14:
        ct = clipped_tiles(z)
        frac = ct / bt
    else:
        ct = int(bt * frac)  # 外挿（県/bbox比はズーム不変）
    cum_bbox += bt; cum_clip += ct
    rows.append((z, bt, ct, cum_bbox, cum_clip))
    print(f"{z:2d} | {bt:11,} | {ct:12,} | {cum_bbox*22/1024:11.1f}MB | {cum_clip*22/1024:8.1f}MB")

print(f"\n県/bbox 面積比(タイル中心ベース) ≈ {frac:.2%}")
print("\n=== 累積（このズームまで全部キャッシュ）容量レンジ ===")
for z, bt, ct, cb, cc in rows:
    if z in (11, 12, 13, 14, 15, 16, 17):
        lo = cc * 15 / 1024
        mid = cc * 22 / 1024
        hi = cc * 30 / 1024
        unit = "MB"
        def fmt(v):
            return f"{v/1024:.2f}GB" if v >= 1024 else f"{v:.0f}MB"
        print(f"  z6–{z:2d} 県内 {cc:>10,}枚 : {fmt(lo)} 〜 {fmt(mid)} 〜 {fmt(hi)}  (15/22/30KB)")
