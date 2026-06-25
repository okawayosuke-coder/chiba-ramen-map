// 勾配計の検証: 実ルート(OSRM)を150m間隔マークに分割し、GSI標高で勾配を算出。
// RamenMap.tsx の buildMarks / fetchElevationNum / 勾配計算と同じ手順を再現し、
// 既知の坂道(鹿野山周辺)で「この先急勾配(>8%)」が正しく検出されるかを確認する。

const SPACING_KM = 0.15;
const STEEP = 8;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildMarks(coords, spacingKm) {
  const marks = [];
  if (!coords.length) return marks;
  marks.push({ lat: coords[0][0], lng: coords[0][1] });
  let acc = 0,
    next = spacingKm;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lat: coords[i][0], lng: coords[i][1] };
    const b = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
    const seg = haversineKm(a, b);
    if (seg <= 0) continue;
    while (acc + seg >= next) {
      const t = (next - acc) / seg;
      marks.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      next += spacingKm;
    }
    acc += seg;
  }
  return marks;
}

async function gsiElev(lat, lng) {
  const r = await fetch(
    `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`
  );
  const j = await r.json();
  if (j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation)))
    return Number(j.elevation);
  return null;
}

async function osrmRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  const j = await r.json();
  const co = j?.routes?.[0]?.geometry?.coordinates;
  return co.map((c) => [c[1], c[0]]);
}

// 鹿野山(君津)の麓→マザー牧場方面。標高30m前後→300m超まで登る坂道。
const FROM = { lat: 35.2705, lng: 139.9555 };
const TO = { lat: 35.2305, lng: 139.9605 };

console.log("ルート取得(OSRM)...");
const coords = await osrmRoute(FROM, TO);
console.log("  経路頂点数:", coords.length);
const marks = buildMarks(coords, SPACING_KM);
console.log("  150mマーク数:", marks.length, `(全長 約${(marks.length * SPACING_KM).toFixed(1)}km)`);

console.log("GSI標高を取得中...");
const ele = [];
for (const m of marks) ele.push(await gsiElev(m.lat, m.lng));

console.log("\n  # |   標高m |  区間勾配%");
console.log("----+---------+-----------");
let maxAbs = 0,
  maxIdx = -1,
  nullCnt = 0;
for (let i = 0; i < marks.length; i++) {
  const e = ele[i];
  if (e === null) nullCnt++;
  let g = "";
  if (i < marks.length - 1 && typeof e === "number" && typeof ele[i + 1] === "number") {
    const gv = ((ele[i + 1] - e) / (SPACING_KM * 1000)) * 100;
    g = (gv >= 0 ? "+" : "") + gv.toFixed(1);
    if (Math.abs(gv) > maxAbs) {
      maxAbs = Math.abs(gv);
      maxIdx = i;
    }
  }
  console.log(
    `${String(i).padStart(3)} | ${e === null ? "  ----" : e.toFixed(1).padStart(7)} | ${g.padStart(9)}`
  );
}
console.log("\n結果:");
console.log(`  標高取得不可(海域等): ${nullCnt}/${marks.length}`);
console.log(
  `  最急区間: #${maxIdx} (始点から約${(maxIdx * SPACING_KM).toFixed(2)}km) で ${maxAbs.toFixed(1)}%`
);
console.log(`  >${STEEP}% の急勾配検出: ${maxAbs >= STEEP ? "✅ あり（警告が出る）" : "なし"}`);
