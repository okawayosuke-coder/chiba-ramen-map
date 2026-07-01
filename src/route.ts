// 道なりルート取得。OSMベースのルーティングAPIから経路ジオメトリと距離/所要を取得する。
// 既定は OpenRouteService（要無料APIキー・安定）。キー未設定なら OSRM 公開デモにフォールバック（試作用）。
import { haversineKm, type Pt } from "./nav";

export interface RouteResult {
  coords: [number, number][]; // [lat, lng] の点列（道路にスナップされた道なり経路）
  km: number; // 道路距離
  min: number; // 所要(分・渋滞なしの理論値)
  // 高速/有料区間の頂点インデックス範囲 [from,to]（ORS waycategory由来）。
  // 高速判定を速度でなく経路ベースで行うために使う（渋滞・低速でも確実）。GET/OSRM時は undefined。
  hwRanges?: [number, number][];
}

// Vite の環境変数（VITE_ 接頭辞のみクライアントへ露出）。.env.local / CIシークレットで設定。
const ORS_KEY = (import.meta.env.VITE_ORS_KEY as string | undefined) || "";

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const ORS = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const ORS_GET = "https://api.openrouteservice.org/v2/directions/driving-car";
// Mapbox Directions（driving-traffic＝渋滞・規制考慮）。地図と同じトークンを使用（env優先→PWAのlocalStorage）。
const MAPBOX_DIR = "https://api.mapbox.com/directions/v5/mapbox/driving-traffic";
function mapboxToken(): string {
  const env = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";
  if (env) return env;
  try {
    return localStorage.getItem("mapbox_poc_token") || "";
  } catch {
    return "";
  }
}

// 自車の前方この距離(m)に経由地を置き、出発を進行方向へ誘導してリルートのUターン(引き返し)を防ぐ。
// ※ORSのbearingsはcyclingプロファイル限定でdriving-carでは無視されるため、経由地方式を採る。
const AHEAD_M = 150;

/** ルーティング提供元の表示名（attribution用）。Mapbox を最優先で使うため、トークンがあれば Mapbox 表記。 */
export const routeProvider = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)
  ? "Mapbox"
  : ORS_KEY
  ? "OpenRouteService"
  : "OSRM demo";

type Heading = number | null | undefined;
const validHeading = (h: Heading): h is number =>
  typeof h === "number" && isFinite(h);

/** from から進行方位 headingDeg(0=北) 方向へ distM メートル進んだ地点。 */
function pointAhead(from: Pt, headingDeg: number, distM: number): Pt {
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111320;
  const dLng = (distM * Math.sin(rad)) / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

/** 経由地列を作る。heading が有効なら前方150mに経由地を挟み「前進→回り込み」を強制する。 */
function waypoints(from: Pt, to: Pt, heading: Heading): Pt[] {
  return validHeading(heading) ? [from, pointAhead(from, heading, AHEAD_M), to] : [from, to];
}

async function fetchOSRM(pts: Pt[], forward: boolean): Promise<RouteResult | null> {
  const path = pts.map((p) => `${p.lng},${p.lat}`).join(";");
  let url = `${OSRM}/${path}?overview=full&geometries=geojson`;
  if (forward) url += `&continue_straight=true`; // 経由地でのUターンを禁止
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const rt = j?.routes?.[0];
    const co = rt?.geometry?.coordinates;
    if (!Array.isArray(co)) return null;
    return {
      coords: co.map((c: number[]) => [c[1], c[0]] as [number, number]),
      km: rt.distance / 1000,
      min: Math.round(rt.duration / 60),
    };
  } catch {
    return null;
  }
}

