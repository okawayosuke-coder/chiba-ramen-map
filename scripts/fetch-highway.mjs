// 高速道路施設（SA/PA/IC/JCT）を OSM(Overpass) から収集して public/highway.json を生成。
// 提案書⑧ハイウェイモードのMVPデータ。種別＋名称＋座標のみ（設備アイコンはフェーズ4で別途）。
// データ元 OpenStreetMap (ODbL)。商用可・帰属表示「© OpenStreetMap contributors」必須。
import { writeFileSync } from "node:fs";

// 関東全域＋接続する高速をカバー。(south,west,north,east)。広いのでタイル分割で収集（highways-geom.jsonと同範囲）。
const BBOX = [34.85, 138.4, 37.25, 141.0];
const TILE = 0.5;
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter", // 日本インスタンス（国内データに好適・別レート枠）
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1タイル分の高速施設（IC/JCT=motorway_junction / SA/PA=services/rest_area）を取得。
async function fetchTile(s, w, n, e) {
  const ql = `[out:json][timeout:120];
(
  node["highway"="motorway_junction"](${s},${w},${n},${e});
  way["highway"="services"](${s},${w},${n},${e});
  way["highway"="rest_area"](${s},${w},${n},${e});
  relation["highway"="services"](${s},${w},${n},${e});
  relation["highway"="rest_area"](${s},${w},${n},${e});
);
out center tags;`;
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

// タイルを巡回し element を id（type+id）で重複除去して集める。
async function overpass() {
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
        const k = `${el.type}/${el.id}`;
        if (byId.has(k)) continue;
        byId.set(k, el);
        added++;
      }
      console.log(`+${added} (計${byId.size})`);
      await sleep(1200);
    }
  }
  return [...byId.values()];
}

// 種別判定: 名称のSA/PA表記を最優先（PA/SAのランプノードがICに化けるのを防ぐ）→
// それ以外の motorway_junction を IC/JCT、way/relationは services=SA / rest_area=PA。
function kindOf(el) {
  const t = el.tags || {};
  const name = t.name || t.ref || "";
  if (/SA|ＳＡ|ｻｰﾋﾞｽ|サービスエリア/i.test(name)) return "sa";
  if (/PA|ＰＡ|ﾊﾟｰｷﾝｸﾞ|パーキング/i.test(name)) return "pa";
  if (t.highway === "motorway_junction") {
    return /JCT|ｼﾞｬﾝｸｼｮﾝ|ジャンクション|jct/i.test(name) ? "jct" : "ic";
  }
  if (t.highway === "services") return "sa";
  if (t.highway === "rest_area") return "pa";
  return null;
}

const els = await overpass();
console.log("elements:", els.length);

const seen = new Set();
const out = [];
for (const el of els) {
  const t = el.tags || {};
  const name = (t.name || t.ref || "").trim();
  if (!name) continue; // 無名のランプ/分岐ノイズは除外（ストリップで使えない）
  // 一般道の「道の駅」を除外（PA/SA併設名は残す）。高速施設ではないため。
  if (/道の駅/.test(name) && !/PA|ＰＡ|SA|ＳＡ|ハイウェイ/.test(name)) continue;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  const kind = kindOf(el);
  if (!kind) continue;
  // 同一IC/JCTの複数ランプノードを集約: 種別＋名称＋座標2桁(約1km)で重複除去
  const key = `${kind}:${name}:${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), kind, name });
}

out.sort((a, b) => (a.kind < b.kind ? -1 : 1));
const counts = out.reduce((m, f) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {});
console.log("収集:", JSON.stringify(counts), "計", out.length);

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  bbox: BBOX,
  source: "© OpenStreetMap contributors (ODbL)",
  facilities: out,
};
writeFileSync(
  new URL("../public/highway.json", import.meta.url),
  JSON.stringify(payload)
);
console.log("saved public/highway.json");
