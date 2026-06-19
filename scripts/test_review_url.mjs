// 口コミ直リンクの形式検証（ローカルChromium）
import { chromium } from "playwright";

// テスト対象: 油そば 一心
const name = "油そば 一心";
const lat = 35.6844728,
  lng = 139.9146497;
const pid = "0x6018874b12c7d3bd:0x9f5c9cdb360c3867";

const candidates = {
  A_reviews_data: `https://www.google.com/maps/place/${encodeURIComponent(
    name
  )}/@${lat},${lng},17z/data=!4m8!3m7!1s${pid}!8m2!3d${lat}!4d${lng}!9m1!1b1?hl=ja`,
  B_ftid: `https://www.google.com/maps?ftid=${pid}&hl=ja`,
  C_search: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${pid}`,
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
});

for (const [label, url] of Object.entries(candidates)) {
  const page = await ctx.newPage();
  let info = { label, url, err: null };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);
    info = await page.evaluate(() => {
      const reviewCards = document.querySelectorAll("[data-review-id]").length;
      const txt = document.body.innerText || "";
      const onReviews =
        reviewCards > 0 ||
        /件のクチコミ|クチコミ\s*\d/.test(txt) ||
        (txt.match(/か月前|日前|年前|週間前/g) || []).length >= 3;
      // 店名が出ているか
      const h1 = document.querySelector("h1");
      return {
        reviewCards,
        onReviews,
        title: h1 ? h1.textContent : null,
        href: location.href.slice(0, 90),
      };
    });
    info.label = label;
    info.url = url;
  } catch (e) {
    info.err = e.message;
  }
  console.log(JSON.stringify(info));
  await page.close();
}
await browser.close();
