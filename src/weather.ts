// 現在地の天気予報。画面下部の横長バーで使う。
// 主系: Open-Meteo（無料/APIキー不要・緯度経度直指定・現在値/風/降水完備）。
// フォールバック: 気象庁の予報JSON（政府ソース・高可用）。Open-Meteoが落ちた/詰まった時だけ使う。
//   気象庁JSONは予報区(office)単位なので「現在地 → muniCd(GSI逆ジオ) → office(jma-area.json)」で辿る。
//   気象庁の当日予報には現在の風速・降水量が無いため、フォールバック時は風/降水を出さず気温・天気・降水確率のみ。
// Open-Meteoは数値予報モデル(格子点)で観測所は無い。表示用の「予報地点」はレスポンスの格子点座標を逆ジオした
//   市区町村名(place)で示す（気象庁側は逆ジオで得た市区町村名をそのまま place に使う）。

import { reverseCityName, reverseMuni } from "./geocode";
import jmaArea from "./data/jma-area.json";

const JMA_OFFICE = (jmaArea as { office: Record<string, string> }).office;
const JMA_AREA10 = (jmaArea as { area10: Record<string, string> }).area10;

export interface DailyWx {
  date: string; // "YYYY-MM-DD"(JST)
  code: number; // WMO天気コード
  tmax: number;
  tmin: number;
  pop: number; // 降水確率(%)・その日の最大
}
export interface Weather {
  current: { temp: number; code: number; precip: number; wind: number };
  daily: DailyWx[];
  fetchedAt: number;
  place?: string; // 予報地点の市区町村名。逆ジオで解決・失敗時は未設定
  source?: "open-meteo" | "jma"; // 取得元。jma はフォールバック（気象庁）で風・降水は非表示
}

// WMO天気コード→絵文字＋日本語ラベル
const WMO: Record<number, [string, string]> = {
  0: ["☀️", "快晴"],
  1: ["🌤", "晴れ"],
  2: ["⛅", "薄曇り"],
  3: ["☁️", "曇り"],
  45: ["🌫", "霧"],
  48: ["🌫", "霧氷"],
  51: ["🌦", "霧雨"],
  53: ["🌦", "霧雨"],
  55: ["🌦", "強い霧雨"],
  56: ["🌧", "着氷性の霧雨"],
  57: ["🌧", "着氷性の霧雨"],
  61: ["🌧", "小雨"],
  63: ["🌧", "雨"],
  65: ["🌧", "強い雨"],
  66: ["🌧", "着氷性の雨"],
  67: ["🌧", "着氷性の雨"],
  71: ["🌨", "小雪"],
  73: ["🌨", "雪"],
  75: ["🌨", "大雪"],
  77: ["🌨", "霧雪"],
  80: ["🌦", "にわか雨"],
  81: ["🌦", "にわか雨"],
  82: ["⛈", "激しいにわか雨"],
  85: ["🌨", "にわか雪"],
  86: ["🌨", "強いにわか雪"],
  95: ["⛈", "雷雨"],
  96: ["⛈", "雷雨(雹)"],
  99: ["⛈", "激しい雷雨(雹)"],
};
export function wmo(code: number): { emoji: string; label: string } {
  const e = WMO[code] || ["❓", "不明"];
  return { emoji: e[0], label: e[1] };
}

const cache = new Map<string, Weather>();
const TTL = 30 * 60 * 1000; // 30分キャッシュ（過剰取得を抑制）

/** URLをタイムアウト付きで取得しJSONを返す。応答なしでハングさせないため必ず ms で打ち切る。
 *  失敗（タイムアウト/非OK/例外）は null。 */
async function fetchJson(url: string, ms: number): Promise<unknown> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** 指定地点の天気(現在＋7日)。約1km丸めでキャッシュ共有。取得不可は null。
 *  force=true でキャッシュを無視して再取得（定期自動更新で最新化＋更新時刻を進めるため）。
 *  主系Open-Meteoが失敗したら気象庁へフォールバックする。 */
export async function fetchWeather(
  lat: number,
  lng: number,
  force = false
): Promise<Weather | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const c = cache.get(key);
  if (!force && c && Date.now() - c.fetchedAt < TTL) return c;

  const om = await fetchOpenMeteo(lat, lng);
  if (om) {
    cache.set(key, om);
    return om;
  }

  const jma = await fetchJmaWeather(lat, lng);
  if (jma) {
    cache.set(key, jma);
    return jma;
  }

  return null;
}

