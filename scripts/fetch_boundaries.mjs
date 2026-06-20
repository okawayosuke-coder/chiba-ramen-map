// 江東区・江戸川区（東京都N03）と 千葉県（都道府県N03）の境界を取得して保存
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE =
  "https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0010";
const TOKYO = `${BASE}/N03-21_13_210101.json`; // 東京都(市区町村・詳細)
const CHIBA = `${BASE}/N03-21_12_210101.json`; // 千葉県(市区町村・詳細)
const IBARAKI = `${BASE}/N03-21_08_210101.json`; // 茨城県(市区町村・詳細)

const out = {};

const tk = await (await fetch(TOKYO)).json();
for (const name of ["江東区", "江戸川区"]) {
  const f = tk.features.find((x) => (x.properties.N03_004 || "") === name);
  if (!f) throw new Error("not found: " + name);
  out[name] = f.geometry;
}

const ib = await (await fetch(IBARAKI)).json();
const collect = (names) => {
  const polys = [];
  const found = new Set();
  for (const f of ib.features) {
    const nm = f.properties.N03_004 || "";
    if (!names.includes(nm)) continue;
    found.add(nm);
    const g = f.geometry;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) console.log("⚠ 見つからない市町村:", missing.join(", "));
  return polys;
};

// つくば市（既存・独立region）
out["つくば市"] = { type: "MultiPolygon", coordinates: collect(["つくば市"]) };

// 茨城県南（千葉〜つくばの間：土浦・牛久・守谷・取手 ほか）
const SOUTH = [
  "取手市", "守谷市", "つくばみらい市", "常総市", "龍ケ崎市", "牛久市",
  "阿見町", "土浦市", "利根町", "河内町", "美浦村", "稲敷市",
];
out["茨城県南"] = { type: "MultiPolygon", coordinates: collect(SOUTH) };
console.log("つくば polys", out["つくば市"].coordinates.length, "/ 県南 polys", out["茨城県南"].coordinates.length);

// 千葉県は全市区町村のポリゴンを1つのMultiPolygonに統合（詳細な海岸線で誤除外を防ぐ）
const cb = await (await fetch(CHIBA)).json();
const polys = [];
for (const f of cb.features) {
  const g = f.geometry;
  if (g.type === "Polygon") polys.push(g.coordinates);
  else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
}
out["千葉県"] = { type: "MultiPolygon", coordinates: polys };
console.log("千葉県 市区町村数", cb.features.length, "→ polygons", polys.length);

writeFileSync(join(__dirname, "boundaries.json"), JSON.stringify(out));
console.log(
  "saved boundaries.json:",
  Object.keys(out)
    .map((k) => `${k}(${out[k].type})`)
    .join(", ")
);
