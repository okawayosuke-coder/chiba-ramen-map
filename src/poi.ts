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

// 主＝公式、副＝ミラー（公式が406/429等で失敗した時のフォールバック）
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** 指定bbox・指定種類のPOIを取得。kinds が空なら通信せず空配列を返す。
 *  nwr + out center で node だけでなく way/relation（駐車場のポリゴン等）も中心点で拾う。 */
export async function fetchPois(b: BBox, kinds: PoiKind[]): Promise<Poi[]> {
  if (!kinds.length) return [];
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  const body = kinds.map((k) => `nwr${KIND_FILTER[k]}(${bbox});`).join("");
  const q = `[out:json][timeout:25];(${body});out center;`;
  let lastErr: unknown = null;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(q),
      });
      if (!r.ok) {
        lastErr = new Error(`overpass ${r.status}`);
        continue;
      }
      const j = await r.json();
      const out: Poi[] = [];
      for (const el of j.elements ?? []) {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) continue;
        const t = el.tags ?? {};
        const kind = kindFromTags(t);
        if (!kind) continue;
        out.push({
          id: el.id,
          lat,
          lng,
          kind,
          label: t.brand || t.name || t.operator || POI_KIND_META[kind].label,
        });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("overpass failed");
}
