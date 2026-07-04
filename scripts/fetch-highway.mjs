// 高速道路施設（SA/PA/IC/JCT）を OSM(Overpass) から収集して public/highway.json を生成。
// 提案書⑧ハイウェイモードのMVPデータ。種別＋名称＋座標のみ（設備アイコンはフェーズ4で別途）。
// データ元 OpenStreetMap (ODbL)。商用可・帰属表示「© OpenStreetMap contributors」必須。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 2点間の距離(m)。同一施設の重複ノード集約（上り/下りの別地点分岐は残す）に使う。
function havM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 関東全域＋接続する高速をカバー。(south,west,north,east)。広いのでタイル分割で収集（highways-geom.jsonと同範囲）。
// 全国化(地方ブロック生成)用に env で上書き可: HW_BBOX / HW_TILE / HW_FAC_FILE(出力先)。
const BBOX = process.env.HW_BBOX
  ? process.env.HW_BBOX.split(",").map(Number)
  : [34.85, 138.4, 37.25, 141.0];
const TILE = Number(process.env.HW_TILE || 0.5);
const MIRRORS = [
  "https://overpass.osm.jp/api/interpreter", // 日本インスタンス（国内データに好適・別レート枠）
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass QLを実行しelementsを返す（ミラー巡回＋リトライ共通処理）。
async function runQuery(ql, label) {
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
  throw new Error(`${label} all mirrors failed`);
}

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
  return runQuery(ql, `tile ${s},${w}`);
}

// 同じタイルの方面看板データ(destination付きmotorway_link)。端点座標が要るためgeomで別途取得する。
// ★out geom center tags は一部ミラーでgeometryが欠落する（実測確認済）ため、center専用クエリとgeom専用
//   クエリに分けて2回叩く。1回のクエリでcenter/geomを両立しようとしない。
async function fetchLinkTile(s, w, n, e) {
  const ql = `[out:json][timeout:120];
(
  way["highway"="motorway_link"]["destination"](${s},${w},${n},${e});
);
out geom tags;`;
  return runQuery(ql, `link-tile ${s},${w}`);
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
      await sleep(1200);
      const linkEls = await fetchLinkTile(s, w, n, e);
      let added = 0;
      for (const el of [...els, ...linkEls]) {
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
  // 同一施設の重複ノード集約: 同種別・同名で150m以内は1件に（複数ランプノード等の真の重複のみ）。
  // ★上り/下りの出口分岐は同名でも数百m離れた別地点なので両方残す＝表示側が進行方向側の分岐を選ぶ
  //   （旧: 座標2桁≒1kmグリッドで集約し、上下分岐の片方を落として距離が最大~1kmズレていた）。
  const cand = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), kind, name };
  // 出口番号: motorway_junctionノード自身のref（例"7"）。nameが別途あるnodeのみ（ref自体がnameに化けているケースを除外）。
  // ★destination:ref（後述の方面紐付け）は実データ確認の結果、路線番号(例"E51")であって出口番号ではないため使わない。
  if ((kind === "ic" || kind === "jct") && t.name && t.ref) cand.exit = String(t.ref).trim();
  if (out.some((o) => o.kind === cand.kind && o.name === cand.name && havM(o.lat, o.lng, cand.lat, cand.lng) < 150))
    continue;
  out.push(cand);
}

// --- 方面(destination)の紐付け: motorway_linkのdestinationタグをIC/JCTに紐付け、矢印の絶対方位(bearing)を算出 ---
// 対向車線の別ノードは既に150m以内のみ統合済み(上記)なので、紐付けは統合後のoutに対して行う。
// 単純な最近傍ノード紐付けは対向車線/隣接JCTへの誤帰属を招く(実データで204m/541m離れの誤候補を確認済み)ため、
// 閾値30m以内(真の直結は0m一致)でのみ紐付ける。bearingは絶対方位(0-360°、真北基準)で保持し、
// 「左右どちら」への変換は実行時に自車の進行方位と比較して行う（自車方位が無いと相対方向を決められないため）。
const mPerLat = 110540;
const mPerLngAt = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
function bearingDeg(aLat, aLng, bLat, bLng) {
  const x = (bLng - aLng) * mPerLngAt((aLat + bLat) / 2);
  const y = (bLat - aLat) * mPerLat;
  return (((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360;
}
const LINK_MATCH_M = 30;
const linkWays = els.filter(
  (el) =>
    el.type === "way" &&
    el.tags?.highway === "motorway_link" &&
    el.tags?.destination &&
    Array.isArray(el.geometry) &&
    el.geometry.length >= 2
);
console.log(`motorway_link(destination付き): ${linkWays.length}件`);
let towardCount = 0;
for (const f of out) {
  if (f.kind !== "ic" && f.kind !== "jct") continue;
  const dests = new Map(); // 地名 -> 方位（同名重複は先勝ち）
  for (const link of linkWays) {
    const g = link.geometry;
    const startM = havM(f.lat, f.lng, g[0].lat, g[0].lon);
    const endM = havM(f.lat, f.lng, g[g.length - 1].lat, g[g.length - 1].lon);
    const atStart = startM <= endM;
    if (Math.min(startM, endM) > LINK_MATCH_M) continue;
    // ジャンクション側の端点から、ランプがその先どちらへ物理的に向かうか（=矢印の向き）を算出。
    const bearing = atStart
      ? bearingDeg(g[0].lat, g[0].lon, g[1].lat, g[1].lon)
      : bearingDeg(g[g.length - 1].lat, g[g.length - 1].lon, g[g.length - 2].lat, g[g.length - 2].lon);
    for (const dn of link.tags.destination.split(";").map((x) => x.trim()).filter(Boolean)) {
      if (!dests.has(dn)) dests.set(dn, Math.round(bearing));
    }
  }
  if (dests.size) {
    f.toward = [...dests.entries()].slice(0, 4).map(([name, bearing]) => ({ name, bearing }));
    towardCount++;
  }
}
const icJctTotal = out.filter((f) => f.kind === "ic" || f.kind === "jct").length;
console.log(
  `toward付与: ${towardCount}/${icJctTotal}件 (${icJctTotal ? Math.round((towardCount / icJctTotal) * 100) : 0}%)`
);

out.sort((a, b) => (a.kind < b.kind ? -1 : 1));
const counts = out.reduce((m, f) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {});
console.log("収集:", JSON.stringify(counts), "計", out.length);

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  bbox: BBOX,
  source: "© OpenStreetMap contributors (ODbL)",
  facilities: out,
};
const OUT_URL = process.env.HW_FAC_FILE
  ? pathToFileURL(resolve(process.env.HW_FAC_FILE))
  : new URL("../public/highway.json", import.meta.url);
writeFileSync(OUT_URL, JSON.stringify(payload));
console.log(`saved ${OUT_URL.pathname}`);
