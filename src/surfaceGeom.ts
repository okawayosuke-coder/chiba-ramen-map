// 高速の真下/真横を走る一般道（国道357号 等）のセンターライン形状（public/surface-geom.json）を読み込み、
// 現在地から最寄りの一般道までの距離(m)を返す。走行中「最寄り一般道 vs 最寄り高速」を比べ、
// 一般道が明確に近ければ高速判定を打ち消す（357が高架の湾岸線/東関東で高速誤認される対策）。
// データは scripts/fetch-surface-geom.mjs が生成（高速から120m以内の trunk/primary のみ）。データ元 OSM(ODbL)。

interface SRoadRaw {
  c: [number, number][]; // [lat,lng] 点列（簡略化済み）
}
interface SRoad extends SRoadRaw {
  s: number;
  w: number;
  n: number;
  e: number;
}
export interface SurfaceGeom {
  roads: SRoad[];
}

let cache: Promise<SurfaceGeom> | null = null;

/** 同梱の一般道形状を一度だけ読み込む（PWA precache・オフライン可）。失敗時は次回再試行。 */
export function loadSurfaceGeom(): Promise<SurfaceGeom> {
  if (!cache) {
    const url = `${import.meta.env.BASE_URL}surface-geom.json`;
    cache = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`surface-geom.json ${r.status}`);
        return r.json();
      })
      .then((j: { roads?: SRoadRaw[] }) => {
        const roads: SRoad[] = [];
        for (const r of Array.isArray(j.roads) ? j.roads : []) {
          if (!Array.isArray(r.c) || r.c.length < 2) continue;
          let s = 90, w = 180, n = -90, e = -180;
          for (const p of r.c) {
            if (p[0] < s) s = p[0];
            if (p[0] > n) n = p[0];
            if (p[1] < w) w = p[1];
            if (p[1] > e) e = p[1];
          }
          roads.push({ c: r.c, s, w, n, e });
        }
        return { roads };
      });
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}

const PAD = 0.0016; // 約180m。bbox プレフィルタ余白

/** 現在地から最寄りの一般道センターラインまでの距離(m)。近傍に無ければ null。点-線分距離は等距円筒近似。 */
export function nearestSurface(g: SurfaceGeom, lat: number, lng: number): number | null {
  const latRad = (lat * Math.PI) / 180;
  const mPerLat = 110540;
  const mPerLng = 111320 * Math.cos(latRad);
  let best = Infinity;
  for (const road of g.roads) {
    if (lat < road.s - PAD || lat > road.n + PAD || lng < road.w - PAD || lng > road.e + PAD) continue;
    const c = road.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mPerLng;
      const ay = (c[i][0] - lat) * mPerLat;
      const bx = (c[i + 1][1] - lng) * mPerLng;
      const by = (c[i + 1][0] - lat) * mPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return isFinite(best) ? best : null;
}
