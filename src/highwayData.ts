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
}
export interface HighwayData {
  generated: string;
  facilities: HwFacility[];
}

let cache: Promise<HighwayData> | null = null;

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
