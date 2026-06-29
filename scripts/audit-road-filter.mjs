// v0.8.9 路線名フィルタが「収録されている全高速」に効くかを実データで監査する。
// 1) 施設のroad付与率（kind別） 2) 路線名インベントリと表記ゆれクラスタ
// 3) 自己整合性: 各施設座標でruntimeのnearestHighwayを再実行し curRoad候補が f.road と一致するか
// 4) 並走/重層ペア: 近接(<300m)で別路線に割り当たった施設の分離可否
import { readFileSync } from "node:fs";

// 路線名正規化（src/roadName.ts と同一）
const ALIASES = [["首都圏中央連絡自動車道", /^(首都圏中央連絡自動車道|圏央道)$/]];
const isRampName = (s) => /(出口|入口|ランプ|ロータリー|バス停)$/.test(s) || s === "ETC専用" || /^[0-9]+$/.test(s);
function canonicalRoad(raw) {
  let s = (raw || "").trim(); if (!s) return "";
  s = s.split(";")[0].trim(); if (!s || isRampName(s)) return "";
  for (const [c, re] of ALIASES) if (re.test(s)) return c;
  return s;
}

const fac = JSON.parse(readFileSync(new URL("../public/highway.json", import.meta.url), "utf8"));
const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));

// --- runtime と同じ前計算（highwayGeom.ts loadHighwayGeom 相当・正規化込み） ---
const roads = [];
for (const r of geom.roads) {
  if (!Array.isArray(r.c) || r.c.length < 2) continue;
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of r.c) {
    if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1];
  }
  roads.push({ name: canonicalRoad(r.name || r.ref), c: r.c, s, w, n, e });
}
const PAD = 0.002;

// runtime highwayGeom.ts nearestHighway を完全移植
function nearestHighway(lat, lng) {
  const mLat = 110540, mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  let bestAll = Infinity, bestNamed = Infinity, bestName = "";
  for (const road of roads) {
    if (lat < road.s - PAD || lat > road.n + PAD || lng < road.w - PAD || lng > road.e + PAD) continue;
    const named = !!road.name;
    const c = road.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mLng, ay = (c[i][0] - lat) * mLat;
      const bx = (c[i + 1][1] - lng) * mLng, by = (c[i + 1][0] - lat) * mLat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx, cy = ay + t * dy, d = Math.hypot(cx, cy);
      if (d < bestAll) bestAll = d;
      if (named && d < bestNamed) { bestNamed = d; bestName = road.name; }
    }
  }
  if (!isFinite(bestAll)) return null;
  return { distM: bestAll, name: bestName, namedDistM: bestNamed };
}

const F = fac.facilities;
console.log(`総施設 ${F.length} / geom路線 ${roads.length}`);

// ===== 1) 付与率（kind別） =====
const byKind = {};
for (const f of F) {
  const k = f.kind || "?";
  byKind[k] = byKind[k] || { total: 0, road: 0 };
  byKind[k].total++; if (f.road) byKind[k].road++;
}
const withRoad = F.filter(f => f.road).length;
console.log(`\n[1] road付与: ${withRoad}/${F.length} (${(withRoad/F.length*100).toFixed(1)}%)  未付与 ${F.length-withRoad}`);
for (const [k, v] of Object.entries(byKind).sort((a,b)=>b[1].total-a[1].total))
  console.log(`   ${k.padEnd(4)} ${String(v.road).padStart(4)}/${String(v.total).padStart(4)} (${(v.road/v.total*100).toFixed(0)}%)`);

// ===== 2) 路線名インベントリ =====
const facRoadNames = {};
for (const f of F) if (f.road) facRoadNames[f.road] = (facRoadNames[f.road]||0)+1;
const distinctFacRoads = Object.keys(facRoadNames);
const namedGeom = roads.filter(r=>r.name);
const geomNameSet = new Set(namedGeom.map(r=>r.name));
console.log(`\n[2] 施設の異なり路線名 ${distinctFacRoads.length}種 / geom名前付き路線 ${namedGeom.length}本(異なり名 ${geomNameSet.size}種) / 無名 ${roads.length-namedGeom.length}本`);

// 施設のroadが geom名集合に存在するか（存在しなければ走行中その名は絶対出ない＝対応不能）
const facRoadNotInGeom = distinctFacRoads.filter(n => !geomNameSet.has(n));
console.log(`   施設roadのうち geom名集合に無い: ${facRoadNotInGeom.length}種 ${facRoadNotInGeom.slice(0,10).join(" / ")||"(なし)"}`);

