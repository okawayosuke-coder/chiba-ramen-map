// 高速道路（motorway/motorway_link）のセンターライン形状を OSM(Overpass) から収集し
// public/highways-geom.json に同梱用で保存。現在地を線にスナップして「高速上か＋どの高速か」を
// 位置ベースで判定するために使う（速度判定のフォールバック付き）。データ元 OpenStreetMap (ODbL)。
//
// 容量対策: Douglas-Peucker で簡略化（ε≈13m）＋座標5桁丸め。スナップ閾値(約35m)に対し十分な精度。
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// fetch-highway.mjs と同じ範囲（千葉＋接続する首都圏東部の高速）。
const BBOX = [34.95, 139.65, 36.1, 140.95];
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// 高速道路本線＋ランプ。trunk は一般道バイパスを拾い誤検知の元なので含めない。
const ql = `[out:json][timeout:240];
(
  way["highway"="motorway"](${BBOX.join(",")});
  way["highway"="motorway_link"](${BBOX.join(",")});
);
out geom tags;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass() {
  for (let round = 0; round < 4; round++) {
    for (const url of MIRRORS) {
      try {
        console.log(`query r${round}`, url);
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(ql),
        });
        if (!r.ok) {
          console.log("  ng", r.status);
          continue;
        }
        const j = await r.json();
        if (Array.isArray(j.elements)) return j.elements;
      } catch (e) {
        console.log("  err", e.message);
      }
    }
    const wait = 8000 * (round + 1);
    console.log(`  全ミラー不可。${wait / 1000}秒待って再試行...`);
    await sleep(wait);
  }
  throw new Error("all mirrors failed");
}

// 緯度経度の点列を Douglas-Peucker で簡略化（ε は度。約13m≒0.00012）。
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  // 端点を結ぶ直線からの最大垂直距離点を探す
  let maxD = 0,
    idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    // 点-線分の垂直距離（度空間の近似で十分。経度は緯度で圧縮）
    const latScale = Math.cos((ax * Math.PI) / 180);
    const dx = (bx - ax) * latScale;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let d;
    if (len2 === 0) {
      d = Math.hypot((px - ax) * latScale, py - ay);
    } else {
      let t = (((px - ax) * latScale) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + (t * dx) / latScale;
      const cy = ay + t * dy;
      d = Math.hypot((px - cx) * latScale, py - cy);
    }
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

const els = await overpass();
console.log("ways:", els.length);

const EPS = 0.00012; // ≈13m
const roads = [];
let rawPts = 0,
  keptPts = 0;
for (const el of els) {
  if (!Array.isArray(el.geometry) || el.geometry.length < 2) continue;
  const t = el.tags || {};
  const ref = (t.ref || "").trim();
  const name = (t.name || "").trim();
  // [lat,lng] 配列に（geometry は {lat,lon}）
  let pts = el.geometry.map((g) => [g.lat, g.lon]);
  rawPts += pts.length;
  pts = rdp(pts, EPS).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
  keptPts += pts.length;
  roads.push({ ref, name, c: pts });
}

console.log(`簡略化: ${rawPts} → ${keptPts} 点（${roads.length} 本）`);

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  bbox: BBOX,
  source: "© OpenStreetMap contributors (ODbL)",
  roads,
};
const json = JSON.stringify(payload);
writeFileSync(new URL("../public/highways-geom.json", import.meta.url), json);
const gz = gzipSync(Buffer.from(json));
console.log(
  `saved public/highways-geom.json  raw=${(json.length / 1024).toFixed(0)}KB gzip=${(
    gz.length / 1024
  ).toFixed(0)}KB`
);
