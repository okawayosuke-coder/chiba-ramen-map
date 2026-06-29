// 各高速施設(IC/SA/PA/JCT)に「どの高速か（路線名）」を付与する。
// public/highways-geom.json のセンターラインに施設をスナップし、最寄り路線名を facility.road に書く。
// 走行中、自車の現在路線名と一致する施設だけをストリップに出す＝並走道路(京葉道路 等)を確実に除外するため。
// 入出力: public/highway.json を読んで road を足して上書き。データ元 OSM(ODbL)。
import { readFileSync, writeFileSync } from "node:fs";

// ── 路線名正規化（src/roadName.ts と同一実装の複製。片方を直したら必ず同期すること）──
const ALIASES = [["首都圏中央連絡自動車道", /^(首都圏中央連絡自動車道|圏央道)$/]];
function isRampName(s) {
  return /(出口|入口|ランプ|ロータリー|バス停)$/.test(s) || s === "ETC専用" || /^[0-9]+$/.test(s);
}
function canonicalRoad(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  s = s.split(";")[0].trim(); // 複合名「本線;支線」→ 本線(先頭)
  if (!s || isRampName(s)) return "";
  for (const [canon, re] of ALIASES) if (re.test(s)) return canon;
  return s;
}

const facFile = new URL("../public/highway.json", import.meta.url);
const geomFile = new URL("../public/highways-geom.json", import.meta.url);
const data = JSON.parse(readFileSync(facFile, "utf8"));
const geom = JSON.parse(readFileSync(geomFile, "utf8"));

// 路線にbbox前計算（runtimeのnearestHighwayと同じプレフィルタ）。名前は canonicalRoad で正規化。
const roads = [];
for (const r of geom.roads) {
  if (!Array.isArray(r.c) || r.c.length < 2) continue;
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of r.c) {
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
  }
  roads.push({ name: canonicalRoad(r.name || r.ref), c: r.c, s, w, n, e });
}

const PAD = 0.003; // 約330m。施設はランプ/エリア中心で本線から100m超のことがあるので広めに
const ASSIGN_MAX_M = 400; // これを超えて遠い施設は road 未設定（不明）

function nearestRoadName(lat, lng) {
  const mLat = 110540, mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity, name = "";
  for (const road of roads) {
    if (lat < road.s - PAD || lat > road.n + PAD || lng < road.w - PAD || lng > road.e + PAD) continue;
    if (!road.name) continue; // 無名linkは路線名判定に使わない（IC/SAは必ず名前付き本線に属す）
    const c = road.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mLng, ay = (c[i][0] - lat) * mLat;
      const bx = (c[i + 1][1] - lng) * mLng, by = (c[i + 1][0] - lat) * mLat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(cx, cy);
      if (d < best) { best = d; name = road.name; }
    }
  }
  return best <= ASSIGN_MAX_M ? name : "";
}

let assigned = 0;
const byRoad = {};
for (const f of data.facilities) {
  const road = nearestRoadName(f.lat, f.lng);
  if (road) {
    f.road = road;
    assigned++;
    byRoad[road] = (byRoad[road] || 0) + 1;
  } else {
    delete f.road;
  }
}
console.log(`路線名を付与: ${assigned}/${data.facilities.length} 施設`);
console.log("路線別(上位15):");
console.log(Object.entries(byRoad).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));

writeFileSync(facFile, JSON.stringify(data));
console.log("saved public/highway.json");
