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
  /** 口コミタブ直開きURL（scripts/resolve_reviews.mjs が付与。無ければ mapsUrl にフォールバック） */
  reviewsUrl?: string;
  /** エリアキー（refine.py が行政界判定で付与）: tokyo / toukatsu / keiyo / chiba / inba / tosou / boso */
  region: string;
}

/** 抽出条件のしきい値（データ収集 scripts/refine.py と一致させること） */
export const RATING_FLOOR = 3.5; // スライダー下限＆データ収録の最低評価
export const DEFAULT_RATING = 3.9; // 既定の絞り込み値（既定は高評価のみ表示）
export const MIN_REVIEWS = 50;

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
  { key: "all", label: "全域（千葉＋江東・江戸川＋つくば）" },
  { key: "tokyo", label: "江東区・江戸川区（東京）" },
  { key: "tsukuba", label: "つくば市（茨城）" },
  { key: "toukatsu", label: "東葛飾（松戸・柏・流山・野田・我孫子・鎌ケ谷）" },
  { key: "keiyo", label: "葛南（市川・船橋・習志野・浦安・八千代）" },
  { key: "chiba", label: "千葉市・市原" },
  { key: "inba", label: "北総（佐倉・成田・印西・四街道）" },
  { key: "tosou", label: "東総・山武（銚子・旭・東金・茂原）" },
  { key: "boso", label: "南房総（木更津・君津・館山・南部）" },
];