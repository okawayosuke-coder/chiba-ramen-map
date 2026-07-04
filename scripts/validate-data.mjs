// バンドルデータの必須不変条件を検査し、違反があればビルドを失敗させる（exit 1）。
// package.json の "prebuild" から呼ばれ、ローカル・CIの両方で `npm run build` 前に自動実行される。
// 目的: 「ビルド/型は通るが機能が静かに壊れる」データ事故（例: highway.json 再生成で
//   assign-facility-roads.mjs を飛ばし road が全欠落→路線フィルタ全無効）を本番前に自動で弾く。
// 閾値は現状値より十分低い保守的な床値＝正常な増減では鳴らず、ステップ抜け/ファイル破損だけを検知する。
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const load = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));

const results = [];
const ok = (label, detail = "") => results.push({ pass: true, label, detail });
const fail = (label, detail = "") => results.push({ pass: false, label, detail });
/** cond が真なら pass、偽なら fail として記録 */
const check = (cond, label, detail = "") => (cond ? ok(label, detail) : fail(label, detail));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function safe(name, fn) {
  try {
    fn();
  } catch (e) {
    fail(`${name} 読込/検査`, e.message);
  }
}

// ===== highway.json（施設: fetch-highway → assign-facility-roads → enrich の3本必須）=====
safe("highway.json", () => {
  const f = load("public/highway.json").facilities;
  check(Array.isArray(f) && f.length >= 1000, "highway.json 施設件数≥1000", `= ${f?.length}`);
  const coord = f.filter((x) => x.lat != null && x.lng != null && x.kind && x.name).length;
  check(coord === f.length, "highway.json 全施設に lat/lng/kind/name", `${coord}/${f.length}`);
  const road = f.filter((x) => x.road).length;
  // ★assign-facility-roads.mjs を飛ばすと road=0 になる（路線フィルタ全無効の静かな事故）
  check(pct(road, f.length) >= 60, "highway.json road付与率≥60%（assign-facility-roads実行の証跡）", `${road}/${f.length} = ${pct(road, f.length)}%`);
  const amen = f.filter((x) => Array.isArray(x.amenities) && x.amenities.length).length;
  // ★enrich-highway-amenities.mjs を飛ばすと amenities=0（SA/PA設備アイコンが消える）
  check(amen >= 100, "highway.json 設備付与施設≥100（enrich-highway-amenities実行の証跡）", `= ${amen}`);
  const icjct = f.filter((x) => x.kind === "ic" || x.kind === "jct");
  const toward = icjct.filter((x) => Array.isArray(x.toward) && x.toward.length).length;
  // ★fetch-highway.mjs の motorway_link(destination)取得/紐付けが壊れると toward が全欠落する。
  //   OSMのdestinationタグ網羅率はroad(60%)ほど高くないため床値は低め（実測約28%の半分程度）。
  check(pct(toward, icjct.length) >= 12, "highway.json IC/JCTのtoward付与率≥12%（方面データ取得の証跡）", `${toward}/${icjct.length} = ${pct(toward, icjct.length)}%`);
  const badToward = f.filter((x) => Array.isArray(x.toward) && x.kind !== "ic" && x.kind !== "jct").length;
  check(badToward === 0, "highway.json toward はIC/JCT以外に付与されていない", `= ${badToward}`);
});

// ===== shops.json（refine.py → add-readings.mjs。reading はかな検索に必須）=====
safe("shops.json", () => {
  const raw = load("src/data/shops.json");
  const s = Array.isArray(raw) ? raw : raw.shops || [];
  check(s.length >= 1000, "shops.json 件数≥1000", `= ${s.length}`);
  const reading = s.filter((x) => x.reading).length;
  // ★add-readings.mjs を飛ばすと reading が欠落→漢字店名のかな検索が静かに死ぬ
  check(pct(reading, s.length) >= 95, "shops.json reading付与率≥95%（add-readings実行の証跡）", `${reading}/${s.length} = ${pct(reading, s.length)}%`);
  const region = s.filter((x) => x.region).length;
  check(pct(region, s.length) >= 95, "shops.json region付与率≥95%（エリア絞り込み用）", `${region}/${s.length} = ${pct(region, s.length)}%`);
  const core = s.filter((x) => x.name && x.rating != null).length;
  check(core === s.length, "shops.json 全店に name/rating", `${core}/${s.length}`);
});

