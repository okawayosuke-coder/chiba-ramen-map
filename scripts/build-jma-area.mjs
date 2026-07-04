// 気象庁 area.json から「JIS5市区町村コード → 予報区(office) / 一次細分区(class10)」のマップを生成する。
//
// なぜ必要か: 天気の主系(Open-Meteo)が落ちた時のフォールバックに気象庁の予報JSON
//   (https://www.jma.go.jp/bosai/forecast/data/forecast/<office>.json) を使う。
//   このJSONのファイル名は「予報区(office)コード」だが、アプリが現在地から得られるのは
//   GSI逆ジオが返す muniCd(先頭ゼロ無しのJIS5コード。例: 佐倉市=12212) だけ。
//   その橋渡しに muniCd → office のマップが要る。
//
// 気象庁の階層: class20(市区町村・7桁) → class15 → class10(一次細分区=北西部等) → office(県)
//   class20の7桁コードは「JIS5コード + 細分2桁」なので /100 で JIS5 に落ちる。
//   検証済み: 全国1756件で JIS5→office の衝突は0(同一市区町村は必ず同一予報区)。
//
// 予報区は基本的に不変なので、このスクリプトは手動実行でよい(年1回程度で十分)。
// 出力: src/data/jma-area.json

import { writeFileSync } from "node:fs";

const AREA_URL = "https://www.jma.go.jp/bosai/common/const/area.json";

const res = await fetch(AREA_URL);
if (!res.ok) throw new Error(`area.json取得失敗: HTTP ${res.status}`);
const a = await res.json();

const office = {}; // jis5 -> office code(forecast JSONのファイル名)
const area10 = {}; // jis5 -> class10 code(一次細分区・短期予報のエリア選択に使う)
const name = {}; //   office code -> 予報区名(出典・地点名の補助)

for (const [c20, v] of Object.entries(a.class20s)) {
  const jis = String(Math.floor(parseInt(c20, 10) / 100)); // 気象庁7桁 → JIS5相当(先頭ゼロ無し)
  const c15 = a.class15s[v.parent];
  if (!c15) continue;
  const c10code = c15.parent;
  const c10 = a.class10s[c10code];
  if (!c10) continue;
  office[jis] = c10.parent;
  area10[jis] = c10code;
}
for (const [code, v] of Object.entries(a.offices)) name[code] = v.name;

const out = { office, area10, name };
writeFileSync(new URL("../src/data/jma-area.json", import.meta.url), JSON.stringify(out));
console.log(
  `jma-area.json 生成: office ${Object.keys(office).length}件 / area10 ${Object.keys(area10).length}件 / name ${Object.keys(name).length}件`
);
