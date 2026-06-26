// 高速道路施設（SA/PA/IC/JCT）を OSM(Overpass) から収集して public/highway.json を生成。
// 提案書⑧ハイウェイモードのMVPデータ。種別＋名称＋座標のみ（設備アイコンはフェーズ4で別途）。
// データ元 OpenStreetMap (ODbL)。商用可・帰属表示「© OpenStreetMap contributors」必須。
import { writeFileSync } from "node:fs";

// 千葉中心＋接続する高速をカバー。(south,west,north,east)。広げると重くなりOverpassに弾かれやすい
const BBOX = [34.95, 139.65, 36.1, 140.95];
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter", // 日本インスタンス（国内データに好適・別レート枠）
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const ql = `[out:json][timeout:180];
(
  node["highway"="motorway_junction"](${BBOX.join(",")});
  way["highway"="services"](${BBOX.join(",")});
  way["highway"="rest_area"](${BBOX.join(",")});
  relation["highway"="services"](${BBOX.join(",")});
  relation["highway"="rest_area"](${BBOX.join(",")});
);
out center tags;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass() {
  // 3ラウンド×全ミラーを試行。429/混雑時はラウンド間でバックオフ。
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
