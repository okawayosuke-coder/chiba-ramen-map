// OpenStreetMap の POI（コンビニ / ガソリンスタンド / 駐車場 / EV充電 / トイレ）を
// Overpass API から取得する。表示範囲(bbox)ぶん・選択された種類ぶんだけ取得する。
// Overpassは共有の無料APIなので、呼び出し側でズーム制限・bboxキャッシュ・最小間隔を必ず設けること。

export type PoiKind = "conv" | "fuel" | "parking" | "ev" | "toilet";

export interface Poi {
  id: number;
  lat: number;
  lng: number;
  kind: PoiKind;
  label: string; // ブランド名 or 名称
}

export interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

export interface PoiStyle {
  bg: string;
  fg: string;
  t: string; // マーカー内の短い識別文字（不明時は絵文字）
  emoji?: boolean;
}

/** 設定UI/凡例で使う種類メタ（表示順はこの配列順） */
export const POI_KINDS: PoiKind[] = ["conv", "fuel", "parking", "ev", "toilet"];
export const POI_KIND_META: Record<PoiKind, { label: string; emoji: string }> = {
  conv: { label: "コンビニ", emoji: "🏪" },
  fuel: { label: "GS", emoji: "⛽" },
  parking: { label: "駐車場", emoji: "🅿️" },
  ev: { label: "EV充電", emoji: "⚡" },
  toilet: { label: "トイレ", emoji: "🚻" },
};

// Overpass のタグ条件（種類→ nwr フィルタ）
const KIND_FILTER: Record<PoiKind, string> = {
  conv: `["shop"="convenience"]`,
  fuel: `["amenity"="fuel"]`,
  parking: `["amenity"="parking"]`,
  ev: `["amenity"="charging_station"]`,
  toilet: `["amenity"="toilets"]`,
};

/** タグから種類を判定（取得対象外のものは null） */
function kindFromTags(t: Record<string, string>): PoiKind | null {
  if (t.shop === "convenience") return "conv";
  if (t.amenity === "fuel") return "fuel";
  if (t.amenity === "parking") return "parking";
  if (t.amenity === "charging_station") return "ev";
  if (t.amenity === "toilets") return "toilet";
  return null;
}

/** ブランド名から色＋識別文字を決める。商標保護のため公式ロゴは使わず色＋頭文字で識別。
 *  brand/name のどちらでも拾えるよう label（brand||name）に対して部分一致で判定。 */
