#!/usr/bin/env python3
"""OSM / GSI淡色 / GSI標準 のタイルを同一地点で並べて比較画像を作る。
night版(GSI淡色にinvert+hue-rotate180)も生成し、現状(OSM)→GSI移行時の見た目変化を確認する。"""
import math, io, sys
import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

# 佐倉市山王付近（ユーザー自宅周辺）
LAT, LNG = 35.7156, 140.2330
ZOOMS = [15, 16]
TILE = 256
GRID = 2  # 2x2 タイル = 512px のモザイク

SOURCES = [
    ("OSM (現在)", "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"),
    ("GSI 淡色",   "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"),
    ("GSI 標準",   "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"),
]
HEADERS = {"User-Agent": "chiba-ramen-map-tile-compare/1.0 (local dev compare)"}

def deg2tile(lat, lng, z):
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    return x, y

def fetch(url):
    r = requests.get(url, headers=HEADERS, timeout=(5, 20))
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGB")

def mosaic(url_tmpl, z):
    xf, yf = deg2tile(LAT, LNG, z)
    x0, y0 = int(xf) - GRID // 2, int(yf) - GRID // 2
    canvas = Image.new("RGB", (TILE * GRID, TILE * GRID), (230, 230, 230))
    for dx in range(GRID):
        for dy in range(GRID):
            url = url_tmpl.format(z=z, x=x0 + dx, y=y0 + dy)
            try:
                t = fetch(url)
            except Exception as e:
                print("  fail", url, e, file=sys.stderr)
                t = Image.new("RGB", (TILE, TILE), (235, 235, 235))
            canvas.paste(t, (dx * TILE, dy * TILE))
    return canvas

def night(img):
    """invert(1) hue-rotate(180deg) 相当 = 反転後に色相を戻す擬似ダーク。"""
    inv = ImageOps.invert(img)
    hsv = inv.convert("HSV")
    h, s, v = hsv.split()
    h = h.point(lambda p: (p + 128) % 256)  # hue +180deg
    return Image.merge("HSV", (h, s, v)).convert("RGB")

def font(sz):
    for p in ["/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/Library/Fonts/Arial Unicode.ttf"]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()

def label(img, text, sub=""):
    out = img.copy()
    d = ImageDraw.Draw(out)
    f = font(22); fs = font(15)
    d.rectangle([0, 0, out.width, 30], fill=(20, 20, 20))
    d.text((8, 4), text, fill=(255, 255, 255), font=f)
    if sub:
        d.rectangle([0, out.height - 24, out.width, out.height], fill=(20, 20, 20))
        d.text((8, out.height - 22), sub, fill=(200, 200, 200), font=fs)
    return out

cells = []  # (zoom-row) of labeled images
for z in ZOOMS:
    print("zoom", z)
    row = []
    for name, tmpl in SOURCES:
        m = mosaic(tmpl, z)
        row.append(label(m, name, f"z{z}"))
    # GSI淡色のダーク擬似
    pale = mosaic(SOURCES[1][1], z)
    row.append(label(night(pale), "GSI淡色 夜間", f"z{z} invert+hue180"))
    cells.append(row)

cols = len(cells[0])
cw, ch = cells[0][0].size
gap = 10
W = cols * cw + (cols + 1) * gap
H = len(cells) * ch + (len(cells) + 1) * gap + 34
out = Image.new("RGB", (W, H), (245, 245, 245))
d = ImageDraw.Draw(out)
d.text((gap, 8), "タイル比較：佐倉市山王周辺  /  OSM(現在) → GSI移行時の見た目", fill=(20, 20, 20), font=font(20))
for ri, row in enumerate(cells):
    for ci, img in enumerate(row):
        x = gap + ci * (cw + gap)
        y = 34 + gap + ri * (ch + gap)
        out.paste(img, (x, y))
dst = "/Users/okawa.yosuke/code/chiba-ramen-map/docs/tile-comparison.png"
out.save(dst)
print("saved", dst, out.size)
