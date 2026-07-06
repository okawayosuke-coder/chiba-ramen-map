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

/** 逆ジオコーダで muniCd（JIS5・先頭ゼロ無し）と市区町村名を同時に返す。
 *  天気の気象庁フォールバックで「現在地 → 予報区(office)」を引くのに使う（jma-area.json のキーが muniCd）。
 *  4秒でタイムアウト（背景取得をハングさせない）。取得不可・タイムアウトは null。 */
export async function reverseMuni(
  lat: number,
  lng: number
): Promise<{ code: string; name: string } | null> {
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
    if (!code) return null;
    return { code, name: MUNI[code] || "" };
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

/** Search Box /suggest の候補1件（座標はまだ持たない＝タップ時に /retrieve で取得）。 */
export interface PlaceSuggestion {
  mapboxId: string; // /retrieve に渡すID
  title: string; // 施設/地名
  subtitle: string; // 住所・文脈
}

// 郵便番号(〒NNN-NNNN)の先頭付与を除去（dest-box が横長になるのを防ぐ）。
const stripPostal = (s: string) => (s || "").replace(/〒?\s*\d{3}-\d{4}\s*/, "").trim();

/** Search Box のセッショントークン。/suggest→/retrieve を1セッションとして課金・関連付けするための UUID。
 *  retrieve 完了でセッション終了 → 次の検索で resetSearchSession() が新トークンを発行する。 */
let searchSession = "";
function sessionToken(): string {
  if (!searchSession) {
    try {
      searchSession = crypto.randomUUID();
    } catch {
      // crypto 不可の環境向けフォールバック（衝突しても課金分割されるだけで機能影響なし）
      searchSession = "s-" + String(performance.now()).replace(".", "") + "-" + String(performance.now());
    }
  }
  return searchSession;
}
/** 目的地確定（/retrieve 実行）でセッションを閉じる。次入力から新セッション。 */
export function resetSearchSession(): void {
  searchSession = "";
}

/** Search Box API(/suggest) で「入力途中の文字列 → 候補（地名/駅/施設/住所）」をタイプアヘッド取得。
 *  /forward と違い1文字ごとに安く叩ける設計。座標は含まないため、確定は retrievePlace() で取得する。
 *  トークン未設定/失敗/2文字未満は空配列。失敗時は呼び出し側が geocodePlaces にフォールバックできる。 */
export async function suggestPlaces(
  query: string,
  proximity?: { lat: number; lng: number } | null
): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const tok = mapboxToken();
  if (!tok) return [];
  const prox = proximity ? `&proximity=${proximity.lng},${proximity.lat}` : "";
  try {
    const r = await fetch(
      `https://api.mapbox.com/search/searchbox/v1/suggest?q=${encodeURIComponent(q)}` +
        `&country=jp&language=ja&limit=6&session_token=${sessionToken()}${prox}&access_token=${tok}`
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      suggestions?: Array<{
        mapbox_id?: string;
        name?: string;
        place_formatted?: string;
        full_address?: string;
      }>;
    };
    const sugs = Array.isArray(j.suggestions) ? j.suggestions : [];
    const out: PlaceSuggestion[] = [];
    for (const s of sugs) {
      if (!s.mapbox_id) continue;
      out.push({
        mapboxId: s.mapbox_id,
        title: stripPostal(s.name || "") || q,
        subtitle: stripPostal(s.place_formatted || s.full_address || ""),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Search Box API(/retrieve) で /suggest 候補の mapbox_id → 座標を取得（同一 session_token）。
 *  取得後はセッションを閉じる。失敗・座標欠落は null。 */
export async function retrievePlace(sug: PlaceSuggestion): Promise<PlaceHit | null> {
  const tok = mapboxToken();
  if (!tok) return null;
  try {
    const r = await fetch(
      `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(sug.mapboxId)}` +
        `?language=ja&session_token=${sessionToken()}&access_token=${tok}`
    );
    resetSearchSession(); // retrieve でセッション完了 → 次入力は新セッション
    if (!r.ok) return null;
    const j = (await r.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: { name?: string; place_formatted?: string };
      }>;
    };
    const f = Array.isArray(j.features) ? j.features[0] : null;
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2) return null;
    return {
      lat: c[1],
      lng: c[0],
      title: stripPostal(f?.properties?.name || "") || sug.title,
      subtitle: stripPostal(f?.properties?.place_formatted || "") || sug.subtitle,
    };
  } catch {
    resetSearchSession();
    return null;
  }
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
    // 住所タイプの結果は Mapbox が name/place_formatted を「〒285-0807 千葉県…」と郵便番号込みで返す。
    // 目的地名(dest-box)が郵便番号ぶん横長になるので、先頭の郵便番号(〒NNN-NNNN)を除去する（module の stripPostal）。
    const out: PlaceHit[] = [];
    for (const f of feats) {
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const title = stripPostal(f.properties?.name || "") || q;
      out.push({
        lat: c[1],
        lng: c[0],
        title,
        subtitle: stripPostal(f.properties?.place_formatted || ""),
      });
    }
    return out;
  } catch {
    return [];
  }
}
