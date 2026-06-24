// 周辺POI（コンビニ / ガソリンスタンド）を OpenStreetMap(Overpass) から一括収集し、
// public/pois.json に圧縮形式で保存する。アプリはこれを実行時に読み込み、走行中は
// Overpass非依存で「確実な情報」として即時・オフライン表示する。
//
// 範囲: 関東一円（1都6県）をカバーする bbox をタイル分割して収集。
// 実行: node scripts/fetch-pois.mjs   （手動でもCI(月次cron)でも同じ）
//
// 出力フォーマット（サイズ最小化のため配列＋ブランド辞書）:
//   { updatedAt:"YYYY-MM-DD", bbox:[s,w,n,e], cell:0.2,
//     brands:["7-Eleven", ...], pois:[[lat,lng,kindCode,brandIdx], ...] }
//   kindCode: 0=コンビニ(conv) / 1=GS(fuel)
import { writeFile, mkdir } from "node:fs/promises";

// 関東一円をカバーする外接 bbox（南,西,北,東）。多少はみ出しても害はない。
// 環境変数 POI_REGION="s,w,n,e" で範囲を上書き可能（初期生成や部分更新の検証用）。
const DEFAULT_REGION = { s: 34.9, w: 138.4, n: 37.2, e: 140.95 };
const REGION = process.env.POI_REGION
  ? (([s, w, n, e]) => ({ s, w, n, e }))(
      process.env.POI_REGION.split(",").map(Number)
    )
  : DEFAULT_REGION;
const CELL = 0.2; // タイル一辺(度)。約22km。1セルの応答が大きすぎない粒度。
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const CONCURRENCY = 3; // 同時接続数（多すぎると429。3が公共APIへの安全圏）
const REQ_TIMEOUT_MS = 35000; // 1リクエストのクライアント上限（遅いミラーは見切って他へ）
const MAX_RETRY = 4;
const UA =
  "chiba-ramen-map POI updater (personal, https://github.com/okawayosuke-coder/chiba-ramen-map)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kindFromTags(t) {
  if (t.shop === "convenience") return 0; // conv
  if (t.amenity === "fuel") return 1; // fuel
  return -1;
}

