// 高速道路センターライン（public/highways-geom.json）を読み込み、現在地を最寄りの高速道路へ
// スナップして「高速上か（距離m）＋どの高速か（路線名）」を位置ベースで判定する。
// 速度ヒステリシス判定のフォールバック／上書きに使う（提案書⑧）。データ元 OSM(ODbL)。

interface RoadRaw {
  ref?: string;
  name?: string;
  c: [number, number][]; // [lat,lng] の点列（簡略化済み）
}
interface Road extends RoadRaw {
  // bbox プレフィルタ用（緯度経度の最小最大）
  s: number;
  w: number;
  n: number;
  e: number;
}
export interface HighwayGeom {
  roads: Road[];
}
/** 現在地スナップ結果 */
export interface HwSnap {
  distM: number; // 最寄り高速までの距離(m)
  ref: string;
  name: string;
}

let cache: Promise<HighwayGeom> | null = null;

/** 同梱の高速道路形状を一度だけ読み込む（PWA precache・オフライン可）。失敗時は次回再試行。 */
export function loadHighwayGeom(): Promise<HighwayGeom> {
  if (!cache) {
    const url = `${import.meta.env.BASE_URL}highways-geom.json`;
    cache = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`highways-geom.json ${r.status}`);
        return r.json();
      })
      .then((j: { roads?: RoadRaw[] }) => {
        const roads: Road[] = [];
        for (const r of Array.isArray(j.roads) ? j.roads : []) {
          if (!Array.isArray(r.c) || r.c.length < 2) continue;
          let s = 90,
            w = 180,
            n = -90,
            e = -180;
          for (const p of r.c) {
            if (p[0] < s) s = p[0];
            if (p[0] > n) n = p[0];
            if (p[1] < w) w = p[1];
            if (p[1] > e) e = p[1];
          }
          roads.push({ ref: r.ref, name: r.name, c: r.c, s, w, n, e });
        }
        return { roads };
      });
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}

const PAD = 0.002; // bbox プレフィルタの余白（約220m）。スナップ閾値(<90m)より広く取り取りこぼし防止

/** 現在地から最寄りの高速道路センターラインまでの距離(m)＋路線名を返す。
 *  近傍に高速が無ければ null（＝高速から離れている）。点-線分距離は現在地まわりの等距円筒近似。 */
export function nearestHighway(g: HighwayGeom, lat: number, lng: number): HwSnap | null {
  const latRad = (lat * Math.PI) / 180;
  const mPerLat = 110540;
  const mPerLng = 111320 * Math.cos(latRad);
  let best = Infinity;
  let bestRoad: Road | null = null;
  for (const road of g.roads) {
    if (
      lat < road.s - PAD ||
      lat > road.n + PAD ||
      lng < road.w - PAD ||
      lng > road.e + PAD
    )
      continue; // 近傍bbox外は飛ばす
    const c = road.c;
    for (let i = 0; i < c.length - 1; i++) {
      // 現在地を原点としたローカル直交座標(m)で点-線分距離
      const ax = (c[i][1] - lng) * mPerLng;
      const ay = (c[i][0] - lat) * mPerLat;
      const bx = (c[i + 1][1] - lng) * mPerLng;
      const by = (c[i + 1][0] - lat) * mPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d = Math.hypot(cx, cy);
      if (d < best) {
        best = d;
        bestRoad = road;
      }
    }
  }
  if (!bestRoad || !isFinite(best)) return null;
  return { distM: best, ref: bestRoad.ref || "", name: bestRoad.name || "" };
}
