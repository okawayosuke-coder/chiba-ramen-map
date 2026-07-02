// 既存 public/highway.json のベースデータ（SA/PA/IC/JCT）は壊さず、
// 各SA/PAの「中にある設備」（コンビニ/GS/飲食/カフェ/売店/トイレ/EV）を OSM から付与する。
// 提案書⑧ハイウェイモード「SA/PAは設備アイコン P/⛽/🍴/☕」の実装。データ元 OpenStreetMap (ODbL)。
//
// 使い方: node scripts/enrich-highway-amenities.mjs
//   Overpass で SA/PA ポリゴン内の amenity/shop を1クエリ取得 → 最寄りSA/PAへ割当 → 設備種別を付与。
//   ついでに高速施設でない誤登録SA（"渚の駅"等の○○の駅）を除去。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../public/highway.json", import.meta.url);
const data = JSON.parse(readFileSync(FILE, "utf8"));
const BBOX = data.bbox || [34.95, 139.65, 36.1, 140.95];

const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// SA/PAポリゴン内の amenity/shop を取得（Overpassが包含判定＝半径方式より正確でノイズが少ない）。
const ql = `[out:json][timeout:180];
(
  way["highway"="services"](${BBOX.join(",")});
  way["highway"="rest_area"](${BBOX.join(",")});
  relation["highway"="services"](${BBOX.join(",")});
  relation["highway"="rest_area"](${BBOX.join(",")});
)->.sa;
.sa map_to_area -> .a;
(
  nwr(area.a)["amenity"];
  nwr(area.a)["shop"];
);
out tags center;`;

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

// OSM の amenity/shop タグ → 表示用の設備種別。対象外（ベンチ・自販機・喫煙所等のノイズ）は null。
function mapAmenity(t) {
  const a = t.amenity || "";
  const s = t.shop || "";
  if (s === "convenience") return "conv";
  if (a === "fuel") return "fuel";
  if (a === "restaurant" || a === "fast_food" || a === "food_court") return "food";
  if (a === "cafe" || a === "ice_cream") return "cafe";
  if (a === "toilets") return "toilet";
  if (a === "charging_station") return "ev";
  if (/^(gift|bakery|deli|general|supermarket|kiosk|pastry|confectionery|farm|greengrocer|seafood|food)$/.test(s))
    return "shop";
  return null;
}

// 表示順（カーナビ慣習: 売店/飲食/燃料/トイレ系）。UIもこの順で並べる。
const ORDER = ["conv", "fuel", "food", "cafe", "shop", "toilet", "ev"];

const havKm = (aLat, aLng, bLat, bLng) => {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// 高速施設でない誤登録（"渚の駅"等の○○の駅）を除去。SA/PA/サービス/パーキング表記が無い「駅」物件を弾く。
const before = data.facilities.length;
data.facilities = data.facilities.filter((f) => {
  if ((f.kind === "sa" || f.kind === "pa") && /の駅/.test(f.name) && !/SA|ＳＡ|PA|ＰＡ|サービス|パーキング|ハイウェイ/.test(f.name)) {
    console.log("  除外(高速施設でない):", f.name);
    return false;
  }
  return true;
});
console.log(`誤登録SA除去: ${before} -> ${data.facilities.length}`);

// 全角「ＰＡ/ＳＡ/ＩＣ」と半角「PA/SA/IC」の名称ゆれで同じ施設が二重登録される問題を統合。
// 向き（上り/下り/内回り/外回り）は別物として保持し、全角→半角・空白除去した名称が一致し
// 150m以内のものだけを1件にまとめる（名称ゆれの真の重複はほぼ同座標）。
// ★上り/下りの出口分岐やSA/PAは同名でも数百m離れた別地点なので両方残す＝表示側が進行方向側を選ぶ
//   （旧: 2km以内で統合し、四街道IC等の上下分岐の片方を落として距離が最大~1kmズレていた）。
const normKey = (f) =>
  `${f.kind}:` +
  f.name
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[\s　]/g, "")
    .toLowerCase();
const dedupBefore = data.facilities.length;
const groups = new Map();
for (const f of data.facilities) {
  const k = normKey(f);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
const deduped = [];
for (const list of groups.values()) {
  const used = new Array(list.length).fill(false);
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    // 同名150m以内をクラスタ化し1件に（先頭を代表に）＝真の重複のみ。上下分岐(数百m)は残す。
    for (let j = i + 1; j < list.length; j++) {
      if (!used[j] && havKm(list[i].lat, list[i].lng, list[j].lat, list[j].lng) < 0.15) used[j] = true;
    }
    deduped.push(list[i]);
  }
}
data.facilities = deduped;
console.log(`全角/半角の重複統合: ${dedupBefore} -> ${data.facilities.length}`);

// 再実行でも結果が一定になるよう、設備フィールドを一旦クリアしてから付け直す（冪等化）。
for (const f of data.facilities) {
  delete f.amenities;
  delete f.convBrand;
  delete f.fuelBrand;
}

const saPa = data.facilities.filter((f) => f.kind === "sa" || f.kind === "pa");
console.log(`SA/PA ${saPa.length}件の設備を収集...`);

const els = await overpass();
console.log("area内 amenity/shop 要素:", els.length);

// 各設備要素を最寄りSA/PA（0.6km以内）へ割当
const sets = new Map(); // facility(ref) -> Set(kind)
const brands = new Map(); // facility(ref) -> { conv?:string, fuel?:string }（見た目判別用ブランド名）
let assigned = 0;
for (const el of els) {
  const t = el.tags || {};
  const kind = mapAmenity(t);
  if (!kind) continue;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  let best = null;
  let bd = 0.6;
  for (const f of saPa) {
    const d = havKm(lat, lng, f.lat, f.lng);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  if (!best) continue;
  if (!sets.has(best)) sets.set(best, new Set());
  sets.get(best).add(kind);
  // コンビニ/GSは見た目でブランドが分かるよう brand/name/operator を保持
  if (kind === "conv" || kind === "fuel") {
    const b = (t.brand || t.name || t.operator || "").trim();
    if (b) {
      if (!brands.has(best)) brands.set(best, {});
      const bo = brands.get(best);
      if (!bo[kind]) bo[kind] = b;
    }
  }
  assigned++;
}

// 上り/下りで同名のSA/PAは設備を相互マージ（基準名＋種別が一致するもの）
const baseName = (n) =>
  n
    .replace(/[（(].*?[)）]/g, "")
    .replace(/(上り|下り|内回り|外回り)/g, "")
    .replace(/[\s　]/g, "")
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
const byBase = new Map();
for (const f of saPa) {
  const key = `${f.kind}:${baseName(f.name)}`;
  if (!byBase.has(key)) byBase.set(key, []);
  byBase.get(key).push(f);
}
for (const group of byBase.values()) {
  const union = new Set();
  let convB = "";
  let fuelB = "";
  for (const f of group) {
    for (const k of sets.get(f) || []) union.add(k);
    const bo = brands.get(f) || {};
    if (!convB && bo.conv) convB = bo.conv;
    if (!fuelB && bo.fuel) fuelB = bo.fuel;
  }
  if (union.size === 0) continue;
  const ordered = ORDER.filter((k) => union.has(k));
  for (const f of group) {
    f.amenities = ordered;
    if (convB) f.convBrand = convB;
    if (fuelB) f.fuelBrand = fuelB;
  }
}

const withAmen = saPa.filter((f) => f.amenities && f.amenities.length).length;
console.log(`設備付与: ${withAmen}/${saPa.length} 施設（割当要素 ${assigned}）`);

data.generated = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(data));
console.log("saved public/highway.json");
