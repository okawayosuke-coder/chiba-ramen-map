// Mapbox Isochrone API（到達圏ポリゴン）と Matrix API（実運転時間）を使い、
// 「現在地から◯分で行ける店」の絞り込み・実移動時間の並べ替えを提供する。
// 直線距離(haversine)では「高速で速い遠い店 / 下道で遅い近い店」を取り違えるため、道路網ベースで補正する。
import type { Pt } from "./nav";

/** 地図と共通のトークン（env優先→PWAのlocalStorage）。route.ts/geocode.ts と同じ規則。 */
function mapboxToken(): string {
  const env = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";
  if (env) return env;
  try {
    return localStorage.getItem("mapbox_poc_token") || "";
  } catch {
    return "";
  }
}

/** GeoJSON の1リング（[lng,lat] の並び）。 */
type Ring = [number, number][];

export interface Isochrone {
  minutes: number;
  fc: GeoJSON.FeatureCollection; // 地図の fill/line ソース用（Isochrone の生レスポンス）
  rings: Ring[]; // 点内判定用（Polygon/MultiPolygon を全リング平坦化）
}

/** 点 p が到達圏の内側か（even-odd レイキャスティング・全リング横断。到達不能の穴も正しく除外）。 */
export function containsPt(iso: Isochrone, p: Pt): boolean {
  let inside = false;
  for (const ring of iso.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0],
        yi = ring[i][1];
      const xj = ring[j][0],
        yj = ring[j][1];
      const intersect =
        yi > p.lat !== yj > p.lat &&
        p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/** Isochrone API で「origin から minutes 分で到達できる範囲」ポリゴンを1回取得。
 *  driving プロファイル（Isochrone は driving-traffic 非対応＝渋滞なしの標準速度）。
 *  denoise/generalize で軽量ジオメトリに。トークン無し/失敗は null。 */
export async function fetchIsochrone(
  origin: Pt,
  minutes: number
): Promise<Isochrone | null> {
  const tok = mapboxToken();
  if (!tok) return null;
  try {
    const r = await fetch(
      `https://api.mapbox.com/isochrone/v1/mapbox/driving/${origin.lng},${origin.lat}` +
        `?contours_minutes=${minutes}&polygons=true&denoise=1&generalize=50&access_token=${tok}`
    );
    if (!r.ok) return null;
    const fc = (await r.json()) as GeoJSON.FeatureCollection;
    const feats = Array.isArray(fc?.features) ? fc.features : [];
    const rings: Ring[] = [];
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates) rings.push(ring as Ring);
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) for (const ring of poly) rings.push(ring as Ring);
      }
    }
    if (rings.length === 0) return null;
    return { minutes, fc, rings };
  } catch {
    return null;
  }
}

const MATRIX = "https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic";
// driving-traffic の Matrix は1リクエスト最大10座標（＝1発地+9目的地）。9件ずつ分割して叩く。
const MATRIX_BATCH = 9;
// 実移動時間を計算する店数の上限（＝Matrix 呼び出しを 24/9≒3回に抑える）。超過分は直線距離順のまま。
export const MATRIX_MAX = 24;

/** Matrix API で origin から各 dest への実運転時間（秒・driving-traffic＝渋滞込み）を取得。
 *  dests と同じ並びで返し、取得不能な要素は null。dests は MATRIX_MAX 件まで（呼び出し側で間引く）。 */
export async function fetchDriveSeconds(
  origin: Pt,
  dests: Pt[]
): Promise<(number | null)[]> {
  const tok = mapboxToken();
  const out: (number | null)[] = new Array(dests.length).fill(null);
  if (!tok || dests.length === 0) return out;
  const capped = dests.slice(0, MATRIX_MAX);
  for (let start = 0; start < capped.length; start += MATRIX_BATCH) {
    const batch = capped.slice(start, start + MATRIX_BATCH);
    const coords = [origin, ...batch].map((p) => `${p.lng},${p.lat}`).join(";");
    try {
      const r = await fetch(
        `${MATRIX}/${coords}?sources=0&annotations=duration&access_token=${tok}`
      );
      if (!r.ok) continue;
      const j = (await r.json()) as { durations?: (number | null)[][] };
      const row = j?.durations?.[0]; // source=0 の行。[0]=origin→origin、[1..]=各目的地
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < batch.length; i++) out[start + i] = row[i + 1] ?? null;
    } catch {
      // このバッチは null のまま（他バッチは継続）
    }
  }
  return out;
}