export function poiBrandStyle(kind: PoiKind, label: string): PoiStyle {
  const s = (label || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
  switch (kind) {
    case "conv": {
      if (has("7-eleven", "7‐eleven", "seven", "セブン")) return { bg: "#ee7a00", fg: "#fff", t: "7" };
      if (has("lawson", "ローソン")) return { bg: "#0067b1", fg: "#fff", t: "L" };
      if (has("familymart", "family mart", "ファミリーマート", "ファミマ")) return { bg: "#0aa14b", fg: "#fff", t: "F" };
      if (has("ministop", "ミニストップ")) return { bg: "#f6a800", fg: "#16357a", t: "M" };
      if (has("daily", "デイリーヤマザキ", "ヤマザキ")) return { bg: "#e60012", fg: "#fff", t: "D" };
      if (has("seicomart", "seico", "セイコーマート", "セコマ")) return { bg: "#e8731c", fg: "#fff", t: "Sk" };
      if (has("newdays", "ニューデイズ")) return { bg: "#0a8a3b", fg: "#fff", t: "ND" };
      if (has("poplar", "ポプラ")) return { bg: "#1f9d55", fg: "#fff", t: "P" };
      return { bg: "#6b7280", fg: "#fff", t: "🏪", emoji: true };
    }
    case "fuel": {
      if (has("eneos", "エネオス")) return { bg: "#e60012", fg: "#fff", t: "EN" };
      if (has("idemitsu", "出光", "apollostation", "apollo")) return { bg: "#003f8e", fg: "#ffd200", t: "出" };
      if (has("cosmo", "コスモ")) return { bg: "#e8400c", fg: "#fff", t: "コ" };
      if (has("shell", "シェル")) return { bg: "#ffd400", fg: "#d2002e", t: "S" };
      if (has("kygnus", "キグナス")) return { bg: "#16639e", fg: "#fff", t: "Ky" };
      if (has("ja-ss", "jass", "ja ss", "全農", "農協")) return { bg: "#2f9e44", fg: "#fff", t: "JA" };
      return { bg: "#e8590c", fg: "#fff", t: "⛽", emoji: true };
    }
    case "parking": {
      if (has("times", "タイムズ")) return { bg: "#f7c600", fg: "#222", t: "P" };
      if (has("repark", "リパーク", "三井", "mitsui")) return { bg: "#0a7d4b", fg: "#fff", t: "P" };
      return { bg: "#2b6fd6", fg: "#fff", t: "P" };
    }
    case "ev": {
      if (has("tesla")) return { bg: "#cc0000", fg: "#fff", t: "⚡", emoji: true };
      return { bg: "#16a34a", fg: "#fff", t: "⚡", emoji: true };
    }
    case "toilet":
      return { bg: "#0e7490", fg: "#fff", t: "🚻", emoji: true };
  }
}

/** 名称(label)からコンビニブランドのアイコンを判定（種別に依存しない）。
 *  OSMで amenity=fuel 等に誤タグされた「名称はコンビニ」を救済するため切り出し。 */
function convIconByName(label: string): string | null {
  const s = (label || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
  if (has("natural lawson", "natural-lawson", "ナチュラルローソン")) return "naturallawson.png";
  if (has("lawson store 100", "lawson-store-100", "lawsonstore100", "ローソンストア100", "ローソンストア１００", "ローソン100", "store100"))
    return "lawson100.png";
  if (has("lawson", "ローソン")) return "lawson.png";
  if (has("7-eleven", "7‐eleven", "7eleven", "seven", "セブン")) return "seven.png";
  if (has("familymart", "family mart", "ファミリーマート", "ファミマ")) return "familymart.png";
  if (has("ministop", "ミニストップ")) return "ministop.png";
  if (has("daily", "デイリーヤマザキ", "ヤマザキ")) return "dailyyamazaki.png";
  if (has("poplar", "ポプラ")) return "poplar.png";
  if (has("circle k", "circlek", "サークルk")) return "circlek.png";
  if (has("sunkus", "sankus", "サンクス")) return "sunkus.png";
  if (has("am/pm", "am-pm", "ampm", "エーエムピーエム")) return "ampm.png";
  if (has("heart in", "heart-in", "heartin", "ハートイン")) return "heartin.png";
  if (has("community store", "community-store", "コミュニティストア", "コミュニティ・ストア"))
    return "community.png";
  if (has("coco", "ここストア", "ココストア")) return "coco.png";
  return null;
}

/** POIのブランドアイコン画像ファイル名を返す（public/poi-icons/ 配下）。
 *  コンビニ(conv)＝ブランド円形アイコン（一致しなければ汎用 generic.png）。
 *  GS(fuel)＝主要ブランドのみ角丸バッジ（gs-*.png）。一致しないGSは null＝色＋文字。
 *  名称がコンビニブランドなら種別がfuel等でもコンビニアイコンを優先（OSM誤タグ救済）。
 *  返り値が "gs-" で始まればGSバッジ形状、それ以外は円形（呼び出し側で判定）。 */
export function poiIconFile(kind: PoiKind, label: string): string | null {
  const convBrand = convIconByName(label);
  if (kind === "conv") return convBrand || "generic.png";
  // conv以外でも名称がコンビニブランドなら救済（例: amenity=fuel で name=7-Eleven）
  if (convBrand) return convBrand;
  if (kind === "fuel") {
    const s = (label || "").toLowerCase();
    const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
    // 現役主要ブランドのみ（旧ブランドはENEOS/出光に統合済み・OSMでも現ブランド表記が大半）
    if (has("eneos", "エネオス")) return "gs-eneos.png";
    if (has("idemitsu", "出光", "apollostation", "apollo")) return "gs-idemitsu.png";
    if (has("cosmo", "コスモ")) return "gs-cosmo.png";
    if (has("kygnus", "キグナス")) return "gs-kygnus.png";
    if (has("solato", "太陽石油", "taiyo")) return "gs-solato.png";
    if (has("mitsui", "三井")) return "gs-mitsui.png";
    if (has("shell", "シェル", "昭和シェル", "昭和shell")) return "gs-shell.png";
    if (has("esso", "エッソ")) return "gs-esso.png";
    return null; // 未一致GS（JA-SS/ホクレン/無名）は色＋文字
  }
  return null; // 駐車場/EV/トイレ
}

// 公式＋ミラー。Overpassは時間帯で応答が極端にばらつく（同一クエリが1秒〜20秒超）。
// そのため直列フォールバックではなく「全ミラーへ同時に投げ、最速の成功を採用」する。
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// 1ミラーが沈黙した時に他へ素早く切り替えるためのクライアント側タイムアウト(ms)。
const TIMEOUT_MS = 7000;

/** Overpass応答のJSONをPoi配列へ整形（node/way/relation を中心点で拾う）。 */
function parseElements(j: { elements?: unknown[] }): Poi[] {
  const out: Poi[] = [];
  for (const el of (j.elements ?? []) as Array<Record<string, unknown>>) {
    const center = el.center as { lat?: number; lon?: number } | undefined;
    const lat = (el.lat as number) ?? center?.lat;
    const lng = (el.lon as number) ?? center?.lon;
    if (lat == null || lng == null) continue;
    const t = (el.tags ?? {}) as Record<string, string>;
    const kind = kindFromTags(t);
    if (!kind) continue;
    out.push({
      id: el.id as number,
      lat,
      lng,
      kind,
      label: t.brand || t.name || t.operator || POI_KIND_META[kind].label,
    });
  }
  return out;
}

/** 指定bbox・指定種類のPOIを取得。kinds が空なら通信せず空配列を返す。
 *  nwr + out center で node だけでなく way/relation（駐車場のポリゴン等）も中心点で拾う。
 *  全ミラーへ並列に1リクエストずつ投げ、最初に成功した応答を採用する（Promise.any）。
 *  各リクエストは TIMEOUT_MS で自動中断。呼び出し側で最小間隔を担保しているため過剰アクセスにはならない。 */
export async function fetchPois(b: BBox, kinds: PoiKind[]): Promise<Poi[]> {
  if (!kinds.length) return [];
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  const body = kinds.map((k) => `nwr${KIND_FILTER[k]}(${bbox});`).join("");
  const q = `[out:json][timeout:25];(${body});out center;`;
  const payload = "data=" + encodeURIComponent(q);

  const once = async (url: string): Promise<Poi[]> => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: payload,
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`overpass ${r.status} @ ${url}`);
      return parseElements(await r.json());
    } finally {
      clearTimeout(to);
    }
  };

  // 最速の成功を採用。全滅時は Promise.any が AggregateError を投げる（呼び出し側で捕捉）。
  return Promise.any(ENDPOINTS.map(once));
}
