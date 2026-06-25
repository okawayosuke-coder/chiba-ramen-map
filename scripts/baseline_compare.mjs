// 勾配の「前方基準距離」比較。鹿野山の実ルート上の各地点で、前方80/100/150mの
// 標高差から勾配を計算し、なまり具合(区間平均)の違いを実データで比較する。
const BASES_M = [80, 100, 150];

function haversineKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function gsiElev(lat, lng) {
  const r = await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`);
  const j = await r.json();
  return j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation)) ? Number(j.elevation) : null;
}
async function osrmRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const j = await (await fetch(url)).json();
  return j.routes[0].geometry.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
}
// 経路の累積距離(km)と、距離dkm地点の座標を返す
function cumulative(co) {
  const cum = [0];
  for (let i = 1; i < co.length; i++) cum[i] = cum[i - 1] + haversineKm(co[i - 1], co[i]);
  return cum;
}
function pointAt(co, cum, dKm) {
  if (dKm <= 0) return co[0];
  if (dKm >= cum[cum.length - 1]) return co[co.length - 1];
  let i = 1;
  while (cum[i] < dKm) i++;
  const t = (dKm - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return { lat: co[i - 1].lat + (co[i].lat - co[i - 1].lat) * t, lng: co[i - 1].lng + (co[i].lng - co[i - 1].lng) * t };
}

const FROM = { lat: 35.2705, lng: 139.9555 }, TO = { lat: 35.2305, lng: 139.9605 };
const co = await osrmRoute(FROM, TO);
const cum = cumulative(co);
const total = cum[cum.length - 1];
console.log(`鹿野山の実ルート 全長 ${total.toFixed(2)}km。各地点での前方勾配を 80/100/150m で比較。\n`);

const eCache = new Map();
const elev = async (p) => {
  const k = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  if (!eCache.has(k)) eCache.set(k, await gsiElev(p.lat, p.lng));
  return eCache.get(k);
};

console.log("地点(km) |  80m   | 100m   | 150m   | 80↔150差");
console.log("---------+--------+--------+--------+--------");
let maxDiff = 0;
for (let s = 0.4; s <= total - 0.2; s += 0.4) {
  const e0 = await elev(pointAt(co, cum, s));
  const g = {};
  for (const b of BASES_M) {
    const e1 = await elev(pointAt(co, cum, s + b / 1000));
    g[b] = e0 != null && e1 != null ? ((e1 - e0) / b) * 100 : null;
  }
  const fmt = (v) => (v == null ? "  --- " : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
  const diff = g[80] != null && g[150] != null ? Math.abs(g[80] - g[150]) : 0;
  if (diff > maxDiff) maxDiff = diff;
  console.log(`${s.toFixed(1).padStart(7)} | ${fmt(g[80]).padStart(6)} | ${fmt(g[100]).padStart(6)} | ${fmt(g[150]).padStart(6)} | ${diff.toFixed(1)}pt`);
}
console.log(`\n80mと150mの最大差: ${maxDiff.toFixed(1)}ポイント（短いほど鋭く・長いほど平均化）`);

// 参考: ノイズとカーブ横ずれの理論値
console.log("\n=== 理論値 ===");
const SIG = 0.3; // DEM5A標高 標準偏差(m)
console.log("勾配ノイズ(DEM±0.3m): " + BASES_M.map((b) => `${b}m=±${((Math.SQRT2 * SIG) / b * 100).toFixed(2)}%`).join(" / "));
for (const R of [50, 100]) {
  console.log(`カーブ半径${R}mでの前方点の道からの横ずれ: ` + BASES_M.map((b) => `${b}m=${((b * b) / (2 * R * 1000) * 1000).toFixed(0)}m`).join(" / "));
}