// ORS GET（カスタムヘッダ無し＝CORSプリフライト無し）。経由地・前方誘導なしの通常取得用。
async function fetchORSGet(from: Pt, to: Pt): Promise<RouteResult | null> {
  const url =
    `${ORS_GET}?api_key=${encodeURIComponent(ORS_KEY)}` +
    `&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return parseORS(await r.json());
  } catch {
    return null;
  }
}

// ORS POST（経由地＋continue_straight で前方誘導）。
async function fetchORSPost(pts: Pt[], forward: boolean, avoidHw?: boolean): Promise<RouteResult | null> {
  try {
    const r = await fetch(ORS, {
      method: "POST",
      headers: { Authorization: ORS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: pts.map((p) => [p.lng, p.lat]),
        extra_info: ["waycategory"], // 高速/有料区間の判定用（経路ベースの高速判定）
        ...(forward ? { continue_straight: true } : {}),
        ...(avoidHw ? { options: { avoid_features: ["highways", "tollways"] } } : {}), // 一般道のみルート
      }),
    });
    if (!r.ok) return null;
    return parseORS(await r.json());
  } catch {
    return null;
  }
}

// ORS waycategory のビット: 1=Highway(高速) / 2=Tollway(有料)。どちらかなら高速扱い。
const WAYCAT_HIGHWAY = 1 | 2;

function parseORS(j: unknown): RouteResult | null {
  const f = (
    j as {
      features?: {
        geometry?: { coordinates?: number[][] };
        properties?: {
          summary?: { distance?: number; duration?: number };
          extras?: { waycategory?: { values?: number[][] } };
        };
      }[];
    }
  )?.features?.[0];
  const co = f?.geometry?.coordinates;
  if (!Array.isArray(co)) return null;
  const s = f?.properties?.summary ?? {};
  const vals = f?.properties?.extras?.waycategory?.values;
  const hwRanges = Array.isArray(vals)
    ? vals
        .filter((v) => (v[2] & WAYCAT_HIGHWAY) !== 0)
        .map((v) => [v[0], v[1]] as [number, number])
    : undefined;
  return {
    coords: co.map((c: number[]) => [c[1], c[0]] as [number, number]),
    km: (s.distance ?? 0) / 1000,
    min: Math.round((s.duration ?? 0) / 60),
    hwRanges,
  };
}

// Mapbox Directions（driving-traffic）。渋滞・通行規制を考慮した経路と所要を返す。
// bearings で出発の進行方位を拘束し、リルート時のUターン(引き返し)を抑止する（ORS driving-carと違い driving系で有効）。
// 高速/有料区間の範囲(hwRanges)は basic Directions では取得不可 → undefined を返し、速度ベースの高速判定にフォールバックする。
async function fetchMapbox(
  from: Pt,
  to: Pt,
  heading: Heading,
  avoidHw?: boolean
): Promise<RouteResult | null> {
  const token = mapboxToken();
  if (!token) return null;
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const params = new URLSearchParams({
    alternatives: "false",
    geometries: "geojson",
    overview: "full",
    steps: "false",
    access_token: token,
  });
  // 一般道のみルート: 高速・有料を除外（下道ルート）。
  if (avoidHw) params.set("exclude", "motorway,toll");
  // bearings は座標数と同数（;区切り）。出発のみ方位±45°で拘束、目的地は空（無拘束）。
  if (validHeading(heading)) {
    const deg = Math.round(((heading % 360) + 360) % 360);
    params.set("bearings", `${deg},45;`);
  }
  try {
    const r = await fetch(`${MAPBOX_DIR}/${path}?${params.toString()}`);
    if (!r.ok) return null;
    const j = await r.json();
    const rt = j?.routes?.[0];
    const co = rt?.geometry?.coordinates;
    if (!Array.isArray(co) || co.length < 2) return null;
    return {
      coords: co.map((c: number[]) => [c[1], c[0]] as [number, number]),
      km: (rt.distance ?? 0) / 1000,
      min: Math.round((rt.duration ?? 0) / 60),
      // hwRanges は付けない（速度ベース判定へ委譲）
    };
  } catch {
    return null;
  }
}

/** from→to の道なり経路を取得。失敗時 null。
 *  heading（自車の進行方位）を渡すと走行方向優先（Uターン抑止）のリルートにする。
 *  ①Mapbox driving-traffic（渋滞考慮）を優先し、失敗時は ②ORS/OSRM へフォールバック。
 *  ORS/OSRM は heading 有効時は前方150mに経由地を挟んで前進を強制（bearings非対応のため）。 */
export async function fetchRoute(
  from: Pt,
  to: Pt,
  heading?: Heading,
  avoidHw?: boolean
): Promise<RouteResult | null> {
  // ① Mapbox driving-traffic（地図トークンがあれば最優先）。avoidHw=一般道のみ(exclude=motorway,toll)
  const mb = await fetchMapbox(from, to, heading, avoidHw);
  if (mb) return mb;

  // ② フォールバック: ORS / OSRM（従来）
  const useFwd = validHeading(heading);
  const pts = waypoints(from, to, heading);
  if (ORS_KEY) {
    if (useFwd) {
      const r = await fetchORSPost(pts, true, avoidHw);
      if (r) return r;
    }
    const g = await fetchORSGet(from, to); // 前方誘導なしの速いGET（avoid_features非対応）
    if (g && !avoidHw) return g;
    const p = await fetchORSPost(pts, false, avoidHw); // avoidHw時はPOSTで再取得
    if (p) return p;
    return fetchOSRM([from, to], false);
  }
  if (useFwd) {
    const r = await fetchOSRM(pts, true);
    if (r) return r;
  }
  return fetchOSRM([from, to], false);
}

/** 現在地 here の経路上への投影結果（残り距離・最近接セグメント・投影点・逸脱距離）。 */
export interface RouteProjection {
  remKm: number; // 投影点から終点までの道なり残り距離(km)
  segIdx: number; // 投影が乗るセグメント coords[segIdx]→coords[segIdx+1] の始点インデックス
  proj: Pt; // 経路上の最近接点（自車の道なり現在位置）
  devKm: number; // 自車から経路線への垂直距離(km)。逸脱検知に使用
}

/** 現在地 here を経路 coords([lat,lng]) に投影し、残り距離・最近接セグメント・投影点・逸脱距離を返す。
 *  suffix[i] = 頂点i から終点までの道路距離(km, 事前計算)。経度は cos(緯度) でスケールして平面近似。
 *  地図エンジン非依存（Leaflet版 RamenMap.tsx と同一ロジック）。 */
export function projectOnRoute(
  coords: [number, number][],
  suffix: number[],
  here: Pt
): RouteProjection {
  if (coords.length < 2) {
    const proj = coords[0] ? { lat: coords[0][0], lng: coords[0][1] } : here;
    return { remKm: 0, segIdx: 0, proj, devKm: haversineKm(here, proj) };
  }
  const cosLat = Math.cos((here.lat * Math.PI) / 180) || 1;
  const px = here.lng * cosLat;
  const py = here.lat;
  let best = Infinity;
  let bestRem = 0;
  let bestIdx = 0;
  let bestProj: Pt = here;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = coords[i][1] * cosLat;
    const ay = coords[i][0];
    const bx = coords[i + 1][1] * cosLat;
    const by = coords[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (d2 < best) {
      best = d2;
      const proj = { lat: cy, lng: cx / cosLat };
      const segEnd = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
      bestRem = haversineKm(proj, segEnd) + suffix[i + 1];
      bestIdx = i;
      bestProj = proj;
    }
  }
  return { remKm: bestRem, segIdx: bestIdx, proj: bestProj, devKm: haversineKm(here, bestProj) };
}
