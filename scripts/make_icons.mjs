// PWAアイコンを生成（ローカルChromiumでSVGをPNGにラスタライズ）
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dirname, "..", "public");
mkdirSync(PUB, { recursive: true });

// ラーメン丼アイコン（絵文字非依存・図形のみ。フルブリードでmaskable対応）
const svg = (bleed) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#c92a2a"/>
  ${bleed ? "" : ""}
  <g>
    <!-- 湯気 -->
    <path d="M196 168 q-22 -28 0 -56 q22 -28 0 -56" stroke="#ffd7d7" stroke-width="11" fill="none" stroke-linecap="round" opacity="0.9"/>
    <path d="M256 158 q-22 -28 0 -56 q22 -28 0 -56" stroke="#fff" stroke-width="11" fill="none" stroke-linecap="round" opacity="0.95"/>
    <path d="M316 168 q-22 -28 0 -56 q22 -28 0 -56" stroke="#ffd7d7" stroke-width="11" fill="none" stroke-linecap="round" opacity="0.9"/>
    <!-- 箸 -->
    <g transform="rotate(20 360 240)">
      <rect x="352" y="120" width="13" height="190" rx="6" fill="#ffe8cc"/>
      <rect x="376" y="120" width="13" height="190" rx="6" fill="#ffe8cc"/>
    </g>
    <!-- 丼 -->
    <rect x="92" y="262" width="328" height="26" rx="13" fill="#fff"/>
    <path d="M118 290 a138 130 0 0 0 276 0 Z" fill="#fff"/>
    <path d="M150 300 a106 96 0 0 0 212 0 Z" fill="#ffe3e3"/>
  </g>
</svg>`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 512, height: 512 } });
const page = await ctx.newPage();

async function render(size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;padding:0"><div style="width:${size}px;height:${size}px">${svg(true)
      .replace('width="512"', `width="${size}"`)
      .replace('height="512"', `height="${size}"`)}</div></body></html>`
  );
  const buf = await page.screenshot({ omitBackground: false });
  writeFileSync(join(PUB, file), buf);
  console.log("wrote", file, size);
}

await render(512, "icon-512.png");
await render(192, "icon-192.png");
await render(180, "apple-touch-icon.png");
writeFileSync(join(PUB, "icon.svg"), svg(true));
await browser.close();
console.log("done");
