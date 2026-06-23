// アプリ同梱の周辺POI（コンビニ/GS）データを読み込み・絞り込みする。
// 走行中はこれを使い Overpass 非依存で「確実な情報」として即時・オフライン表示する。
// データは public/pois.json（scripts/fetch-pois.mjs で生成、月次更新可）。
// フォーマット: { updatedAt, bbox:[s,w,n,e], cell, brands:[...], pois:[[lat,lng,kindCode,brandIdx],...] }
//   kindCode: 0=conv / 1=fuel
import type { Poi, PoiKind, BBox } from "./poi";

export interface LocalPoiData {
  updatedAt: string;
  bbox: BBox;
  pois: Poi[];
}

const KIND_BY_CODE: PoiKind[] = ["conv", "fuel"];
/** 同梱データに含まれる種類（これ以外はライブ取得） */
export const LOCAL_KINDS: PoiKind[] = ["conv", "fuel"];

let cache: Promise<LocalPoiData> | null = null;

/** 同梱POIデータを一度だけ読み込む（PWAでprecacheされオフラインでも可）。失敗時は次回再試行。 */
export function loadLocalPois(): Promise<LocalPoiData> {
  if (!cache) {
    const url = `${import.meta.env.BASE_URL}pois.json`;
    cache = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`pois.json ${r.status}`);
        return r.json();
      })
      .then((j: {
        updatedAt?: string;
        bbox?: number[];
        brands?: string[];
        pois?: number[][];
      }) => {
        const brands = j.brands ?? [];
        const rows = j.pois ?? [];
        const pois: Poi[] = rows.map((row, i) => ({
          id: i,
          lat: row[0],
          lng: row[1],
          kind: KIND_BY_CODE[row[2]] ?? "conv",
          label: brands[row[3]] ?? "",
        }));
        const [s, w, n, e] = j.bbox ?? [-90, -180, 90, 180];
        return { updatedAt: j.updatedAt ?? "", bbox: { s, w, n, e }, pois };
      });
    cache.catch(() => {
      cache = null; // 読み込み失敗は次回リトライ可能に
    });
  }
  return cache;
}

/** 表示範囲 v が同梱データのカバレッジ bbox に完全に収まっているか（外なら県外＝ライブ取得へ） */
export function coverageContains(data: LocalPoiData, v: BBox): boolean {
  const b = data.bbox;
  return v.s >= b.s && v.w >= b.w && v.n <= b.n && v.e <= b.e;
}

/** 指定範囲・指定種類のローカルPOIを返す（線形走査。数万件でも1ms程度）。 */
export function localPoisInView(
  data: LocalPoiData,
  v: BBox,
  kinds: PoiKind[]
): Poi[] {
  const want = new Set(kinds);
  const out: Poi[] = [];
  for (const p of data.pois) {
    if (!want.has(p.kind)) continue;
    if (p.lat < v.s || p.lat > v.n || p.lng < v.w || p.lng > v.e) continue;
    out.push(p);
  }
  return out;
}
