export interface Shop {
  name: string;
  rating: number;
  reviews: number;
  lat: number;
  lng: number;
  genre: string;
  address: string;
  placeId: string | null;
  mapsUrl: string;
  /** エリアキー（refine.py が行政界判定で付与）: tokyo / toukatsu / keiyo / chiba / inba / tosou / boso */
  region: string;
}

export type SortKey = "rating" | "reviews" | "name" | "near";

export interface Filters {
  query: string;
  minRating: number;
  minReviews: number;
  region: string; // "all" or a region key
  sort: SortKey;
}

/** エリア区分（緯度経度から判定）。千葉県＋隣接の江東区・江戸川区 */
export const REGIONS: { key: string; label: string }[] = [
  { key: "all", label: "全域（千葉＋江東・江戸川）" },
  { key: "tokyo", label: "江東区・江戸川区（東京）" },
  { key: "toukatsu", label: "東葛飾（松戸・柏・流山・野田・我孫子・鎌ケ谷）" },
  { key: "keiyo", label: "葛南（市川・船橋・習志野・浦安・八千代）" },
  { key: "chiba", label: "千葉市・市原" },
  { key: "inba", label: "北総（佐倉・成田・印西・四街道）" },
  { key: "tosou", label: "東総・山武（銚子・旭・東金・茂原）" },
  { key: "boso", label: "南房総（木更津・君津・館山・南部）" },
];

/** 緯度経度からおおよそのエリアキーを返す（厳密な行政界ではなく近似） */
export function regionOf(lat: number, lng: number): string {
  // 江東区・江戸川区（江戸川より西＝東京側）。市川・浦安より優先
  if (lng < 139.895 && lat >= 35.62 && lat <= 35.76) return "tokyo";
  if (lat <= 35.45) return "boso";
  if (lng >= 140.3) return "tosou";
  if (lat >= 35.72) {
    return lng >= 140.1 ? "inba" : "toukatsu";
  }
  if (lat >= 35.6 && lng < 140.08) return "keiyo";
  if (lat >= 35.68 && lng >= 140.1) return "inba";
  return "chiba";
}
