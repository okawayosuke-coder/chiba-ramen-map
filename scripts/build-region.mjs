// 地方ブロックの高速データ一式を生成するオーケストレータ（全国化・関東版public/直下は不変）。
//
// 使い方:
//   node scripts/build-region.mjs okinawa          # 1地域
//   node scripts/build-region.mjs chubu kinki      # 複数指定
//   node scripts/build-region.mjs all              # 全地域
//
// 地域定義は src/data/hw-regions.json（アプリ側の読込判定と同じファイル＝単一の正）。
// 各地域について public/regions/<key>/ に highways-geom.json / highway.json / surface-geom.json を生成。
// パイプラインは関東版と同一の5本を env(HW_BBOX/HW_TILE/HW_*_FILE) 経由で地域向きに実行する:
//   ① fetch-highway-geom ② fetch-highway ③ assign-facility-roads ④ enrich-highway-amenities ⑤ fetch-surface-geom
// （③を飛ばすとroad欠落で路線フィルタが死ぬ・④を飛ばすと設備が出ない——関東版と同じ罠。UPDATING.md参照）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cfg = JSON.parse(readFileSync(new URL("../src/data/hw-regions.json", import.meta.url), "utf8"));
const args = process.argv.slice(2).filter(Boolean);
if (!args.length) {
  console.error("usage: node scripts/build-region.mjs <regionKey...|all>");
  console.error("regions:", Object.keys(cfg.regions).join(", "));
  process.exit(1);
}
const keys = args.includes("all") ? Object.keys(cfg.regions) : args;

const STEPS = [
  "fetch-highway-geom.mjs",
  "fetch-highway.mjs",
  "assign-facility-roads.mjs",
  "enrich-highway-amenities.mjs",
  "fetch-surface-geom.mjs",
];

for (const key of keys) {
  const rg = cfg.regions[key];
  if (!rg) {
    console.error(`unknown region: ${key} (known: ${Object.keys(cfg.regions).join(", ")})`);
    process.exit(1);
  }
  const dirUrl = new URL(`../public/regions/${key}/`, import.meta.url);
  mkdirSync(dirUrl, { recursive: true });
  const dir = fileURLToPath(dirUrl);
  const env = {
    ...process.env,
    HW_BBOX: rg.bbox.join(","),
    HW_TILE: String(rg.tile || 0.5),
    HW_GEOM_FILE: dir + "highways-geom.json",
    HW_FAC_FILE: dir + "highway.json",
    HW_SURFACE_FILE: dir + "surface-geom.json",
  };
  console.log(`\n██ 地域 ${key} (${rg.label}) bbox=${env.HW_BBOX} tile=${env.HW_TILE} → ${dir}`);
  const t0 = Date.now();
  for (const step of STEPS) {
    console.log(`\n=== [${key}] ${step} ===`);
    execFileSync(process.execPath, [fileURLToPath(new URL(step, import.meta.url))], {
      env,
      stdio: "inherit",
    });
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const sizes = ["highways-geom.json", "highway.json", "surface-geom.json"]
    .map((f) => `${f}=${(statSync(dir + f).size / 1024).toFixed(0)}KB`)
    .join(" / ");
  console.log(`\n██ 地域 ${key} 完了 (${mins}分) ${sizes}`);
}
console.log("\n全地域完了:", keys.join(", "));
