// 高速道路（motorway/motorway_link）のセンターライン形状を OSM(Overpass) から収集し
// public/highways-geom.json に同梱。現在地を線にスナップして「高速上か＋どの高速か」を位置判定する用。
// 関東全域をカバー（範囲が広くOverpass単発は弾かれやすいのでタイル分割収集＋way IDで重複除去）。
// 容量対策: Douglas-Peucker 簡略化（ε≈13m）＋座標5桁丸め。データ元 OpenStreetMap (ODbL)。
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 関東全域＋接続する高速（東名・中央道は神奈川西/山梨手前まで、東北/常磐/関越は北関東まで）。
// (south, west, north, east)
// 全国化(地方ブロック生成)用に env で上書き可: HW_BBOX="s,w,n,e" / HW_TILE / HW_GEOM_FILE(出力先)。
// 未指定なら従来どおり関東bbox＋public/highways-geom.json（build-region.mjs から地域別に呼ばれる）。
const BBOX = process.env.HW_BBOX
  ? process.env.HW_BBOX.split(",").map(Number)
  : [34.85, 138.4, 37.25, 141.0];
const TILE = Number(process.env.HW_TILE || 0.5); // タイル一辺(度)。小さいほどOverpassに優しいがクエリ数増
const OUT_URL = process.env.HW_GEOM_FILE
  ? pathToFileURL(resolve(process.env.HW_GEOM_FILE))
  : new URL("../public/highways-geom.json", import.meta.url);
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1タイル分のways（motorway/motorway_link）を取得。全ミラー失敗時は数回バックオフ再試行。
async function fetchTile(s, w, n, e) {
  const ql = `[out:json][timeout:120];
(
  way["highway"="motorway"](${s},${w},${n},${e});
  way["highway"="motorway_link"](${s},${w},${n},${e});
);
out geom tags;`;
  for (let round = 0; round < 3; round++) {
    for (const url of MIRRORS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(ql),
        });
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j.elements)) return j.elements;
      } catch {
        /* 次のミラー */
      }
    }
    await sleep(5000 * (round + 1));
  }
  throw new Error(`tile ${s},${w} all mirrors failed`);
}

// Douglas-Peucker（ε は度。約13m≒0.00012）
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0,
    idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const latScale = Math.cos((ax * Math.PI) / 180);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const dx = (bx - ax) * latScale;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let d;
    if (len2 === 0) d = Math.hypot((px - ax) * latScale, py - ay);
    else {
      let t = (((px - ax) * latScale) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      d = Math.hypot((px - (ax + (t * dx) / latScale)) * latScale, py - (ay + t * dy));
    }
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

// タイルを巡回し、wayをidで重複除去して集める
const byId = new Map();
let tiles = 0;
for (let s = BBOX[0]; s < BBOX[2]; s += TILE) {
  for (let w = BBOX[1]; w < BBOX[3]; w += TILE) {
    const n = Math.min(s + TILE, BBOX[2]);
    const e = Math.min(w + TILE, BBOX[3]);
    tiles++;
    process.stdout.write(`tile ${tiles} (${s.toFixed(1)},${w.toFixed(1)}) ... `);
    const els = await fetchTile(s, w, n, e);
    let added = 0;
    for (const el of els) {
      if (el.type !== "way" || byId.has(el.id)) continue;
      byId.set(el.id, el);
      added++;
    }
    console.log(`+${added} (計${byId.size})`);
    await sleep(1200); // ミラーに優しく
  }
}

const EPS = 0.00012;
const roads = [];
let rawPts = 0,
  keptPts = 0;
for (const el of byId.values()) {
  if (!Array.isArray(el.geometry) || el.geometry.length < 2) continue;
  const t = el.tags || {};
  let pts = el.geometry.map((g) => [g.lat, g.lon]);
  rawPts += pts.length;
  pts = rdp(pts, EPS).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
  keptPts += pts.length;
  roads.push({ ref: (t.ref || "").trim(), name: (t.name || "").trim(), c: pts });
}
console.log(`簡略化: ${rawPts} → ${keptPts} 点（${roads.length} 本 / ${tiles} タイル）`);

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  bbox: BBOX,
  source: "© OpenStreetMap contributors (ODbL)",
  roads,
};
const json = JSON.stringify(payload);
writeFileSync(OUT_URL, json);
const gz = gzipSync(Buffer.from(json));
console.log(
  `saved ${OUT_URL.pathname}  raw=${(json.length / 1024).toFixed(0)}KB gzip=${(gz.length / 1024).toFixed(0)}KB`
);
