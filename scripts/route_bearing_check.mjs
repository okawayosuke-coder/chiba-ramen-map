// リルートの「自車向き優先」検証。目的地が後方(南)でも進行方向(北)へ出るか。
// ORSのbearingsはcycling限定でdriving-carは無視 → 代替を比較:
//  (A) OSRM + bearings (drivingで有効)
//  (B) ORS + 前方への経由地(ahead) を挟む(continue_straight) ＝ ORS維持で前方誘導
import fs from "node:fs";
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const KEY = (env.match(/VITE_ORS_KEY=(.+)/) || [])[1]?.trim();

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const ORS = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

function bearingOf(a, b) {
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const startB = (co) => Math.round(bearingOf(co[0], co[Math.min(5, co.length - 1)]));

const FROM = [139.9246, 35.3248]; // [lng,lat] 北向き走行中とする
const TO = [139.9259, 35.3000];   // 南(後方)へ約2.8km
const AHEAD = [139.9246, 35.3263]; // FROMの約150m北(前方)

async function osrm(bearing) {
  let url = `${OSRM}/${FROM[0]},${FROM[1]};${TO[0]},${TO[1]}?overview=full&geometries=geojson`;
  if (bearing != null) url += `&bearings=${bearing},90;`;
  const r = await fetch(url);
  if (!r.ok) return { err: r.status };
  const j = await r.json();
  const co = j.routes?.[0]?.geometry?.coordinates;
  return co ? { startBearing: startB(co), km: (j.routes[0].distance / 1000).toFixed(2) } : { err: "nocoords" };
}
async function ors(coords, contStraight) {
  const body = { coordinates: coords };
  if (contStraight) body.continue_straight = true;
  const r = await fetch(ORS, { method: "POST", headers: { Authorization: KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return { err: r.status, t: (await r.text()).slice(0, 100) };
  const j = await r.json();
  const co = j.features?.[0]?.geometry?.coordinates;
  return co ? { startBearing: startB(co), km: (j.features[0].properties.summary.distance / 1000).toFixed(2) } : { err: "nocoords" };
}

console.log("北向き走行中・目的地は南(後方)。前方≈北(0/360°付近)になれば成功。\n");
console.log("(A) OSRM bearingなし      ->", JSON.stringify(await osrm(null)));
console.log("(A) OSRM bearing=北(0)    ->", JSON.stringify(await osrm(0)));
console.log("(B) ORS 通常(from→to)     ->", JSON.stringify(await ors([FROM, TO], false)));
console.log("(B) ORS 前方経由(from→ahead→to) ->", JSON.stringify(await ors([FROM, AHEAD, TO], true)));
