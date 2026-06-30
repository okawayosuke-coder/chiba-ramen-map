// 高速センターライン(highways-geom)を「現在地から前方へ辿った経路」に組み立て、施設をその経路へ
// 投影して沿道距離順に並べる。路線名境界(東関東道→首都高湾岸線 等)やカーブ・JCTを越えて連続するため、
// 「この先この高速を走り続ける」前提で前方施設を安定表示できる（並走道路=京葉道路は経路から外れ除外）。
// 経路が十分に構築できない区間（細切れ/端点ギャップ/起点がランプ）では呼び出し側が従来ロジックへフォールバックする。
import type { HighwayGeom } from "./highwayGeom";

export interface PathPt {
  lat: number;
  lng: number;
  dist: number; // 起点からの沿道距離(km)
}
export interface ForwardPathIndex {
  /** 端点キー(4桁≒11m)→ そのキーに端点を持つ {road配列index, end} 一覧 */
  ep: Map<string, { id: number; end: "s" | "e" }[]>;
}

const mPerLat = 110540;
const mPerLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const epKey = (p: [number, number]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
function segBearing(a: [number, number], b: [number, number]): number {
  const x = (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2);
  const y = (b[0] - a[0]) * mPerLat;
  return (Math.atan2(x, y) * 180) / Math.PI;
}
function angDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** 端点インデックスを一度だけ構築（細切れwayを4桁許容で接続）。geom読込後に作る。 */
export function buildPathIndex(g: HighwayGeom): ForwardPathIndex {
  const ep = new Map<string, { id: number; end: "s" | "e" }[]>();
  const roads = g.roads;
  for (let id = 0; id < roads.length; id++) {
    const c = roads[id].c;
    if (!Array.isArray(c) || c.length < 2) continue;
    for (const [p, end] of [
      [c[0], "s"],
      [c[c.length - 1], "e"],
    ] as [[number, number], "s" | "e"][]) {
      const k = epKey(p);
      let arr = ep.get(k);
      if (!arr) ep.set(k, (arr = []));
      arr.push({ id, end });
    }
  }
  return { ep };
}

const SNAP_PAD = 0.01; // snap探索のbbox余白(約1.1km)

/** 現在地に最も近いway上の点を探す。重なり(JCT等)では最寄り+20m以内のうち、まず現在路線名(preferRoad)に
 *  一致する道を優先し、次に進行方位に最も合う道を選ぶ（curRoadは位置スナップのヒステリシスで安定しているため、
 *  JCTで分岐路や別路線へ吸われるブレを抑える）。 */
function snapToWay(g: HighwayGeom, lat: number, lng: number, headingDeg: number, preferRoad?: string) {
  const roads = g.roads;
  const cands: { d: number; id: number; i: number; t: number }[] = [];
  const mLng = mPerLng(lat);
  for (let id = 0; id < roads.length; id++) {
    const r = roads[id];
    if (lat < r.s - SNAP_PAD || lat > r.n + SNAP_PAD || lng < r.w - SNAP_PAD || lng > r.e + SNAP_PAD) continue;
    const c = r.c;
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][1] - lng) * mLng, ay = (c[i][0] - lat) * mPerLat;
      const bx = (c[i + 1][1] - lng) * mLng, by = (c[i + 1][0] - lat) * mPerLat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      cands.push({ d, id, i, t });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.d - b.d);
  let near = cands.filter((x) => x.d <= cands[0].d + 20);
  // 現在路線名に一致する候補があればそれだけに絞る（JCTで別路線へ吸われない）
  const pref = baseName(preferRoad);
  if (pref) {
    const same = near.filter((x) => baseName(roads[x.id].name) === pref);
    if (same.length) near = same;
  }
  let best = near[0], bestAlign = 999;
  for (const x of near) {
    const c = roads[x.id].c;
    const fb = segBearing(c[x.i], c[x.i + 1]);
    const align = Math.min(angDiff(fb, headingDeg), angDiff((fb + 180) % 360, headingDeg));
    if (align < bestAlign) { bestAlign = align; best = x; }
  }
  const c = roads[best.id].c;
  const fb = segBearing(c[best.i], c[best.i + 1]);
  return { ...best, forward: angDiff(fb, headingDeg) <= 90 };
}

