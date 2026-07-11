import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
// 国土交通省 位置参照情報 大字・町丁目レベル(19.0b・令和7年)から、カバー範囲の町丁目点を抽出。
// CSVはShift-JIS。列: 都道府県cd,都道府県名,市区町村cd,市区町村名,大字町丁目cd,大字町丁目名,緯度,経度,原典,区分
const DIR = "/private/tmp/claude-502/-Users-okawa-yosuke-code/1160ecb3-b137-4961-8506-a0e6e0a8c454/scratchpad/isj";
const OUT = "/Users/okawa.yosuke/code/chiba-ramen-map/public/offline-basemap/labels-chome.json";
// カバー範囲(pmtiles bbox の和): south=中部+関東 / north=東北
const inCover = (lon, lat) =>
  (lon >= 136.0 && lon <= 141.1 && lat >= 34.6 && lat <= 37.4) ||
  (lon >= 138.4 && lon <= 142.1 && lat >= 37.0 && lat <= 41.6);
// 取得都県コード（bboxに掛かり得る関東7+中部6+東北6+隣接）
const PREFS = ["02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","19","20","21","22","23"];

const feats = [];
const seen = new Set();
let scanned = 0;
for (const p of PREFS) {
  const zip = `${DIR}/${p}.zip`;
  if (!existsSync(zip)) {
    execSync(`curl -s -o "${zip}" "https://nlftp.mlit.go.jp/isj/dls/data/19.0b/${p}000-19.0b.zip"`);
  }
  execSync(`cd "${DIR}" && unzip -o -q "${p}.zip"`);
  const csv = execSync(`ls ${DIR}/${p}000-19.0b/*.csv`).toString().trim().split("\n")[0];
  // CP932(Shift-JIS上位互換)＋不正バイト破棄(-c)で堅牢化。maxBufferを拡大(大きい県対策)。
  const text = execSync(`iconv -f CP932 -t UTF-8 -c "${csv}"`, { maxBuffer: 256 * 1024 * 1024 }).toString();
  const lines = text.split("\n"); lines.shift(); // header
  let kept = 0;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    scanned++;
    const c = ln.split(",").map((s) => s.replace(/^"|"$/g, ""));
    const name = c[5], lat = parseFloat(c[6]), lon = parseFloat(c[7]);
    if (!name || !isFinite(lat) || !isFinite(lon)) continue;
    if (!inCover(lon, lat)) continue;
    const key = name + "|" + lon.toFixed(3) + "|" + lat.toFixed(3);
    if (seen.has(key)) continue; seen.add(key);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [+lon.toFixed(5), +lat.toFixed(5)] }, properties: { name } });
    kept++;
  }
  console.log(`pref ${p}: kept ${kept}`);
}
const fc = { type: "FeatureCollection", features: feats };
writeFileSync(OUT, JSON.stringify(fc));
console.log(`\nTOTAL scanned ${scanned} → kept ${feats.length} feats, ${Math.round(JSON.stringify(fc).length / 1024)} KB`);
