// 国土地理院 muni.js（市区町村コード→名称）を取得し、コンパクトなJSONへ変換する。
// 逆ジオコーダ LonLatToAddress が返す muniCd を「都道府県+市区町村」名に変換するための辞書。
// 注意: 逆ジオコーダは pref<10 を先頭ゼロ付き5桁("08203")で返すが、muni.js のキーは
//       先頭ゼロ無し("8203")。利用側で parseInt 正規化して照合する（本JSONは muni.js の生キー）。
import { writeFile, mkdir } from "node:fs/promises";

const SRC = "https://maps.gsi.go.jp/js/muni.js";

const res = await fetch(SRC);
if (!res.ok) throw new Error(`muni.js fetch failed: ${res.status}`);
const js = await res.text();

// 行例: GSI.MUNI_ARRAY["12212"] = '12,千葉県,12212,佐倉市';
const re = /GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']*)'/g;
const out = {};
let m;
let count = 0;
while ((m = re.exec(js)) !== null) {
  const key = m[1];
  const parts = m[2].split(",");
  if (parts.length < 4) continue;
  const prefName = parts[1].trim();
  // 政令市の区などは "千葉市　緑区" のように全角スペースを含む → 除去
  const muniName = parts[3].replace(/　/g, "").trim();
  if (!prefName || !muniName) continue;
  out[key] = prefName + muniName;
  count++;
}

await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../src/data/muni.json", import.meta.url),
  JSON.stringify(out)
);
console.log(`muni.json written: ${count} entries`);