/** 主系: Open-Meteo。8秒でタイムアウト。失敗時 null。 */
async function fetchOpenMeteo(lat: number, lng: number): Promise<Weather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,precipitation,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FTokyo&forecast_days=7`;
  const d = (await fetchJson(url, 8000)) as {
    current?: { temperature_2m: number; weather_code: number; precipitation: number; wind_speed_10m: number };
    daily?: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
    };
    latitude?: number;
    longitude?: number;
  } | null;
  if (!d || !d.current || !d.daily) return null;
  const wx: Weather = {
    current: {
      temp: d.current.temperature_2m,
      code: d.current.weather_code,
      precip: d.current.precipitation,
      wind: d.current.wind_speed_10m,
    },
    daily: d.daily.time.map((date, i) => ({
      date,
      code: d.daily!.weather_code[i],
      tmax: d.daily!.temperature_2m_max[i],
      tmin: d.daily!.temperature_2m_min[i],
      pop: d.daily!.precipitation_probability_max[i],
    })),
    fetchedAt: Date.now(),
    source: "open-meteo",
  };
  // 予報地点(実際に使われた格子点)を逆ジオして市区町村名を付与。無ければ要求座標で代替。失敗時は未設定。
  const glat = typeof d.latitude === "number" ? d.latitude : lat;
  const glng = typeof d.longitude === "number" ? d.longitude : lng;
  wx.place = (await reverseCityName(glat, glng)) ?? undefined;
  return wx;
}

/** フォールバック: 気象庁の予報JSON。現在地→muniCd→office を辿って取得・パースする。 */
async function fetchJmaWeather(lat: number, lng: number): Promise<Weather | null> {
  const muni = await reverseMuni(lat, lng);
  if (!muni) return null;
  let office = JMA_OFFICE[muni.code];
  let area10: string | undefined = JMA_AREA10[muni.code];
  if (!office) {
    // 政令市の行政区（例: 千葉市中央区=12101）は気象庁が市本体（12100）単位で予報を持つため、
    // 区コードの下2桁を丸めた市本体コードで引き直す。
    const city = String(Math.floor(parseInt(muni.code, 10) / 100) * 100);
    office = JMA_OFFICE[city];
    area10 = JMA_AREA10[city];
  }
  if (!office) return null; // それでも引けない（横浜市等・気象庁が地理分割する政令市。対象エリア外）はフォールバック不可
  const data = await fetchJson(
    `https://www.jma.go.jp/bosai/forecast/data/forecast/${office}.json`,
    8000
  );
  if (!Array.isArray(data) || !data.length) return null;
  try {
    return parseJma(data, area10, muni.name);
  } catch {
    return null;
  }
}

/* ---- 気象庁JSONパースのヘルパー ---- */

// 気象庁天気コード(3桁)→WMOコード。既存の wmo() をそのまま使うため WMO に寄せる。
// 主要コードは EXACT で精密に、それ以外は百の位(1晴2曇3雨4雪)＋一時/時々の含意で近似する。
function jmaCodeToWmo(codeStr: string | undefined): number {
  const code = parseInt(codeStr ?? "", 10);
  if (!code) return 3;
  const EXACT: Record<number, number> = {
    100: 0, // 晴れ
    123: 95, 124: 71, 130: 45, 131: 45,
    200: 3, // くもり
    209: 45, 231: 45,
    300: 63, 304: 66, 306: 65, 308: 65, 328: 65, 329: 66, 350: 95,
    400: 73, 405: 75, 406: 75, 407: 75, 425: 75, 430: 71, 450: 95,
  };
  if (EXACT[code] != null) return EXACT[code];
  const head = Math.floor(code / 100);
  if (head === 1) {
    // 晴れベース
    if ([104, 105, 115, 116, 117, 125].includes(code)) return 71; // 雪含み
    if (code >= 102) return 80; // にわか雨含み
    return 1;
  }
  if (head === 2) {
    // くもりベース
    if ([204, 205, 215, 216, 217, 228, 229, 230, 250].includes(code)) return 73; // 雪含み
    if (code >= 202) return 80; // にわか雨含み
    return 3;
  }
  if (head === 3) return 63; // 雨
  if (head === 4) return 73; // 雪
  return 3;
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isNaN(n) ? fallback : n;
}

interface JmaArea {
  area: { name: string; code: string };
  weatherCodes?: string[];
  pops?: string[];
  temps?: string[];
  tempsMax?: string[];
  tempsMin?: string[];
}
interface JmaTS {
  timeDefines: string[];
  areas: JmaArea[];
}
interface JmaBlock {
  timeSeries: JmaTS[];
}