// ===== 3) 自己整合性（最重要）: 各施設座標で runtime を再実行 =====
// 走行中に「その施設の前を通る」際、curRoad は本線上の自車位置で決まる。
// 近似として施設座標で nearestHighway を実行し、name===f.road かつ namedDistM<80 で「出る」と判定。
let showOK = 0, mismatch = 0, tooFar = 0, noNamed = 0;
const mismatchSamples = [], tooFarSamples = [];
for (const f of F) {
  if (!f.road) continue;
  const s = nearestHighway(f.lat, f.lng);
  if (!s || s.name === "") { noNamed++; continue; }
  if (s.namedDistM >= 80) { tooFar++; if (tooFarSamples.length<12) tooFarSamples.push(`${f.name}[${f.road}] named ${s.namedDistM.toFixed(0)}m`); continue; }
  if (s.name === f.road) showOK++;
  else { mismatch++; if (mismatchSamples.length<15) mismatchSamples.push(`${f.name}: assigned=${f.road} / runtime=${s.name} (${s.namedDistM.toFixed(0)}m)`); }
}
const denom = withRoad;
console.log(`\n[3] 自己整合性（施設座標で走行判定を近似）`);
console.log(`   一致(出る)        ${showOK}/${denom} (${(showOK/denom*100).toFixed(1)}%)`);
console.log(`   路線名くい違い    ${mismatch}  ← 走行中に別名判定されると消える恐れ`);
console.log(`   名前付き>=80m     ${tooFar}  ← 施設座標から本線が遠い(本線上に居れば近いはず。要注意)`);
console.log(`   名前付き無し      ${noNamed}`);
if (mismatchSamples.length) console.log(`   くい違い例:\n     ${mismatchSamples.join("\n     ")}`);
if (tooFarSamples.length) console.log(`   遠い例:\n     ${tooFarSamples.join("\n     ")}`);

// ===== 4) 並走/重層ペア（この機能の対象） =====
// 近接(<300m)で別路線に割り当たった施設ペアを抽出。これらが「分離できている」ことが価値。
function distM(a, b) {
  const mLat = 110540, mLng = 111320 * Math.cos((a.lat*Math.PI)/180);
  return Math.hypot((a.lng-b.lng)*mLng, (a.lat-b.lat)*mLat);
}
const pairs = [];
const fr = F.filter(f=>f.road);
for (let i=0;i<fr.length;i++) for (let j=i+1;j<fr.length;j++) {
  if (Math.abs(fr[i].lat-fr[j].lat)>0.004 || Math.abs(fr[i].lng-fr[j].lng)>0.004) continue;
  if (fr[i].road===fr[j].road) continue;
  const d = distM(fr[i],fr[j]);
  if (d<300) pairs.push({d, a:fr[i], b:fr[j]});
}
pairs.sort((x,y)=>x.d-y.d);
console.log(`\n[4] 近接(<300m)で別路線に割当たった並走/重層ペア: ${pairs.length}組（上位12）`);
for (const p of pairs.slice(0,12))
  console.log(`   ${p.d.toFixed(0).padStart(3)}m  ${p.a.name}[${p.a.road}]  ×  ${p.b.name}[${p.b.road}]`);

// ===== 5) 本線走行シミュレーション（最重要・正規化の効果測定） =====
// 施設のある各路線の本線センターラインを走り、各点で runtime nearestHighway を実行し
// 返値 name が「その本線の路線名」と一致するか集計。Lens1 が指摘した「本線走行時の取り違え」を直接測る。
const roadSet = new Set(fr.map(f=>f.road));
let totPts=0, totHit=0;
const perRoad={};
for (const road of roads) {
  if (!road.name || !roadSet.has(road.name)) continue; // 施設のある路線だけ
  for (const pt of road.c) {
    const s = nearestHighway(pt[0], pt[1]);
    totPts++;
    const ok = s && s.name === road.name;
    if (ok) totHit++;
    const pr = perRoad[road.name] || (perRoad[road.name]={pts:0,hit:0});
    pr.pts++; if (ok) pr.hit++;
  }
}
console.log(`\n[5] 本線走行シミュレーション（施設のある路線の全頂点で curRoad===自路線 を判定）`);
console.log(`   全体一致率 ${(totHit/totPts*100).toFixed(2)}%  (${totHit}/${totPts}点)`);
const worst = Object.entries(perRoad).filter(([,v])=>v.pts>=30).map(([k,v])=>[k,v.hit/v.pts,v.pts]).sort((a,b)=>a[1]-b[1]).slice(0,12);
console.log(`   一致率の低い路線(頂点>=30):`);
for (const [k,r,p] of worst) console.log(`   ${(r*100).toFixed(1).padStart(5)}%  (${p}点)  ${k}`);
// 圏央道(首都圏中央連絡自動車道)を名指し確認
const ken = perRoad["首都圏中央連絡自動車道"];
if (ken) console.log(`   ※圏央道(首都圏中央連絡自動車道): ${(ken.hit/ken.pts*100).toFixed(1)}% (${ken.hit}/${ken.pts}点)`);

// ===== 6) オーファン名（施設0件の路線名）＝curRoadが化けても安全網が働く対象 =====
const namedRoadNames = new Set(roads.filter(r=>r.name).map(r=>r.name));
const orphan = [...namedRoadNames].filter(n=>!roadSet.has(n));
console.log(`\n[6] geom名前付き路線名 ${namedRoadNames.size}種 / 施設あり ${roadSet.size}種 / オーファン(施設0件) ${orphan.length}種`);
console.log(`   → 走行中curRoadがオーファンに化けても useRoad=false で従来コリドーへ（黙って空にしない）`);
