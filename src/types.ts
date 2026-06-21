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

// 家系の「○○家」屋号パターン（吉村家/杉田家/武蔵家…）。語末が「家」で終わる店名を拾う。
const IEKEI_RE = /[^\s　・]家(?:$|\s|　|店|本店|・)/;
// 「家」を含むが家系ではない店（山岡家=豚骨醤油、麺家/らーめん家=屋号、磯家=磯ラーメン 等）を除外
const IEKEI_EXCLUDE = /(山岡家|麺家|らーめん家|ラーメン家|磯家|うさぎ家|神道家)/;

/** ジャンル（Googleのカテゴリは大半「ラーメン」で系統が不明なため、店名から判定する）。
 *  kw=店名への部分一致キーワード（小文字比較）、test=追加の判定関数。
 *  注意: スープのベース（醤油・塩など）は店名にほぼ出ないため対象にしていない（名前では判定不能）。
 *  系統名が名前に出ない店は分類されない（＝チップは“店名にその語がある店”の絞り込み）。 */
export const GENRE_DEFS: {
  key: string;
  label: string;
  kw: string[];
  test?: (name: string) => boolean;
}[] = [
  {
    key: "iekei",
    label: "家系",
    kw: ["家系", "横浜ラーメン", "壱角家", "町田商店"],
    test: (n) => IEKEI_RE.test(n) && !IEKEI_EXCLUDE.test(n),
  },
  { key: "chuka", label: "中華そば", kw: ["中華そば", "中華蕎麦", "支那そば", "支那蕎麦"] },
  { key: "tonkotsu", label: "豚骨", kw: ["豚骨", "とんこつ", "トンコツ", "博多", "長浜", "豚そば", "山岡家"] },
  { key: "miso", label: "味噌", kw: ["味噌", "みそ", "ミソ", "札幌"] },
  { key: "tsukemen", label: "つけ麺", kw: ["つけ麺", "つけめん", "付け麺", "tsukemen", "つけそば", "つけ蕎麦"] },
  { key: "niboshi", label: "煮干し", kw: ["煮干", "にぼし", "ニボシ"] },
  { key: "tori", label: "鶏白湯・鶏", kw: ["鶏白湯", "鶏そば", "鶏ラーメン", "鶏中華", "鳥そば", "とり白湯"] },
  { key: "jiro", label: "二郎系", kw: ["二郎", "ラーメン荘", "歴史を刻め", "夢を語れ", "豚山", "マシマシ", "ジロリアン", "野郎ラーメン"] },
  { key: "tantan", label: "担々麺", kw: ["担々", "担担", "坦々", "坦坦", "タンタン", "たんたん"] },
  { key: "mazesoba", label: "まぜそば・油そば", kw: ["まぜそば", "混ぜそば", "油そば", "あぶらそば", "台湾まぜ", "汁なし", "和え麺", "あえ麺", "まぜ麺"] },
];

/** 店名から該当するジャンルキーの配列を返す（複数該当あり得る） */
export function genreTags(name: string): string[] {
  const s = (name || "").toLowerCase();
  return GENRE_DEFS.filter(
    (g) =>
      g.kw.some((k) => s.includes(k.toLowerCase())) ||
      (g.test ? g.test(name) : false)
  ).map((g) => g.key);
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