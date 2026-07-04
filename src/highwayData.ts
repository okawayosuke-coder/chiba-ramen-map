// アプリ同梱の高速道路施設（SA/PA/IC/JCT）データを読み込む。
// 提案書⑧ハイウェイモードのMVP。データは public/highway.json（scripts/fetch-highway.mjs で生成）。
// 件数が少なく静的なので走行中はこれを使い Overpass 非依存・オフライン可。データ元 OSM(ODbL)。
// フォーマット: { generated, bbox:[s,w,n,e], source, facilities:[{lat,lng,kind,name}] }
//   kind: "sa" | "pa" | "ic" | "jct"

export type HwKind = "sa" | "pa" | "ic" | "jct";
// SA/PA内の設備種別（OSM amenity/shop 由来）。表示順はこの定義順。
export type HwAmenity = "conv" | "fuel" | "food" | "cafe" | "shop" | "toilet" | "ev";
export interface HwFacility {
  lat: number;
  lng: number;
  kind: HwKind;
  name: string;
  amenities?: HwAmenity[]; // SA/PAのみ。OSMに設備データがある施設だけ付与。
  convBrand?: string; // SA/PA内コンビニのブランド名（見た目判別用・poiIconFileに渡す）
  fuelBrand?: string; // SA/PA内GSのブランド名（同上）
  road?: string; // 所属する高速の路線名（scripts/assign-facility-roads.mjs が付与）。走行中の現在路線と突合して並走道路を除外。
  toward?: { name: string; bearing: number }[]; // 方面（IC/JCTのみ）。motorway_linkのdestination由来。
  // bearingは絶対方位(0-360°、真北基準)。自車の進行方位との相対角度への変換は表示側で行う（Mapboxのroute
  // maneuverと違いフリー走行には基準となる進行方向が無いため、固定の左右を持たせず実行時に自車方位と比較する）。
  exit?: string; // 出口番号（IC/JCTのみ）。motorway_junctionノード自身のref由来（例"7"）。
}
export interface HighwayData {
  generated: string;
  facilities: HwFacility[];
}

let cache: Promise<HighwayData> | null = null;

// ---- 全国化: 地方ブロック(public/regions/<key>/highway.json)の施設マージ ----
// ブロック境界の重複施設は「種別＋名称＋座標(約10m丸め)」キーで除去。上り/下りの同名別地点(数百m差)は
// キーが異なるので両方残る＝関東版と同じ設計（表示側が進行方向側を選ぶ）。
// 既存参照(facilities配列)へ push で足すので、呼び出し側が持つ参照はそのまま新データが見える。
let facKeys: Set<string> | null = null;
const facKey = (f: HwFacility) => `${f.kind}|${f.name}|${f.lat.toFixed(4)},${f.lng.toFixed(4)}`;

/** 地方ブロックの高速施設をマージ。新規追加があれば true。 */
export async function mergeHighway(j: { facilities?: HwFacility[] }): Promise<boolean> {
  const d = await loadHighway();
  if (!facKeys) facKeys = new Set(d.facilities.map(facKey));
  let added = 0;
  for (const f of Array.isArray(j.facilities) ? j.facilities : []) {
    if (!f || typeof f.lat !== "number" || typeof f.lng !== "number" || !f.kind || !f.name) continue;
    const k = facKey(f);
    if (facKeys.has(k)) continue;
    facKeys.add(k);
    d.facilities.push(f);
    added++;
  }
  return added > 0;
}

/** 同梱の高速施設データを一度だけ読み込む（PWA precache・オフライン可）。失敗時は次回再試行。 */
export function loadHighway(): Promise<HighwayData> {
  if (!cache) {
    const url = `${import.meta.env.BASE_URL}highway.json`;
    cache = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`highway.json ${r.status}`);
        return r.json();
      })
      .then((j: { generated?: string; facilities?: HwFacility[] }) => ({
        generated: j.generated ?? "",
        facilities: Array.isArray(j.facilities) ? j.facilities : [],
      }));
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}
