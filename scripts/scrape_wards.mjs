// 江東区・江戸川区（東京）のラーメン店をGoogleマップから収集し、raw_all.json に追記マージする。
// 収集後は scripts/refine.py を実行して src/data/shops.json を再生成すること。
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, "raw_all.json");

// 江東区・江戸川区をカバーする検索中心（密集地のため複数）
const AREAS = [
  [35.667, 139.817, 14, "江東区(門前仲町・東陽町・南砂)"],
  [35.69, 139.823, 14, "江東区北(亀戸・大島・北砂)"],
  [35.66, 139.872, 14, "江戸川区南(葛西・西葛西)"],
  [35.708, 139.868, 14, "江戸川区北(船堀・小岩・一之江)"],
  [35.68, 139.9, 14, "江戸川区東(瑞江・篠崎)"],
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
  const acc = new Map();
  for (const s of JSON.parse(readFileSync(RAW, "utf8"))) acc.set(s.pid, s);
  const before = acc.size;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  for (let i = 0; i < AREAS.length; i++) {
    const [lat, lng, z, label] = AREAS[i];
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
      if (res && res.shops)
        for (const s of res.shops) {
          if (!acc.has(s.pid)) added++;
          acc.set(s.pid, s);
        }
      console.log(
        `[${i + 1}/${AREAS.length}] ${label}: +${added} (raw ${
          res?.count ?? "ERR"
        }) / total ${acc.size}`
      );
    } catch (e) {
      console.log(`[${i + 1}/${AREAS.length}] ${label}: ERROR ${e.message}`);
    }
  }
  await browser.close();

  writeFileSync(RAW, JSON.stringify([...acc.values()], null, 1));
  console.log(
    `\nraw_all.json 更新: ${before} → ${acc.size} 件（+${acc.size - before}）`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
