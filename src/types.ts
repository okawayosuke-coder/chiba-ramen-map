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
  genres: string[]; // 選択中のジャンルキー（空=絞り込まない）
  sort: SortKey;
}

/** ジャンル（Googleのカテゴリは大半「ラーメン」で系統が不明なため、店名から推定する）。
 *  kw は店名に対する部分一致キーワード（小文字化して比較）。 */
export const GENRE_DEFS: { key: string; label: string; kw: string[] }[] = [
  { key: "iekei", label: "家系", kw: ["家系", "壱角家", "町田商店", "武蔵家", "吉村家", "杉田家", "魂心家", "王道家"] },
  { key: "chuka", label: "中華そば", kw: ["中華そば", "中華蕎麦"] },
  { key: "tsukemen", label: "つけ麺", kw: ["つけ麺", "つけめん", "付け麺"] },
  { key: "jiro", label: "二郎系", kw: ["二郎", "ジロー", "豚ラーメン", "ラーメン荘", "歴史を刻め"] },
  { key: "miso", label: "味噌", kw: ["味噌", "みそ"] },
  { key: "tonkotsu", label: "豚骨", kw: ["豚骨", "とんこつ", "トンコツ"] },
  { key: "tantan", label: "担々麺", kw: ["担々", "担担", "坦々", "タンタン"] },
  { key: "tori", label: "鶏白湯・鶏", kw: ["鶏白湯", "鶏そば", "鶏ラーメン", "水炊き"] },
  { key: "mazesoba", label: "まぜそば・油そば", kw: ["まぜそば", "混ぜそば", "油そば", "あぶらそば", "台湾まぜ", "汁なし"] },
  { key: "shoyu", label: "醤油", kw: ["醤油", "正油"] },
  { key: "gyokai", label: "魚介・濃厚", kw: ["魚介", "濃厚"] },
  { key: "shio", label: "塩", kw: ["塩ラーメン", "塩そば", "塩中華"] },
];

/** 店名から該当するジャンルキーの配列を返す（複数該当あり得る） */
export function genreTags(name: string): string[] {
  const s = (name || "").toLowerCase();
  return GENRE_DEFS.filter((g) => g.kw.some((k) => s.includes(k.toLowerCase()))).map(
    (g) => g.key
  );
}

/** エリア区分（緯度経度から判定）。千葉県＋隣接の江東区・江戸川区 */
export const REGIONS: { key: string; label: string }[] = [
  { key: "all", label: "全域（千葉＋江東江戸川＋茨城県南）" },
  { key: "tokyo", label: "江東区・江戸川区（東京）" },
  { key: "tsukuba", label: "つくば市（茨城）" },
  { key: "ibaraki_south", label: "茨城県南（土浦・牛久・守谷・取手 ほか）" },
  { key: "toukatsu", label: "東葛飾（松戸・柏・流山・野田・我孫子・鎌ケ谷）" },
  { key: "keiyo", label: "葛南（市川・船橋・習志野・浦安・八千代）" },
  { key: "chiba", label: "千葉市・市原" },
  { key: "inba", label: "北総（佐倉・成田・印西・四街道）" },
  { key: "tosou", label: "東総・山武（銚子・旭・東金・茂原）" },
  { key: "boso", label: "南房総（木更津・君津・館山・南部）" },
];