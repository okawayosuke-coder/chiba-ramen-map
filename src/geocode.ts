import muniData from "./data/muni.json";

const MUNI = muniData as Record<string, string>;

/** 国土地理院 逆ジオコーダで「都道府県+市区町村+町名（番地は除く）」を取得。
 * 逆ジオコーダの muniCd は pref<10 が先頭ゼロ付き5桁("08203")で返るが、
 * muni.json のキーは先頭ゼロ無し("8203")。parseInt で正規化して照合する。
 * lv01Nm は大字・町丁目（番地を含まない）。取得不可時は "－"。 */
export async function reverseAddressNoBanchi(
  lat: number,
  lng: number
): Promise<string | null> {
  try {
    const r = await fetch(
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`
    );
    const j = await r.json();
    const res = j?.results;
    if (!res) return null;
    const code = res.muniCd ? String(parseInt(res.muniCd, 10)) : "";
    const city = (code && MUNI[code]) || "";
    const town =
      res.lv01Nm && res.lv01Nm !== "－" && res.lv01Nm !== "-"
        ? String(res.lv01Nm)
        : "";
    const addr = (city + town).trim();
    return addr || null;
  } catch {
    return null;
  }
}

/** 逆ジオコーダで「都道府県+市区町村」だけを返す（町名・番地は付けない）。天気の予報地点表示など簡潔用途。
 *  4秒でタイムアウト（背景取得をハングさせない）。取得不可・タイムアウトは null。 */
export async function reverseCityName(lat: number, lng: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`,
      { signal: ctrl.signal }
    );
    clearTimeout(to);
    const j = await r.json();
    const code = j?.results?.muniCd ? String(parseInt(j.results.muniCd, 10)) : "";
    return (code && MUNI[code]) || null;
  } catch {
    return null;
  }
}

/** 国土地理院 住所検索（順ジオコーディング）で「住所文字列 → 緯度経度」。
 *  最有力候補1件の座標と表記を返す。該当なし・失敗時は null。
 *  返却 geometry.coordinates は GeoJSON 順 [lng, lat]。自宅登録などで使用。 */
export async function geocodeAddress(
  query: string
): Promise<{ lat: number; lng: number; title: string } | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    const r = await fetch(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`
    );
    if (!r.ok) return null;
    const j = (await r.json()) as Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: { title?: string };
    }>;
    const f = Array.isArray(j) ? j[0] : null;
    const co = f?.geometry?.coordinates;
    if (!co || co.length < 2) return null;
    return { lat: co[1], lng: co[0], title: f?.properties?.title || q };
  } catch {
    return null;
  }
}

/** Mapboxトークン解決（RamenMapbox の resolveToken と同じ規則）。地名/施設名検索(geocodePlaces)用。 */
function mapboxToken(): string | null {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_MAPBOX_TOKEN;
  if (env && /^pk\./.test(env)) return env;
  try {
    const t = localStorage.getItem("mapbox_poc_token");
    if (t && /^pk\./.test(t)) return t;
  } catch {
    /* localStorage 不可は無視 */
  }
  return null;
}

export interface PlaceHit {
  lat: number;
  lng: number;
  title: string; // 施設/地名（例: 京成佐倉駅）
  subtitle: string; // 住所（例: 千葉県佐倉市栄町）
}

/** Mapbox Search Box API(/forward) で「キーワード → 地名/駅/施設/住所」を複数候補で返す。
 *  GSI住所ジオコーダは住所専用で「佐倉駅」等のPOI/駅名/ランドマークを解決できないため、
 *  目的地のキーワード検索はこちらを使う。proximity(現在地)で近い候補を上位に。日本・日本語固定。
 *  トークン未設定/失敗/2文字未満は空配列。 */
export async function geocodePlaces(
  query: string,
  proximity?: { lat: number; lng: number } | null
): Promise<PlaceHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const tok = mapboxToken();
  if (!tok) return [];
  const prox = proximity ? `&proximity=${proximity.lng},${proximity.lat}` : "";
  try {
    const r = await fetch(
      `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(q)}` +
        `&country=jp&language=ja&limit=6${prox}&access_token=${tok}`
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: { name?: string; place_formatted?: string };
      }>;
    };
    const feats = Array.isArray(j.features) ? j.features : [];
    const out: PlaceHit[] = [];
    for (const f of feats) {
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      out.push({
        lat: c[1],
        lng: c[0],
        title: f.properties?.name || q,
        subtitle: f.properties?.place_formatted || "",
      });
    }
    return out;
  } catch {
    return [];
  }
}
