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