// 1タイル分のクエリ。ミラーをローテーションし、タイムアウト＋指数バックオフで再試行。
async function fetchCell(cell, idx, total) {
  const { s, w, n, e } = cell;
  const bbox = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  const q = `[out:json][timeout:90];(nwr["shop"="convenience"](${bbox});nwr["amenity"="fuel"](${bbox}););out center;`;
  const body = "data=" + encodeURIComponent(q);
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const url = ENDPOINTS[(idx + attempt) % ENDPOINTS.length];
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": UA,
        },
        body,
        signal: ac.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      // Overpassはサーバ側タイムアウト/メモリ超過時にHTTP200で部分データ＋remarkを返す。
      // これを成功扱いすると取りこぼしになるため、remarkがあれば失敗として再試行する。
      if (j.remark && /timed out|runtime error|out of memory/i.test(j.remark)) {
        throw new Error(`overpass remark: ${String(j.remark).slice(0, 70)}`);
      }
      const els = j.elements || [];
      console.log(`  [${idx + 1}/${total}] ${bbox} -> ${els.length} (${url.split("/")[2]})`);
      return els;
    } catch (err) {
      clearTimeout(to);
      lastErr = err;
      const wait = 1500 * Math.pow(2, attempt);
      console.warn(`  [${idx + 1}/${total}] ${bbox} attempt ${attempt + 1} failed: ${err.message || err}; retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`cell ${bbox} failed after ${MAX_RETRY} attempts: ${lastErr?.message || lastErr}`);
}

// 簡易並列プール（CONCURRENCY 本で順次消化）。失敗セルは記録して続行。
// seen は呼び出し側から渡して複数パス（失敗タイルの再収集）で蓄積する。
async function runPool(cells, seen) {
  const failed = [];
  let next = 0;
  const total = cells.length;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) break;
      try {
        const els = await fetchCell(cells[i], i, total);
        for (const el of els) {
          const lat = el.lat ?? el.center?.lat;
          const lng = el.lon ?? el.center?.lon;
          if (lat == null || lng == null) continue;
          const t = el.tags || {};
          let k = kindFromTags(t);
          if (k < 0) continue;
          const key = `${el.type}/${el.id}`;
          if (seen.has(key)) continue; // タイル境界の重複を排除
          const rawLabel = t.brand || t.name || t.operator || "";
          // OSMで amenity=fuel に誤タグされた「名称はコンビニ」をコンビニ(0)へ補正
          if (k === 1 && /7-?eleven|seven|セブン|lawson|ローソン|familymart|ファミ|ministop|ミニストップ|デイリーヤマザキ|ポプラ|ニューデイズ|newdays|セイコーマート|seicomart/i.test(rawLabel)) {
            k = 0;
          }
          const label = rawLabel || (k === 0 ? "コンビニ" : "GS");
          seen.set(key, [
            +lat.toFixed(6),
            +lng.toFixed(6),
            k,
            label,
          ]);
        }
      } catch (e) {
        console.error(`  !! ${e.message || e}`);
        failed.push(cells[i]);
      }
      await sleep(150); // 礼儀的な間隔
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { failed };
}

function buildTiles() {
  const cells = [];
  for (let lat = REGION.s; lat < REGION.n; lat += CELL) {
    for (let lng = REGION.w; lng < REGION.e; lng += CELL) {
      cells.push({
        s: +lat.toFixed(4),
        w: +lng.toFixed(4),
        n: +Math.min(lat + CELL, REGION.n).toFixed(4),
        e: +Math.min(lng + CELL, REGION.e).toFixed(4),
      });
    }
  }
  return cells;
}

function jstDate() {
  // JST(UTC+9)の YYYY-MM-DD
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

async function main() {
  const cells = buildTiles();
  console.log(`POI収集: ${cells.length} タイル (cell=${CELL}°), 同時${CONCURRENCY}本`);
  console.log(`範囲 bbox: ${REGION.s},${REGION.w},${REGION.n},${REGION.e}`);
  const t0 = Date.now();
  const seen = new Map(); // "type/id" -> [lat,lng,kindCode,label]（全パスで蓄積）
  // 第1パス＋失敗タイルの再収集パス（最大2回）。Overpassの一時的不調による欠落を埋める。
  let { failed } = await runPool(cells, seen);
  for (let pass = 1; pass <= 2 && failed.length; pass++) {
    console.log(`\n再収集パス ${pass}: 失敗タイル ${failed.length}件を再取得`);
    await sleep(3000);
    ({ failed } = await runPool(failed, seen));
  }
  const rows = [...seen.values()];
  // ブランド辞書化（重複文字列を index 参照に）
  const brandIndex = new Map();
  const brands = [];
  const idxOf = (label) => {
    let i = brandIndex.get(label);
    if (i === undefined) {
      i = brands.length;
      brands.push(label);
      brandIndex.set(label, i);
    }
    return i;
  };
  const pois = rows.map(([lat, lng, k, label]) => [lat, lng, k, idxOf(label)]);
  const convN = pois.filter((p) => p[2] === 0).length;
  const fuelN = pois.filter((p) => p[2] === 1).length;

  const out = {
    updatedAt: jstDate(),
    bbox: [REGION.s, REGION.w, REGION.n, REGION.e],
    cell: CELL,
    brands,
    pois,
  };
  await mkdir(new URL("../public/", import.meta.url), { recursive: true });
  await writeFile(new URL("../public/pois.json", import.meta.url), JSON.stringify(out));

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n完了: ${pois.length}件 (コンビニ${convN} / GS${fuelN}), ブランド${brands.length}種, ${secs}秒`);
  if (failed.length) {
    console.warn(`⚠ 失敗タイル ${failed.length}件（部分欠落の可能性）:`);
    failed.forEach((c) => console.warn(`   ${c.s},${c.w},${c.n},${c.e}`));
    process.exitCode = 0; // 部分成功でも出力は残す（CIは差分で判断）
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
