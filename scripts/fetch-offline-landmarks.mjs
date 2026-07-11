import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
// OSM(Overpass)から神社/寺/城のランドマークを取得し GeoJSON 化。カバー範囲(pmtiles bbox 和)を1°セルに分割。
const DIR = "/private/tmp/claude-502/-Users-okawa-yosuke-code/1160ecb3-b137-4961-8506-a0e6e0a8c454/scratchpad/osm/cells";
const OUT = "/Users/okawa.yosuke/code/chiba-ramen-map/public/offline-basemap/labels-landmarks.json";
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const inCover = (lon, lat) =>
  (lon >= 136.0 && lon <= 141.1 && lat >= 34.6 && lat <= 37.4) ||
  (lon >= 138.4 && lon <= 142.1 && lat >= 37.0 && lat <= 41.6);
// 1°セル（union の外接矩形を走査し、inCover セルのみ）
const cells = [];
for (let lat = 34; lat < 42; lat++) for (let lon = 136; lon < 143; lon++) {
  // セルの四隅いずれかがカバー内なら対象
  if (inCover(lon + 0.5, lat + 0.5) || inCover(lon, lat) || inCover(lon + 1, lat + 1)) cells.push([lon, lat]);
}
console.log("対象セル数:", cells.length);
const feats = [];
const seen = new Set();
for (let ci = 0; ci < cells.length; ci++) {
  const [lon, lat] = cells[ci];
  const cache = `${DIR}/${lon}_${lat}.json`;
  let json;
  if (existsSync(cache)) { json = JSON.parse(readFileSync(cache, "utf8")); }
  else {
    const bbox = `${lat},${lon},${lat + 1},${lon + 1}`;
    const q = `[out:json][timeout:180];(nwr["amenity"="place_of_worship"]["religion"~"shinto|buddhist"](${bbox});nwr["historic"="castle"](${bbox}););out center;`;
    const qf = `${DIR}/.q.txt`; writeFileSync(qf, q);
    const tmp = `${DIR}/.tmp.json`;
    const UA = "TechMagicNavi-offline-builder/1.0 (personal map app; contact okawa)";
    let code = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        code = execSync(`curl -s --max-time 200 -A "${UA}" -H "Accept: application/json" -G "https://overpass-api.de/api/interpreter" --data-urlencode "data@${qf}" -o "${tmp}" -w "%{http_code}"`).toString().trim();
      } catch { code = "ERR"; }
      if (code === "200") break;
      execSync("sleep 12"); // 429/406 バックオフ
    }
    if (code !== "200") { console.log(`cell ${lon},${lat} -> HTTP ${code} (skip, 次回再試行)`); continue; }
    execSync(`mv "${tmp}" "${cache}"`);
    json = JSON.parse(readFileSync(cache, "utf8"));
    execSync("sleep 4"); // Overpass 礼儀
  }
  let kept = 0;
  for (const e of json.elements || []) {
    const t = e.tags || {};
    const lonv = e.lon ?? e.center?.lon, latv = e.lat ?? e.center?.lat;
    if (lonv == null || latv == null) continue;
    if (!inCover(lonv, latv)) continue;
    let cat = "shrine";
    if (t.historic === "castle") cat = "castle";
    else if (t.religion === "buddhist") cat = "temple";
    else if (t.religion === "shinto") cat = "shrine";
    else continue;
    const name = t["name:ja"] || t.name || "";
    const key = cat + "|" + lonv.toFixed(4) + "|" + latv.toFixed(4);
    if (seen.has(key)) continue; seen.add(key);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [+lonv.toFixed(5), +latv.toFixed(5)] }, properties: { name, cat } });
    kept++;
  }
  console.log(`cell ${ci + 1}/${cells.length} (${lon},${lat}): +${kept} (total ${feats.length})`);
}
const fc = { type: "FeatureCollection", features: feats };
writeFileSync(OUT, JSON.stringify(fc));
const byCat = {}; for (const f of feats) byCat[f.properties.cat] = (byCat[f.properties.cat] || 0) + 1;
const named = feats.filter((f) => f.properties.name).length;
console.log(`\nTOTAL ${feats.length} (named ${named}) ${Math.round(JSON.stringify(fc).length / 1024)} KB  by cat: ${JSON.stringify(byCat)}`);
