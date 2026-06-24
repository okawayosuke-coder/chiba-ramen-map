// 同梱 public/pois.json の網羅性を検証する。
// 各タイルについて、ライブOverpassの実数(out count)と同梱データの件数を突き合わせ、
// 取りこぼし（同梱が実数より明らかに少ないタイル）を洗い出す。
// 実行: node scripts/verify-pois.mjs            （全カバレッジを検証）
//       node scripts/verify-pois.mjs 35.3,139.8,36.0,140.6  （範囲を限定して検証）
import { readFile } from "node:fs/promises";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const CONCURRENCY = 3;
const REQ_TIMEOUT_MS = 30000;
const MAX_RETRY = 4;
const UA = "chiba-ramen-map POI verifier (personal)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(
  await readFile(new URL("../public/pois.json", import.meta.url))
);
const CELL = data.cell || 0.2;
let region = { s: data.bbox[0], w: data.bbox[1], n: data.bbox[2], e: data.bbox[3] };
if (process.argv[2]) {
  const [s, w, n, e] = process.argv[2].split(",").map(Number);
  region = { s, w, n, e };
}

// 同梱データを 0.2°グリッド(データのbbox原点基準)でバケット集計
const originS = data.bbox[0];
const originW = data.bbox[1];
const cellKey = (lat, lng) =>
  `${Math.floor((lat - originS) / CELL)},${Math.floor((lng - originW) / CELL)}`;
const bundled = new Map();
for (const [lat, lng] of data.pois) {
  const k = cellKey(lat, lng);
  bundled.set(k, (bundled.get(k) || 0) + 1);
}

function buildTiles() {
  const cells = [];
  for (let lat = region.s; lat < region.n - 1e-9; lat += CELL) {
    for (let lng = region.w; lng < region.e - 1e-9; lng += CELL) {
      cells.push({
        s: +lat.toFixed(4),
        w: +lng.toFixed(4),
        n: +Math.min(lat + CELL, region.n).toFixed(4),
        e: +Math.min(lng + CELL, region.e).toFixed(4),
      });
    }
  }
  return cells;
}

async function liveCount(cell, idx) {
  const bbox = `${cell.s},${cell.w},${cell.n},${cell.e}`;
  const q = `[out:json][timeout:60];(nwr["shop"="convenience"](${bbox});nwr["amenity"="fuel"](${bbox}););out count;`;
  for (let a = 0; a < MAX_RETRY; a++) {
    const url = ENDPOINTS[(idx + a) % ENDPOINTS.length];
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
        body: "data=" + encodeURIComponent(q),
        signal: ac.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Number(j.elements?.[0]?.tags?.total ?? 0);
    } catch (e) {
      clearTimeout(to);
      if (a === MAX_RETRY - 1) return null; // 検証不能
      await sleep(1200 * Math.pow(2, a));
    }
  }
  return null;
}

const cells = buildTiles();
console.log(`検証: ${cells.length}タイル (cell=${CELL}°) を実数と突き合わせ`);
const gaps = [];
const unverifiable = [];
let totLive = 0,
  totBundled = 0;
let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= cells.length) break;
    const c = cells[i];
    const live = await liveCount(c, i);
    const k = cellKey(c.s + CELL / 2, c.w + CELL / 2);
    const have = bundled.get(k) || 0;
    if (live == null) {
      unverifiable.push(c);
    } else {
      totLive += live;
      totBundled += have;
      // 実数より15件以上かつ15%以上少ないタイルを「取りこぼし」とみなす
      if (live - have >= 15 && have < live * 0.85) {
        gaps.push({ bbox: `${c.s},${c.w},${c.n},${c.e}`, live, have, miss: live - have });
      }
    }
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

gaps.sort((a, b) => b.miss - a.miss);
console.log(`\n=== 結果 ===`);
console.log(`合計: 実数(ライブ) ${totLive} / 同梱 ${totBundled} (差 ${totLive - totBundled})`);
console.log(`取りこぼしタイル: ${gaps.length}件`);
for (const g of gaps) console.log(`  ${g.bbox}  実数${g.live} / 同梱${g.have}  (不足${g.miss})`);
if (unverifiable.length) {
  console.log(`\n検証不能(Overpass失敗) ${unverifiable.length}件:`);
  for (const c of unverifiable) console.log(`  ${c.s},${c.w},${c.n},${c.e}`);
}
