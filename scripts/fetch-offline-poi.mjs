import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
const DIR = "/private/tmp/claude-502/-Users-okawa-yosuke-code/1160ecb3-b137-4961-8506-a0e6e0a8c454/scratchpad/osm/poicells";
const OUT = "/Users/okawa.yosuke/code/chiba-ramen-map/public/offline-basemap/labels-poi.json";
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const inCover = (lon, lat) =>
  (lon >= 136.0 && lon <= 141.1 && lat >= 34.6 && lat <= 37.4) ||
  (lon >= 138.4 && lon <= 142.1 && lat >= 37.0 && lat <= 41.6);
const cells = [];
for (let lat = 34; lat < 42; lat++) for (let lon = 136; lon < 143; lon++)
  if (inCover(lon + 0.5, lat + 0.5) || inCover(lon, lat) || inCover(lon + 1, lat + 1)) cells.push([lon, lat]);
// カテゴリ判定（優先順＝上から最初に一致したもの。specificを先に）
function categorize(t) {
  if (t.natural === "peak") return "peak";
  if (t.waterway === "dam") return "dam";
  if (t.highway === "services" || t.highway === "rest_area") return "michinoeki";
  if (t.natural === "hot_spring" || t.amenity === "public_bath") return "onsen";
  if (t.amenity === "townhall") return "townhall";
  if (t.amenity === "hospital") return "hospital";
  if (t.amenity === "police") return "police";
  if (t.amenity === "post_office") return "post";
  if (t.tourism === "museum") return "museum";
  if (t.tourism === "viewpoint") return "viewpoint";
  if (t.tourism === "camp_site") return "camp";
  if (t.amenity === "fuel") return "fuel";
  if (t.shop === "supermarket") return "supermarket";
  if (t.shop === "convenience") return "convenience";
  if (t.amenity === "parking") return "parking";
  return null;
}
const SEL = [
  'nwr["amenity"="fuel"]', 'nwr["shop"="convenience"]', 'nwr["amenity"="parking"]["access"!="private"]',
  'nwr["highway"~"^(services|rest_area)$"]', 'nwr["shop"="supermarket"]', 'nwr["amenity"="hospital"]',
  'nwr["amenity"="townhall"]', 'nwr["amenity"="post_office"]', 'nwr["amenity"="police"]',
  'nwr["amenity"="public_bath"]', 'nwr["natural"="hot_spring"]', 'nwr["tourism"="museum"]',
  'nwr["tourism"="viewpoint"]', 'nwr["natural"="peak"]', 'nwr["waterway"="dam"]', 'nwr["tourism"="camp_site"]',
];
const feats = []; const seen = new Set();
for (let ci = 0; ci < cells.length; ci++) {
  const [lon, lat] = cells[ci];
  const cache = `${DIR}/${lon}_${lat}.json`;
  let json;
  if (existsSync(cache)) json = JSON.parse(readFileSync(cache, "utf8"));
  else {
    const bbox = `${lat},${lon},${lat + 1},${lon + 1}`;
    const q = `[out:json][timeout:300];(${SEL.map((s) => s + `(${bbox});`).join("")});out center;`;
    writeFileSync(`${DIR}/.q.txt`, q);
    let code = "";
    for (let a = 0; a < 5; a++) {
      try { code = execSync(`curl -s --max-time 340 -A "TechMagicNavi-offline/1.0" -H "Accept: application/json" -G "https://overpass-api.de/api/interpreter" --data-urlencode "data@${DIR}/.q.txt" -o "${DIR}/.tmp.json" -w "%{http_code}"`).toString().trim(); } catch { code = "ERR"; }
      if (code === "200") break; execSync("sleep 15");
    }
    if (code !== "200") { console.log(`cell ${lon},${lat} -> ${code} (skip, 次回)`); continue; }
    execSync(`mv "${DIR}/.tmp.json" "${cache}"`);
    json = JSON.parse(readFileSync(cache, "utf8"));
    execSync("sleep 5");
  }
  let kept = 0;
  for (const e of json.elements || []) {
    const t = e.tags || {}; const lonv = e.lon ?? e.center?.lon, latv = e.lat ?? e.center?.lat;
    if (lonv == null || latv == null || !inCover(lonv, latv)) continue;
    const cat = categorize(t); if (!cat) continue;
    let name = t["name:ja"] || t.name || "";
    if (cat === "peak" && name && t.ele && /^\d/.test(t.ele)) name += " " + Math.round(parseFloat(t.ele)) + "m";
    const key = cat + "|" + lonv.toFixed(4) + "|" + latv.toFixed(4);
    if (seen.has(key)) continue; seen.add(key);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [+lonv.toFixed(5), +latv.toFixed(5)] }, properties: name ? { name, cat } : { cat } });
    kept++;
  }
  console.log(`cell ${ci + 1}/${cells.length} (${lon},${lat}): +${kept} total ${feats.length}`);
}
writeFileSync(OUT, JSON.stringify({ type: "FeatureCollection", features: feats }));
const byCat = {}; for (const f of feats) byCat[f.properties.cat] = (byCat[f.properties.cat] || 0) + 1;
console.log(`\nDONE ${feats.length} feats, ${(JSON.stringify({type:"FeatureCollection",features:feats}).length/1024/1024).toFixed(1)} MB`);
console.log("by cat:", JSON.stringify(byCat));