function hkm(a: [number, number], b: [number, number]): number {
  const dx = (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2);
  const dy = (b[0] - a[0]) * mPerLat;
  return Math.hypot(dx, dy) / 1000;
}

const baseName = (n: string | undefined) => (n || "").split(";")[0];

/** 現在地から進行方向へセンターラインを辿った前方経路を返す。JCTでは同一路線の本線継続を強く優先、
 *  次いで直進(方位差最小)。構築できなければ null、短ければ呼び出し側で従来ロジックへ。 */
export function buildForwardPath(
  g: HighwayGeom,
  idx: ForwardPathIndex,
  lat: number,
  lng: number,
  headingDeg: number,
  maxKm: number,
  preferRoad?: string
): PathPt[] | null {
  const roads = g.roads;
  const snap = snapToWay(g, lat, lng, headingDeg, preferRoad);
  if (!snap) return null;
  const path: PathPt[] = [];
  let acc = 0;
  const c0 = roads[snap.id].c[snap.i], c1 = roads[snap.id].c[snap.i + 1];
  path.push({ lat: c0[0] + (c1[0] - c0[0]) * snap.t, lng: c0[1] + (c1[1] - c0[1]) * snap.t, dist: 0 });
  const visited = new Set<number>();
  let curId = snap.id, i = snap.i, fwd = snap.forward, lastDir = headingDeg;
  let guard = 0;
  while (acc < maxKm && guard++ < 400) {
    visited.add(curId);
    const c = roads[curId].c;
    const seq: [number, number][] = [];
    if (fwd) for (let j = i + 1; j < c.length; j++) seq.push(c[j]);
    else for (let j = i; j >= 0; j--) seq.push(c[j]);
    let prev = path[path.length - 1];
    for (const v of seq) {
      acc += hkm([prev.lat, prev.lng], v);
      path.push({ lat: v[0], lng: v[1], dist: acc });
      prev = path[path.length - 1];
      if (acc >= maxKm) break;
    }
    if (acc >= maxKm) break;
    const endPt = fwd ? c[c.length - 1] : c[0];
    if (path.length >= 2) lastDir = segBearing([path[path.length - 2].lat, path[path.length - 2].lng], endPt);
    const conn = (idx.ep.get(epKey(endPt)) || []).filter((e) => !visited.has(e.id));
    let pick: { id: number; fromStart: boolean; score: number } | null = null;
    const curBase = baseName(roads[curId].name);
    for (const e of conn) {
      const w2 = roads[e.id].c;
      const a = e.end === "s" ? w2[0] : w2[w2.length - 1];
      const b = e.end === "s" ? w2[1] : w2[w2.length - 2];
      const turn = angDiff(segBearing(a, b), lastDir);
      if (turn > 100) continue; // 逆戻り/急折れ除外
      const same = curBase && baseName(roads[e.id].name) === curBase;
      const score = turn - (same ? 70 : 0); // 同一路線の本線継続を強く優先
      if (!pick || score < pick.score) pick = { id: e.id, fromStart: e.end === "s", score };
    }
    if (!pick) break;
    curId = pick.id;
    fwd = pick.fromStart;
    i = pick.fromStart ? 0 : roads[curId].c.length - 1;
  }
  return path;
}

/** 施設を前方経路へ投影。最寄り点の沿道距離(km)と横距離(m)。経路が空なら null。 */
export function projectToPath(path: PathPt[], flat: number, flng: number): { alongKm: number; lateralM: number } | null {
  let best: { alongKm: number; lateralM: number } | null = null;
  const mLng = mPerLng(flat);
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const ax = (a.lng - flng) * mLng, ay = (a.lat - flat) * mPerLat;
    const bx = (b.lng - flng) * mLng, by = (b.lat - flat) * mPerLat;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const latM = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || latM < best.lateralM) best = { lateralM: latM, alongKm: a.dist + (b.dist - a.dist) * t };
  }
  return best;
}
