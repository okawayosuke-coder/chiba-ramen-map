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

/** 緯度経度から都道府県のJISコード（整数, 例: 千葉=12, 茨城=8）を返す。取得不可時 null。
 *  GSI逆ジオコーダの muniCd 上2桁が都道府県コード（pref<10 は先頭ゼロ付き5桁）。
 *  gogo.gs の都道府県ページ /<code> へのリンクに使う。 */
export async function prefCodeFromLatLng(
  lat: number,
  lng: number
): Promise<number | null> {
  try {
    const r = await fetch(
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`
    );
    const j = await r.json();
    const m = j?.results?.muniCd;
    if (!m) return null;
    const code = parseInt(String(m).padStart(5, "0").slice(0, 2), 10);
    return code >= 1 && code <= 47 ? code : null;
  } catch {
    return null;
  }
}
