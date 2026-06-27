// 店名の読み仮名(カタカナ)を kuromoji(形態素解析) で生成し src/data/shops.json に `reading` を付与する。
// 目的: あいまい検索で「漢字店名を読み(かな/ローマ字)で引く」ためのビルド時前処理。
//   例) "武蔵" → reading "ムサシ" を足すと、検索キー(店名+読み+住所+ジャンル)経由で
//       「むさし」「musashi」でヒットするようになる。
// 実行: node scripts/add-readings.mjs   ※ refine.py で shops.json を再生成した「後」に走らせる。
// kuromoji の辞書はビルド時のみ使用（ユーザーには配信しない＝実行時コスト0、データ増は数十KB）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kuromoji from "kuromoji";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOPS = path.join(HERE, "..", "src", "data", "shops.json");
const DICT = path.join(HERE, "..", "node_modules", "kuromoji", "dict");

const tokenizer = await new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath: DICT }).build((err, tk) => (err ? reject(err) : resolve(tk)));
});

/** 文字列の読み(カタカナ)。読み不明なトークンは表層形のまま素通し（部分的でも改善になる）。 */
const readingOf = (text) =>
  tokenizer
    .tokenize(text || "")
    .map((t) => (t.reading && t.reading !== "*" ? t.reading : t.surface_form))
    .join("");

const shops = JSON.parse(fs.readFileSync(SHOPS, "utf8"));
const kanji = /[一-龯]/;
let changed = 0;
let kanjiCovered = 0;
for (const s of shops) {
  const r = readingOf(s.name);
  if (r && r !== s.reading) {
    s.reading = r;
    changed++;
    // 漢字を含む店名のうち、読みに漢字が残らず（=かな化できた）件を「救えた」とカウント
    if (kanji.test(s.name || "") && !kanji.test(r)) kanjiCovered++;
  }
}
// refine.py の json.dump(ensure_ascii=False, indent=1) と同形式で書き戻す（差分最小化）
fs.writeFileSync(SHOPS, JSON.stringify(shops, null, 1), "utf8");

const kanjiTotal = shops.filter((s) => kanji.test(s.name || "")).length;
console.log(`reading付与: ${changed}/${shops.length}件`);
console.log(`漢字店名のかな化: ${kanjiCovered}/${kanjiTotal}件 (${Math.round((kanjiCovered / kanjiTotal) * 100)}%)`);
for (const name of ["武蔵", "一蘭", "千葉家", "油そば 一心", "らーめん勝", "麺屋ばらいち"]) {
  console.log(`  ${name} → ${readingOf(name)}`);
}
