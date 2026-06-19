// 千葉県全域のラーメン店をGoogleマップから収集（ローカルChromium / Playwright）
// 既存のCowork版 extract_script.js のDOM抽出ロジックを踏襲。
// 使い方: node scripts/scrape.mjs [--headful] [--limit N]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const HEADFUL = argv.includes("--headful");
const limArg = argv.indexOf("--limit");
const LIMIT = limArg >= 0 ? Number(argv[limArg + 1]) : Infinity;

// 千葉県全域をタイル状にカバーする検索中心（lat,lng,zoom,ラベル）
const AREAS = [
  [35.61, 140.11, 13, "千葉市中心"],
  [35.64, 140.06, 13, "稲毛・幕張"],
  [35.5, 140.1, 13, "市原・五井"],
  [35.79, 139.9, 13, "松戸"],
  [35.86, 139.97, 13, "柏・我孫子"],
  [35.93, 139.88, 13, "流山・野田"],
  [35.78, 140.02, 13, "鎌ケ谷・白井"],
  [35.72, 139.93, 13, "市川・浦安"],
  [35.7, 139.98, 13, "船橋"],
  [35.68, 140.04, 13, "習志野・八千代"],
  [35.71, 140.22, 13, "佐倉・四街道"],
  [35.83, 140.14, 13, "印西・白井北"],
  [35.78, 140.32, 12, "成田・富里"],
  [35.73, 140.65, 12, "銚子・旭"],
  [35.66, 140.5, 12, "匝瑳・横芝・八日市場"],
  [35.56, 140.37, 12, "東金・山武"],
  [35.43, 140.32, 12, "茂原・一宮"],
  [35.38, 139.93, 12, "木更津・君津・袖ケ浦"],
  [35.25, 139.86, 12, "富津・鋸南"],
  [34.99, 139.87, 12, "館山・南房総"],
  [35.11, 140.1, 12, "鴨川・勝浦・いすみ"],
];

const SCRAPE = async () => {
  const feed = document.querySelector('[role="feed"]');
  if (!feed) return { error: "no feed" };
  let prevH = 0,
    stable = 0;
  for (let i = 0; i < 24; i++) {
    feed.scrollTo(0, feed.scrollHeight);
    await new Promise((r) => setTimeout(r, 900));
    if (feed.innerText.includes("リストの結果は以上です")) break;
    if (feed.scrollHeight === prevH) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      prevH = feed.scrollHeight;
    }
  }
  const links = [...document.querySelectorAll('a[href*="/maps/place"]')];
  const shops = [];
  const seen = new Set();
  for (const a of links) {
    const name = a.getAttribute("aria-label");
    if (!name) continue;
    const href = a.href;
    const pidM = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/);
    const pid = pidM ? pidM[1] : null;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    let card = a.parentElement,
      ct = "";
    for (let j = 0; j < 6; j++) {
      if (!card) break;
      ct = card.innerText || "";
      if (
        ct.includes(name) &&
        /\d+\.\d+\s*\(\s*[\d,]+\s*\)/.test(ct) &&
        ct.length < 2000
      )
        break;
      card = card.parentElement;
    }
    const ni = ct.indexOf(name);
    const af = ni >= 0 ? ct.slice(ni) : ct;
    const m = af.match(/(\d+\.\d+)\s*\(\s*([\d,]+)\s*\)/);
    const r = m ? parseFloat(m[1]) : null;
    const c = m ? parseInt(m[2].replace(/,/g, ""), 10) : null;
    const ll = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const lat = ll ? parseFloat(ll[1]) : null;
    const lng = ll ? parseFloat(ll[2]) : null;
    let address = null,
      genre = null;
    for (const line of af.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (/\d+\.\d+\s*\(/.test(line)) continue;
      if (line.includes(" · ")) {
        const p = line.split(" · ").map((s) => s.trim());
        genre = p[0] || null;
        address = p[p.length - 1] || null;
        break;
      }
    }
    shops.push({ n: name, r, c, lat, lng, pid, g: genre, a: address });
  }
  return { count: shops.length, shops };
};

async function main() {
  const browser = await chromium.launch({ headless: !HEADFUL });
  const ctx = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  const acc = new Map();

  const areas = AREAS.slice(0, LIMIT === Infinity ? AREAS.length : LIMIT);
  for (let i = 0; i < areas.length; i++) {
    const [lat, lng, z, label] = areas[i];
    const url = `https://www.google.com/maps/search/${encodeURIComponent(
      "ラーメン"
    )}/@${lat},${lng},${z}z?hl=ja`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page
        .waitForSelector('a[href*="/maps/place"]', { timeout: 20000 })
        .catch(() => {});
      const res = await page.evaluate(SCRAPE);
      let added = 0;
      if (res && res.shops) {
        for (const s of res.shops) {
          if (!acc.has(s.pid)) added++;
          acc.set(s.pid, s);
        }
      }
      console.log(
        `[${i + 1}/${areas.length}] ${label}: +${added} (raw ${
          res?.count ?? "ERR"
        }) / total ${acc.size}`
      );
    } catch (e) {
      console.log(`[${i + 1}/${areas.length}] ${label}: ERROR ${e.message}`);
    }
  }
  await browser.close();

  const raw = [...acc.values()];
  writeFileSync(
    join(__dirname, "raw_all.json"),
    JSON.stringify(raw, null, 1)
  );

  // フィルタ: Google評価3.9以上・口コミ50件以上、座標あり
  const filtered = raw
    .filter(
      (s) =>
        s.lat != null &&
        s.lng != null &&
        s.r != null &&
        s.c != null &&
        s.r >= 3.9 &&
        s.c >= 50
    )
    .map((s) => {
      // ftid形式: feature ID で正確な店舗ページを開く（口コミ読込済みで着地。検証済み）
      const url = s.pid
        ? `https://www.google.com/maps?ftid=${s.pid}&hl=ja`
        : `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
      return {
        name: s.n,
        rating: s.r,
        reviews: s.c,
        lat: s.lat,
        lng: s.lng,
        genre: s.g || "ラーメン",
        address: s.a || "",
        placeId: s.pid,
        mapsUrl: url,
      };
    })
    .sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);

  writeFileSync(
    join(__dirname, "..", "src", "data", "shops.json"),
    JSON.stringify(filtered, null, 1)
  );
  console.log(
    `\n収集完了: 生${raw.length}件 → 条件適合 ${filtered.length}件 を src/data/shops.json に書き出し`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
