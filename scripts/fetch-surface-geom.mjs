// 高速の「真下/真横を走る一般道」(国道357号 等)のセンターライン形状を OSM から収集し
// public/surface-geom.json に同梱。走行中「最寄り一般道 vs 最寄り高速」を比べ、一般道が明確に
// 近ければ高速判定を打ち消す（357が高架の湾岸線/東関東で高速誤認される問題の対策）。
// 容量対策: 高速センターラインから PROX_M 以内の trunk/primary だけ残す（高速近傍以外は誤認を
// 起こさないので不要）＋ Douglas-Peucker 簡略化(ε≈13m)＋5桁丸め。データ元 OpenStreetMap (ODbL)。
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BBOX = [34.85, 138.4, 37.25, 141.0]; // fetch-highway-geom.mjs と同じ関東全域
const TILE = 0.5;
const PROX_M = 120; // 高速センターラインからこの距離以内の一般道だけ残す
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 高速センターライン（既存同梱）を読み bbox プレフィルタ付きで最寄り距離を測れるようにする
const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));
const HW = [];
for (const r of geom.roads) {
  if (!Array.isArray(r.c) || r.c.length < 2) continue;
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of r.c) { if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0]; if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; }
  HW.push({ c: r.c, s, w, n, e });
}
const PAD = 0.0016; // 約180m。PROX_M(120m)より広めに取り取りこぼし防止
// 点が最寄り高速まで maxM 以内かを早期判定（true/false）
function withinHighway(lat, lng, maxM) {
  const mLat = 110540, mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  for (const road of HW) {
    if (lat < road.s - PAD || lat > road.n + PAD || lng < road.w - PAD || lng > road.e + PAD) continue;
    const c = road.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mLng, ay = (c[i][0] - lat) * mLat;
      const bx = (c[i + 1][1] - lng) * mLng, by = (c[i + 1][0] - lat) * mLat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= maxM) return true;
    }
  }
  return false;
}

async function fetchTile(s, w, n, e) {
  const ql = `[out:json][timeout:120];
(
  way["highway"="trunk"](${s},${w},${n},${e});
  way["highway"="trunk_link"](${s},${w},${n},${e});
  way["highway"="primary"](${s},${w},${n},${e});
);
out geom;`;
  for (let round = 0; round < 3; round++) {
    for (const url of MIRRORS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(ql) });
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j.elements)) return j.elements;
      } catch { /* 次のミラー */ }
    }
    await sleep(5000 * (round + 1));
  }
  throw new Error(`tile ${s},${w} all mirrors failed`);
}

// Douglas-Peucker（fetch-highway-geom.mjs と同一）
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const latScale = Math.cos((ax * Math.PI) / 180);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const dx = (bx - ax) * latScale, dy = by - ay, len2 = dx * dx + dy * dy;
    let d;
    if (len2 === 0) d = Math.hypot((px - ax) * latScale, py - ay);
    else { let t = (((px - ax) * latScale) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t)); d = Math.hypot((px - (ax + (t * dx) / latScale)) * latScale, py - (ay + t * dy)); }
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

const byId = new Map();
let tiles = 0;
for (let s = BBOX[0]; s < BBOX[2]; s += TILE) {
  for (let w = BBOX[1]; w < BBOX[3]; w += TILE) {
    const n = Math.min(s + TILE, BBOX[2]), e = Math.min(w + TILE, BBOX[3]);
    tiles++;
    process.stdout.write(`tile ${tiles} (${s.toFixed(1)},${w.toFixed(1)}) ... `);
    const els = await fetchTile(s, w, n, e);
    let added = 0;
    for (const el of els) {
      if (el.type !== "way" || byId.has(el.id) || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      // 高速近傍(PROX_M以内)を1点でも通る way だけ採用
      let near = false;
      for (const g of el.geometry) { if (withinHighway(g.lat, g.lon, PROX_M)) { near = true; break; } }
      if (!near) continue;
      byId.set(el.id, el.geometry.map((g) => [g.lat, g.lon]));
      added++;
    }
    console.log(`+${added} (計${byId.size})`);
    await sleep(1200);
  }
}

const EPS = 0.00012;
const roads = [];
let rawPts = 0, keptPts = 0;
for (const pts0 of byId.values()) {
  rawPts += pts0.length;
  const pts = rdp(pts0, EPS).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
  keptPts += pts.length;
  roads.push({ c: pts });
}
console.log(`簡略化: ${rawPts} → ${keptPts} 点（${roads.length} 本 / ${tiles} タイル）`);

const payload = { generated: new Date().toISOString().slice(0, 10), bbox: BBOX, prox_m: PROX_M, source: "© OpenStreetMap contributors (ODbL)", roads };
const json = JSON.stringify(payload);
writeFileSync(new URL("../public/surface-geom.json", import.meta.url), json);
const gz = gzipSync(Buffer.from(json));
console.log(`saved public/surface-geom.json  raw=${(json.length / 1024).toFixed(0)}KB gzip=${(gz.length / 1024).toFixed(0)}KB`);
