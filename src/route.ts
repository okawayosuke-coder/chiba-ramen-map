// 道なりルート取得。OSMベースのルーティングAPIから経路ジオメトリと距離/所要を取得する。
// 既定は OpenRouteService（要無料APIキー・安定）。キー未設定なら OSRM 公開デモにフォールバック（試作用）。
import type { Pt } from "./nav";

export interface RouteResult {
  coords: [number, number][]; // [lat, lng] の点列（道路にスナップされた道なり経路）
  km: number; // 道路距離
  min: number; // 所要(分・渋滞なしの理論値)
}

// Vite の環境変数（VITE_ 接頭辞のみクライアントへ露出）。.env.local / CIシークレットで設定。
const ORS_KEY = (import.meta.env.VITE_ORS_KEY as string | undefined) || "";

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const ORS = "https://api.openrouteservice.org/v2/directions/driving-car";

/** ルーティング提供元の表示名（attribution用）。 */
export const routeProvider = ORS_KEY ? "OpenRouteService" : "OSRM demo";

async function fetchOSRM(from: Pt, to: Pt): Promise<RouteResult | null> {
  const url =
    `${OSRM}/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=geojson`;
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

async function fetchORS(from: Pt, to: Pt): Promise<RouteResult | null> {
  // GET + クエリのapi_key（カスタムヘッダ無し＝CORSプリフライト無しでレート消費を節約）
  const url =
    `${ORS}?api_key=${encodeURIComponent(ORS_KEY)}` +
    `&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const f = j?.features?.[0];
    const co = f?.geometry?.coordinates;
    if (!Array.isArray(co)) return null;
    const s = f.properties?.summary ?? {};
    return {
      coords: co.map((c: number[]) => [c[1], c[0]] as [number, number]),
      km: (s.distance ?? 0) / 1000,
      min: Math.round((s.duration ?? 0) / 60),
    };
  } catch {
    return null;
  }
}

/** from→to の道なり経路を取得。失敗時 null。ORSキーがあればORS、無ければOSRM。ORS失敗時はOSRMへフォールバック。 */
export async function fetchRoute(from: Pt, to: Pt): Promise<RouteResult | null> {
  if (ORS_KEY) {
    const r = await fetchORS(from, to);
    return r ?? fetchOSRM(from, to);
  }
  return fetchOSRM(from, to);
}
