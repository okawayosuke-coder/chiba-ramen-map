// 道なりルート取得。OSMベースのルーティングAPIから経路ジオメトリと距離/所要を取得する。
// 既定は OpenRouteService（要無料APIキー・安定）。キー未設定なら OSRM 公開デモにフォールバック（試作用）。
import type { Pt } from "./nav";

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

// 自車の前方この距離(m)に経由地を置き、出発を進行方向へ誘導してリルートのUターン(引き返し)を防ぐ。
// ※ORSのbearingsはcyclingプロファイル限定でdriving-carでは無視されるため、経由地方式を採る。
const AHEAD_M = 150;

/** ルーティング提供元の表示名（attribution用）。 */
export const routeProvider = ORS_KEY ? "OpenRouteService" : "OSRM demo";

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
async function fetchORSPost(pts: Pt[], forward: boolean): Promise<RouteResult | null> {
  try {
    const r = await fetch(ORS, {
      method: "POST",
      headers: { Authorization: ORS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: pts.map((p) => [p.lng, p.lat]),
        extra_info: ["waycategory"], // 高速/有料区間の判定用（経路ベースの高速判定）
        ...(forward ? { continue_straight: true } : {}),
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

/** from→to の道なり経路を取得。失敗時 null。
 *  heading（自車の進行方位）を渡すと前方に経由地を挟み、走行方向優先（Uターン抑止）のリルートにする。
 *  経由地つき取得が失敗した場合は経由地なしで再取得してフォールバック。 */
export async function fetchRoute(
  from: Pt,
  to: Pt,
  heading?: Heading
): Promise<RouteResult | null> {
  const useFwd = validHeading(heading);
  const pts = waypoints(from, to, heading);
  if (ORS_KEY) {
    if (useFwd) {
      const r = await fetchORSPost(pts, true);
      if (r) return r;
    }
    const g = await fetchORSGet(from, to); // 前方誘導なしの速いGET
    if (g) return g;
    return fetchOSRM([from, to], false);
  }
  if (useFwd) {
    const r = await fetchOSRM(pts, true);
    if (r) return r;
  }
  return fetchOSRM([from, to], false);
}
