// オフライン基図のラベル(地名/道路番号)用 GeoJSON を、生成済み region pmtiles から抽出する。
// 出力: public/offline-basemap/labels-places.json(市区町村+地区) / labels-roads.json(高速+国道級のref)。
// これらは vite の precache 対象(json)で、圏外冷間起動でも即使える。symbol はネイティブ geojson ソースに
// 載せる(offlineBasemap.ts)＝am2222カスタムソース上の symbol がタイル描画を壊す不具合を回避する設計。
//
// 依存(隔離環境で): npm i @mapbox/vector-tile pbf@3 pmtiles
// 入力 pmtiles(SOURCES): kc-south-z12 / tohoku-north-z12 を再生成する場合は
//   pmtiles extract japan-z12.pmtiles <out> --maxzoom 12 --bbox=<w,s,e,n>
// ※SOURCES のパスは生成環境に合わせて書き換えること(下記は生成時の scratchpad パス)。

class FileSource {
  constructor(path) { this.buf = readFileSync(path); this.key = path; }
  getKey() { return this.key; }
  async getBytes(offset, length) { return { data: this.buf.buffer.slice(this.buf.byteOffset + offset, this.buf.byteOffset + offset + length) }; }
}
const SC = "/private/tmp/claude-502/-Users-okawa-yosuke-code/1160ecb3-b137-4961-8506-a0e6e0a8c454/scratchpad/";
const OUT = "/Users/okawa.yosuke/code/chiba-ramen-map/public/offline-basemap/";
const SOURCES = [
  { file: SC + "kc-south-z12.pmtiles", bbox: [136.0, 34.6, 141.1, 37.4] },
  { file: SC + "tohoku-north-z12.pmtiles", bbox: [138.4, 37.0, 142.1, 41.6] },
];
const PLACE_Z = 11; // 地名抽出ズーム（localities+主要neighbourhoodが揃う）
const ROAD_Z = 11;  // 道路ref抽出ズーム（主要道路網）
// 道路: 高速(motorway)＋国道級(trunk)のみ。primary(主要地方道)は密すぎるので除外＝ナビで見る番号に集中。
const ROAD_KEEP = new Set(["motorway", "trunk"]);
// 地名: 都道府県(region)/市区町村(locality)/地区(macrohood)/町名(neighbourhood)。密度は min_zoom＋collision で制御。
const PLACE_KEEP = new Set(["locality", "region", "macrohood", "neighbourhood"]);
// 線の簡略化: 隣接点が近すぎる(度)場合は間引く（シールド配置には粗い経路で十分・サイズ削減）。
const SIMPLIFY_DEG = 0.0015; // 約150m

function ll2t(lon, lat, z) { const n = 2 ** z; return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n) }; }

async function decode(pm, z, x, y) {
  const t = await pm.getZxy(z, x, y); if (!t) return null;
  let data = new Uint8Array(t.data);
  if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  return new VectorTile(new Pbf(data));
}

const POI_Z = 12; // POI抽出ズーム（駅・町名・団地が揃う最大ズーム）
// POI: 駅(station)＝ランドマーク / 町名(postal_code)・丁目(administrative)・団地(residential)＝密な地名。
const POI_KEEP = new Set(["station", "postal_code", "administrative", "residential"]);

const placeMap = new Map(); // key name|round → feature（重複排除・min_zoom最小を採用）
const roadMap = new Map();  // key ref|round(mid) → linestring（重複排除）
const poiMap = new Map();   // key name|round → feature（駅/町名/団地）

