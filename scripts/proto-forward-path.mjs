// 試作: 高速センターラインを「前方へ辿った経路」を作り、その経路に沿って施設を出す。
// 路線名境界(東関東道→湾岸線)を越えて連続し、並走道路(京葉)は経路から外れるので除外されることを検証。
import { readFileSync } from "node:fs";
const fac = JSON.parse(readFileSync(new URL("../public/highway.json", import.meta.url), "utf8"));
const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));

const toRad = (d) => (d * Math.PI) / 180;
const mPerLat = 110540;
const mPerLng = (lat) => 111320 * Math.cos(toRad(lat));

// ways（端点インデックス付き）。座標は[lat,lng]。
const ways = geom.roads.filter((r) => Array.isArray(r.c) && r.c.length >= 2).map((r, i) => ({ id: i, name: (r.name || r.ref || "").trim(), c: r.c }));
// 端点インデックス: 5桁丸めキー → そのキーに端点(始点/終点)を持つ way の {id, end:'s'|'e'}
const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`; // 4桁≒11m許容で細切れwayの端点を接続
const endIndex = new Map();
for (const w of ways) {
  for (const [p, end] of [[w.c[0], "s"], [w.c[w.c.length - 1], "e"]]) {
    const k = key(p);
    if (!endIndex.has(k)) endIndex.set(k, []);
    endIndex.get(k).push({ id: w.id, end });
  }
}

// 区間方位(度, 真北0時計回り)
function segBearing(a, b) {
  const x = (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2);
  const y = (b[0] - a[0]) * mPerLat;
  return (Math.atan2(x, y) * 180) / Math.PI;
}
function angDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

// 現在地に最も近いway上の点を探す。JCT等で複数の道が重なる場合は、最寄り+15m以内の候補のうち
// 「区間方位が進行方位に最も合う道」を選ぶ（実際に走っている本線を拾う）。forward向きも決める。
function snapToWay(lat, lng, headingDeg) {
  const all = [];
  for (const w of ways) {
    const c = w.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mPerLng(lat), ay = (c[i][0] - lat) * mPerLat;
      const bx = (c[i + 1][1] - lng) * mPerLng(lat), by = (c[i + 1][0] - lat) * mPerLat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      all.push({ d, w, i, t });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => a.d - b.d);
  const near = all.filter((x) => x.d <= all[0].d + 15);
  // 進行方位に最も合う区間を選ぶ（双方向のうち近い方の差で評価）
  let best = near[0], bestAlign = 999;
  for (const x of near) {
    const fb = segBearing(x.w.c[x.i], x.w.c[x.i + 1]);
    const align = Math.min(angDiff(fb, headingDeg), angDiff((fb + 180) % 360, headingDeg));
    if (align < bestAlign) { bestAlign = align; best = x; }
  }
  const fb = segBearing(best.w.c[best.i], best.w.c[best.i + 1]);
  const forward = angDiff(fb, headingDeg) <= 90;
  return { ...best, forward };
}

// 前方経路を構築（最大 maxKm、ジャンクションでは最も直進=方位差最小の連続wayへ。訪問済みは回避）
function buildForwardPath(lat, lng, headingDeg, maxKm) {
  const snap = snapToWay(lat, lng, headingDeg);
  if (!snap) return null;
  const path = []; // {lat,lng,dist(km)}
  let acc = 0;
  // 起点 = 現在地のway上スナップ点
  const c0 = snap.w.c[snap.i], c1 = snap.w.c[snap.i + 1];
  const sp = [c0[0] + (c1[0] - c0[0]) * snap.t, c0[1] + (c1[1] - c0[1]) * snap.t];
  path.push({ lat: sp[0], lng: sp[1], dist: 0 });
  const visited = new Set();
  let curWay = snap.w, idx = snap.i, fwd = snap.forward, lastDir = headingDeg;
  // 現在wayの残り頂点を進む関数
  const hav = (a, b) => { const dx = (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2), dy = (b[0] - a[0]) * mPerLat; return Math.hypot(dx, dy) / 1000; };
  let guard = 0;
  while (acc < maxKm && guard++ < 400) {
    visited.add(curWay.id);
    const c = curWay.c;
    // 進む頂点列（fwdなら idx+1..end、!fwdなら idx..0）
    const seq = [];
    if (fwd) for (let j = idx + 1; j < c.length; j++) seq.push(c[j]);
    else for (let j = idx; j >= 0; j--) seq.push(c[j]);
    let prev = path[path.length - 1];
    for (const v of seq) {
      const dd = hav([prev.lat, prev.lng], v);
      acc += dd;
      path.push({ lat: v[0], lng: v[1], dist: acc });
      prev = path[path.length - 1];
      if (acc >= maxKm) break;
    }
    if (acc >= maxKm) break;
    // 端点で次のwayへ
    const endPt = fwd ? c[c.length - 1] : c[0];
    lastDir = path.length >= 2 ? segBearing([path[path.length - 2].lat, path[path.length - 2].lng], [endPt[0], endPt[1]]) : lastDir;
    const cands = (endIndex.get(key(endPt)) || []).filter((e) => !visited.has(e.id));
    if (!cands.length) break;
    // 各候補の「出ていく方位」を計算し、lastDir に最も近い(=直進)を選ぶ
    let pick = null;
    for (const e of cands) {
      const w2 = ways[e.id];
      const a = e.end === "s" ? w2.c[0] : w2.c[w2.c.length - 1];
      const b = e.end === "s" ? w2.c[1] : w2.c[w2.c.length - 2];
      const outDir = segBearing(a, b);
      const turn = angDiff(outDir, lastDir);
      if (turn > 100) continue; // 逆戻り/急折れは除外
      // 同名(本線継続)を強く優先＝JCTで分岐路でなく本線を辿る。次いで直進(turn小)。
      const score = turn - (w2.name && curWay.name && w2.name.split(";")[0] === curWay.name.split(";")[0] ? 70 : 0);
      if (!pick || score < pick.score) pick = { e, w2, score, fromStart: e.end === "s" };
    }
    if (!pick) break;
    curWay = pick.w2;
    fwd = pick.fromStart; // start から入る＝fwd
    idx = pick.fromStart ? 0 : curWay.c.length - 1;
  }
  return path;
}

// 施設を経路へ投影: 経路上の最寄り点の沿道距離(km)＋横距離(m)
function projectFacility(path, f) {
  let best = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const ax = (a.lng - f.lng) * mPerLng(f.lat), ay = (a.lat - f.lat) * mPerLat;
    const bx = (b.lng - f.lng) * mPerLng(f.lat), by = (b.lat - f.lat) * mPerLat;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const latM = Math.hypot(ax + t * dx, ay + t * dy);
    const along = a.dist + (b.dist - a.dist) * t;
    if (!best || latM < best.latM) best = { latM, along };
  }
  return best;
}

const F = fac.facilities;
const MAXKM = 25, LOOK = 6, LATERAL_M = 250;
function run(label, lat, lng, hd) {
  const path = buildForwardPath(lat, lng, hd, MAXKM);
  console.log(`\n=== ${label} @${lat.toFixed(4)},${lng.toFixed(4)} hd=${hd}° ===`);
  if (!path) { console.log("  経路構築失敗"); return; }
  console.log(`  前方経路: ${path.length}点 / ${path[path.length - 1].dist.toFixed(1)}km`);
  const cands = [];
  for (const f of F) {
    const pr = projectFacility(path, f);
    if (pr && pr.latM <= LATERAL_M && pr.along > 0.05) cands.push({ n: f.name, road: f.road || "-", along: +pr.along.toFixed(2), lat: Math.round(pr.latM) });
  }
  cands.sort((a, b) => a.along - b.along);
  for (const c of cands.slice(0, LOOK)) console.log(`   ${c.along}km  ${c.n} [${c.road}] 横${c.lat}m`);
  const keiyo = cands.filter(c => c.road === "京葉道路").length;
  console.log(`  → 京葉道路の混入: ${keiyo}件`);
}

// ① 東関東道を西進・葛西手前(湾岸市川あたり)。湾岸線連続施設が出るか
run("①東関東道→葛西(連続)", 35.6850, 139.9700, 250);
// ② 京葉道路を西進(東関東道と並走する区間, 幕張付近・実頂点)。京葉施設のみ・東関東除外
run("②京葉道路 西進(並走)", 35.67054, 140.05815, 255);
// ③ 湾岸線・葛西の手前(東側,明確に湾岸線上) 西進。葛西JCTを越えて新木場/有明へ続くか
run("③湾岸線 葛西手前 西進", 35.6403, 139.8912, 270);
// ④ 葛西JCT直上 西進（最難）
run("④湾岸線 葛西JCT直上 西進", 35.6466, 139.8564, 273);
// ⑤ 東関東道を西進・京葉道路が並走する区間(湾岸習志野付近)。京葉を拾わないか(回帰ガード)
run("⑤東関東道 西進(京葉並走・回帰ガード)", 35.6650, 140.0181, 250);
