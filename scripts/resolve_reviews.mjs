// 各店の「口コミ直リンク」を解決して shops.json の reviewsUrl に格納する。
// 手順: ?ftid= で開く → Googleが確定する /maps/place/.../data=...!16s/g/... を取得
//       → data末尾に !9m1!1b1 を付与（口コミタブ直開き）。失敗時は reviewsUrl 未設定（mapsUrlにフォールバック）。
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOPS = join(__dirname, "..", "src", "data", "shops.json");
const CONCURRENCY = 2;
const REQ_DELAY = 1500; // 各リクエスト間の待機(ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shops = JSON.parse(readFileSync(SHOPS, "utf8"));
const todo = shops.filter((s) => s.placeId && !s.reviewsUrl);
console.log(`対象 ${todo.length} / 全 ${shops.length} 店`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  viewport: { width: 1100, height: 800 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
});

let done = 0,
  ok = 0,
  fail = 0,
  blocked = 0;

async function resolveOne(shop) {
  const page = await ctx.newPage();
  try {
    await page.goto(
      `https://www.google.com/maps?ftid=${shop.placeId}&hl=ja`,
      { waitUntil: "domcontentloaded", timeout: 40000 }
    );
    // /maps/place/.../data=...!16s が出るまで待つ
    let url = "";
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(700);
      url = page.url();
      if (/\/maps\/place\/.+\/data=.*!16s/.test(url)) break;
      if (/\/sorry\/|consent\.google/.test(url)) {
        blocked++;
        await sleep(45000); // ブロック検知時はバックオフ
        return;
      }
    }
    const m = url.match(/\/data=([^?]*)/);
    if (!m || !m[1].includes("!16s")) {
      fail++;
      return;
    }
    const base = url.split("?")[0]; // @latlng と /data=blob を含む
    shop.reviewsUrl = base + "!9m1!1b1?hl=ja";
    ok++;
  } catch {
    fail++;
  } finally {
    done++;
    await page.close();
  }
}

// 簡易並列プール
let idx = 0;
async function worker() {
  while (idx < todo.length) {
    const my = todo[idx++];
    await resolveOne(my);
    await sleep(REQ_DELAY);
    if (done % 20 === 0) {
      writeFileSync(SHOPS, JSON.stringify(shops, null, 1));
      console.log(`progress ${done}/${todo.length} ok=${ok} fail=${fail} blocked=${blocked}`);
    }
    if (blocked > 40) {
      console.log("⚠ ブロック多発のため中断（部分保存済み）");
      idx = todo.length;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

writeFileSync(SHOPS, JSON.stringify(shops, null, 1));
await browser.close();
console.log(`\n完了: ok=${ok} fail=${fail} blocked=${blocked} / reviewsUrl保持 ${shops.filter((s) => s.reviewsUrl).length}店`);
