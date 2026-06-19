// 国土数値情報N03(東京都)から江東区・江戸川区の境界ポリゴンを抽出して保存
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const URL =
  "https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0010/N03-21_13_210101.json";

const r = await fetch(URL);
console.log("status", r.status);
const gj = await r.json();
console.log("features", gj.features.length);
console.log("sample props", JSON.stringify(gj.features[0].properties));

const WANT = ["江東区", "江戸川区"];
const feats = gj.features.filter((f) => {
  const p = JSON.stringify(f.properties);
  return WANT.some((w) => p.includes(w));
});
console.log("matched features", feats.length);
console.log("matched names", [
  ...new Set(feats.map((f) => f.properties.N03_004)),
]);

writeFileSync(
  join(__dirname, "wards_boundary.json"),
  JSON.stringify({ type: "FeatureCollection", features: feats })
);
console.log("saved wards_boundary.json");
