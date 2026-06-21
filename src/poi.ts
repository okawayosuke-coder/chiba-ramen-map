// OpenStreetMap の POI（コンビニ / ガソリンスタンド）を Overpass API から取得する。
// shop=convenience / amenity=fuel を対象。表示範囲(bbox)ぶんだけ取得する想定。
// Overpassは共有の無料APIなので、呼び出し側でズーム制限・bboxキャッシュ・最小間隔を必ず設けること。

export interface Poi {
  id: number;
  lat: number;
  lng: number;
  kind: "conv" | "fuel";
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

/** ブランド名から色＋識別文字を決める。商標保護のため公式ロゴは使わず色＋頭文字で識別。
 *  brand/name のどちらでも拾えるよう label（brand||name）に対して部分一致で判定。 */
export function poiBrandStyle(kind: Poi["kind"], label: string): PoiStyle {
  const s = (label || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
  if (kind === "conv") {
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
  // ガソリンスタンド
  if (has("eneos", "エネオス")) return { bg: "#e60012", fg: "#fff", t: "EN" };
  if (has("idemitsu", "出光", "apollostation", "apollo")) return { bg: "#003f8e", fg: "#ffd200", t: "出" };
  if (has("cosmo", "コスモ")) return { bg: "#e8400c", fg: "#fff", t: "コ" };
  if (has("shell", "シェル")) return { bg: "#ffd400", fg: "#d2002e", t: "S" };
  if (has("kygnus", "キグナス")) return { bg: "#16639e", fg: "#fff", t: "Ky" };
  if (has("ja-ss", "jass", "ja ss", "全農", "農協")) return { bg: "#2f9e44", fg: "#fff", t: "JA" };
  return { bg: "#e8590c", fg: "#fff", t: "⛽", emoji: true };
}

// 主＝公式、副＝ミラー（公式が406/429等で失敗した時のフォールバック）
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export async function fetchPois(b: BBox): Promise<Poi[]> {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  const q =
    `[out:json][timeout:25];(` +
    `node["shop"="convenience"](${bbox});` +
    `node["amenity"="fuel"](${bbox});` +
    `);out body;`;
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
        if (el.type !== "node" || el.lat == null || el.lon == null) continue;
        const t = el.tags ?? {};
        const kind: Poi["kind"] | null =
          t.shop === "convenience"
            ? "conv"
            : t.amenity === "fuel"
            ? "fuel"
            : null;
        if (!kind) continue;
        out.push({
          id: el.id,
          lat: el.lat,
          lng: el.lon,
          kind,
          label: t.brand || t.name || (kind === "conv" ? "コンビニ" : "GS"),
        });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("overpass failed");
}