// 一次細分区コード(area10)に一致するエリアを選ぶ。無ければ先頭（県代表）。
function pickArea(areas: JmaArea[], code: string | undefined): JmaArea {
  return (code ? areas.find((a) => a.area?.code === code) : undefined) ?? areas[0];
}

// tmax/tmin の NaN を近接日の値で埋める（前方→後方の順）。全滅なら 0。
function fillTemps(daily: DailyWx[]): void {
  for (let i = 1; i < daily.length; i++) {
    if (isNaN(daily[i].tmax)) daily[i].tmax = daily[i - 1].tmax;
    if (isNaN(daily[i].tmin)) daily[i].tmin = daily[i - 1].tmin;
  }
  for (let i = daily.length - 2; i >= 0; i--) {
    if (isNaN(daily[i].tmax)) daily[i].tmax = daily[i + 1].tmax;
    if (isNaN(daily[i].tmin)) daily[i].tmin = daily[i + 1].tmin;
  }
  for (const d of daily) {
    if (isNaN(d.tmax)) d.tmax = 0;
    if (isNaN(d.tmin)) d.tmin = 0;
  }
}

// 気象庁の予報JSON(ブロック配列)を Weather に変換。
// 週間予報ブロック(timeSeries[0]が5日以上)を主に、当日は短期予報ブロックで補完する。
function parseJma(data: JmaBlock[], area10: string | undefined, placeName: string): Weather | null {
  const weekly =
    data.find((b) => (b?.timeSeries?.[0]?.timeDefines?.length ?? 0) >= 5) ?? data[data.length - 1];
  const wts = weekly.timeSeries;
  const wCodeTS = wts[0]; // weatherCodes, pops
  const wTempTS = wts.find((ts) => ts.areas?.[0]?.tempsMax) ?? wts[1];
  const cArea = wCodeTS.areas[0];
  const tArea = wTempTS ? wTempTS.areas[0] : null;
  const dates = wCodeTS.timeDefines.map((t) => t.slice(0, 10));
  if (!dates.length) return null;

  const daily: DailyWx[] = dates.map((date, i) => ({
    date,
    code: jmaCodeToWmo(cArea.weatherCodes?.[i]),
    pop: toNum(cArea.pops?.[i], 0),
    tmax: toNum(tArea?.tempsMax?.[i], NaN),
    tmin: toNum(tArea?.tempsMin?.[i], NaN),
  }));

  // 短期予報ブロックで当日(index 0)を補完＋現在気温を得る
  const short = data.find((b) => b !== weekly) ?? null;
  let curTemp = NaN;
  if (short) {
    const sCodeTS = short.timeSeries.find((ts) => ts.areas?.[0]?.weatherCodes);
    const sPopTS = short.timeSeries.find((ts) => ts.areas?.[0]?.pops);
    const sTempTS = short.timeSeries.find((ts) => ts.areas?.[0]?.temps);
    if (sCodeTS) {
      const a = pickArea(sCodeTS.areas, area10);
      if (a?.weatherCodes?.[0]) daily[0].code = jmaCodeToWmo(a.weatherCodes[0]);
    }
    if (sPopTS) {
      const a = pickArea(sPopTS.areas, area10);
      const todays = (a?.pops ?? [])
        .filter((_, k) => sPopTS.timeDefines[k]?.slice(0, 10) === dates[0])
        .map((x) => toNum(x, NaN))
        .filter((n) => !isNaN(n));
      if (todays.length) daily[0].pop = Math.max(...todays);
    }
    if (sTempTS) {
      const a = sTempTS.areas[0];
      const todays = (a?.temps ?? [])
        .filter((_, k) => sTempTS.timeDefines[k]?.slice(0, 10) === dates[0])
        .map((x) => toNum(x, NaN))
        .filter((n) => !isNaN(n));
      if (todays.length) {
        daily[0].tmax = Math.max(...todays);
        daily[0].tmin = Math.min(...todays);
      }
      const first = (a?.temps ?? []).map((x) => toNum(x, NaN)).find((n) => !isNaN(n));
      if (first != null && !isNaN(first)) curTemp = first;
    }
  }

  fillTemps(daily);
  if (isNaN(curTemp)) curTemp = daily[0].tmax;

  return {
    current: { temp: curTemp, code: daily[0].code, precip: 0, wind: NaN },
    daily: daily.slice(0, 7),
    fetchedAt: Date.now(),
    place: placeName || undefined,
    source: "jma",
  };
}