// ===== pois.json（fetch-pois.mjs。コンビニ/GSの同梱データ）=====
safe("pois.json", () => {
  const j = load("public/pois.json");
  const pts = Array.isArray(j.pois) ? j.pois : [];
  check(pts.length >= 10000, "pois.json POI件数≥10000", `= ${pts.length}`);
  check(Array.isArray(j.brands) && j.brands.length > 0, "pois.json brands辞書あり", `= ${j.brands?.length}`);
});

// ===== highways-geom.json（fetch-highway-geom.mjs。高速センターライン）=====
safe("highways-geom.json", () => {
  const r = load("public/highways-geom.json").roads;
  check(Array.isArray(r) && r.length >= 5000, "highways-geom.json 路線数≥5000", `= ${r?.length}`);
  const badC = r.filter((x) => !Array.isArray(x.c) || x.c.length < 2).length;
  check(badC === 0, "highways-geom.json 全路線に有効な点列(c≥2)", `不正 ${badC}件`);
});

// ===== surface-geom.json（fetch-surface-geom.mjs。357型の高速誤認抑制用）=====
safe("surface-geom.json", () => {
  const r = load("public/surface-geom.json").roads;
  check(Array.isArray(r) && r.length >= 1000, "surface-geom.json 路線数≥1000", `= ${r?.length}`);
});

// ===== 地方ブロック（全国化: scripts/build-region.mjs 生成。存在するブロックだけ検査＝段階的追加OK）=====
// ブロックは3ファイル揃って初めて機能する（欠けるとアプリのensureRegionsが毎回404で全滅扱いになる）。
// 床値は最小地域(沖縄=roads552/施設50/road94%/surface271)より十分低い汎用値。
{
  const dirUrl = new URL("public/regions/", root);
  if (!existsSync(dirUrl)) {
    ok("regions/ 未生成（全国ブロックなし＝関東のみ運用）");
  } else {
    const cfg = load("src/data/hw-regions.json");
    for (const key of readdirSync(dirUrl).filter((d) => !d.startsWith("."))) {
      // 地域ごとに独立検査（1地域の生成途中/破損が他地域の検査を隠さないように）
      safe(`regions/${key}`, () => {
        check(!!cfg.regions[key], `regions/${key} が hw-regions.json に定義済み`);
        const g = load(`public/regions/${key}/highways-geom.json`);
        check(Array.isArray(g.roads) && g.roads.length >= 50, `regions/${key} geom路線数≥50`, `= ${g.roads?.length}`);
        const f = load(`public/regions/${key}/highway.json`).facilities;
        check(Array.isArray(f) && f.length >= 8, `regions/${key} 施設数≥8`, `= ${f?.length}`);
        const road = f.filter((x) => x.road).length;
        check(pct(road, f.length) >= 40, `regions/${key} road付与率≥40%（assign実行の証跡）`, `${road}/${f.length} = ${pct(road, f.length)}%`);
        const s = load(`public/regions/${key}/surface-geom.json`);
        check(Array.isArray(s.roads) && s.roads.length >= 10, `regions/${key} surface路線数≥10`, `= ${s.roads?.length}`);
      });
    }
  }
}

// ===== muni.json（fetch_muni.mjs。逆ジオの muniCd→市区町村）=====
safe("muni.json", () => {
  const m = load("src/data/muni.json");
  const n = Object.keys(m).length;
  check(n >= 1000, "muni.json エントリ数≥1000", `= ${n}`);
});

// ===== 結果出力 =====
const fails = results.filter((r) => !r.pass);
console.log("── データ検証 (validate-data.mjs) ──");
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.label}${r.detail ? "  [" + r.detail + "]" : ""}`);
if (fails.length) {
  console.error(`\n❌ データ検証に失敗: ${fails.length}件。壊れたデータのビルド/デプロイを中止します。`);
  console.error("   再生成手順は scripts/UPDATING.md を参照（highway.json は fetch-highway→assign-facility-roads→enrich の3本必須）。");
  process.exit(1);
}
console.log(`✅ データ検証OK（${results.length}項目）`);