for (const src of SOURCES) {
  const pm = new PMTiles(new FileSource(src.file));
  const [w, s, e, n] = src.bbox;
  // places
  { const a = ll2t(w, n, PLACE_Z), b = ll2t(e, s, PLACE_Z);
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
      const vt = await decode(pm, PLACE_Z, x, y); if (!vt || !vt.layers.places) continue;
      const L = vt.layers.places;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i); const p = f.properties;
        const name = p["name:ja"] || p.name; if (!name) continue;
        const kind = p["pmap:kind"] || p.kind || ""; // locality / macrohood / neighbourhood / region
        if (!PLACE_KEEP.has(kind)) continue;
        const mz = Number(p["pmap:min_zoom"] ?? p.min_zoom ?? 8);
        const g = f.toGeoJSON(x, y, PLACE_Z); const c = g.geometry.coordinates;
        const key = name + "|" + c[0].toFixed(2) + "|" + c[1].toFixed(2);
        const prev = placeMap.get(key);
        if (!prev || mz < prev.properties.mz) placeMap.set(key, { type: "Feature", geometry: { type: "Point", coordinates: [+c[0].toFixed(5), +c[1].toFixed(5)] }, properties: { name, kind, mz, pop: Number(p.population || 0) } });
      }
    }
  }
  // roads with ref
  { const a = ll2t(w, n, ROAD_Z), b = ll2t(e, s, ROAD_Z);
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
      const vt = await decode(pm, ROAD_Z, x, y); if (!vt || !vt.layers.roads) continue;
      const L = vt.layers.roads;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i); const p = f.properties;
        const kd = p.kind_detail || ""; if (!ROAD_KEEP.has(kd)) continue;
        const ref = (p.shield_text || p.ref || "").split(";")[0].trim(); if (!ref) continue;
        const mz = Number(p["pmap:min_zoom"] ?? p.min_zoom ?? 6);
        const g = f.toGeoJSON(x, y, ROAD_Z); if (g.geometry.type !== "LineString" && g.geometry.type !== "MultiLineString") continue;
        const coords = g.geometry.type === "LineString" ? [g.geometry.coordinates] : g.geometry.coordinates;
        for (const line of coords) {
          if (line.length < 2) continue;
          // 簡略化: 前点からSIMPLIFY_DEG以上離れた点だけ残す（始終点は必ず残す）
          const simp = [line[0]];
          for (let k = 1; k < line.length - 1; k++) { const a = simp[simp.length - 1], b = line[k]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= SIMPLIFY_DEG) simp.push(b); }
          simp.push(line[line.length - 1]);
          const mid = simp[Math.floor(simp.length / 2)];
          const key = ref + "|" + kd + "|" + mid[0].toFixed(1) + "|" + mid[1].toFixed(1);
          if (roadMap.has(key)) continue;
          roadMap.set(key, { type: "Feature", geometry: { type: "LineString", coordinates: simp.map((c) => [+c[0].toFixed(5), +c[1].toFixed(5)]) }, properties: { ref, kd, mz } });
        }
      }
    }
  }
  // pois（駅/町名/団地）
  { const a = ll2t(w, n, POI_Z), b = ll2t(e, s, POI_Z);
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
      const vt = await decode(pm, POI_Z, x, y); if (!vt || !vt.layers.pois) continue;
      const L = vt.layers.pois;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i); const p = f.properties;
        const kind = p["pmap:kind"] || p.kind || "";
        if (!POI_KEEP.has(kind)) continue;
        const name = p["name:ja"] || p.name; if (!name) continue;
        // administrative は 市/区/郡 など locality と重複する広域は除外し、丁目・大字レベルのみ採用。
        if (kind === "administrative" && /(都|道|府|県|市|区|郡|町|村)$/.test(name)) continue;
        const mz = Number(p["pmap:min_zoom"] ?? p.min_zoom ?? 12);
        const g = f.toGeoJSON(x, y, POI_Z); const c = g.geometry.coordinates;
        const cat = kind === "station" ? "station" : "town"; // 表示上は駅か町名の2種
        const key = cat + "|" + name + "|" + c[0].toFixed(2) + "|" + c[1].toFixed(2);
        if (!poiMap.has(key)) poiMap.set(key, { type: "Feature", geometry: { type: "Point", coordinates: [+c[0].toFixed(5), +c[1].toFixed(5)] }, properties: { name, cat, mz } });
      }
    }
  }
  console.log(src.file.split("/").pop(), "→ places", placeMap.size, "roads", roadMap.size, "pois", poiMap.size);
}

const places = { type: "FeatureCollection", features: [...placeMap.values()] };
const roads = { type: "FeatureCollection", features: [...roadMap.values()] };
const pois = { type: "FeatureCollection", features: [...poiMap.values()] };
writeFileSync(OUT + "labels-places.json", JSON.stringify(places));
writeFileSync(OUT + "labels-roads.json", JSON.stringify(roads));
writeFileSync(OUT + "labels-pois.json", JSON.stringify(pois));
const kb = (o) => Math.round(JSON.stringify(o).length / 1024);
console.log("WROTE places:", places.features.length, kb(places), "KB | roads:", roads.features.length, kb(roads), "KB | pois:", pois.features.length, kb(pois), "KB");
const byKind = {}; for (const f of places.features) byKind[f.properties.kind] = (byKind[f.properties.kind] || 0) + 1;
console.log("places by kind:", JSON.stringify(byKind));
const byCat = {}; for (const f of pois.features) byCat[f.properties.cat] = (byCat[f.properties.cat] || 0) + 1;
console.log("pois by cat:", JSON.stringify(byCat));
