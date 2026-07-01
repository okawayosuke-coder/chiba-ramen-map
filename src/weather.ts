// 現在地の天気予報（Open-Meteo・無料/APIキー不要）。画面下部の横長バーで使う。
// 既に標高取得で open-meteo を使用済み。ここでは current(現在)＋daily(今日〜7日)を取得する。
// Open-Meteoは数値予報モデル(格子点)で物理的な観測所は無い。表示用の「予報地点」は、レスポンスが返す
// 実際の格子点座標(latitude/longitude)を逆ジオコーディングした市区町村名(place)で示す。

import { reverseCityName } from "./geocode";

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
  place?: string; // 予報地点(Open-Meteoが実際に使った格子点)の市区町村名。逆ジオで解決・失敗時は未設定
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

/** 指定地点の天気(現在＋7日)。約1km丸めでキャッシュ共有。取得不可は null。
 *  force=true でキャッシュを無視して再取得（定期自動更新で最新化＋更新時刻を進めるため）。 */
export async function fetchWeather(
  lat: number,
  lng: number,
  force = false
): Promise<Weather | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const c = cache.get(key);
  if (!force && c && Date.now() - c.fetchedAt < TTL) return c;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weather_code,precipitation,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=Asia%2FTokyo&forecast_days=7`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.current || !d.daily) return null;
    const wx: Weather = {
      current: {
        temp: d.current.temperature_2m,
        code: d.current.weather_code,
        precip: d.current.precipitation,
        wind: d.current.wind_speed_10m,
      },
      daily: (d.daily.time as string[]).map((date, i) => ({
        date,
        code: d.daily.weather_code[i],
        tmax: d.daily.temperature_2m_max[i],
        tmin: d.daily.temperature_2m_min[i],
        pop: d.daily.precipitation_probability_max[i],
      })),
      fetchedAt: Date.now(),
    };
    // 予報地点(実際に使われた格子点)を逆ジオして市区町村名を付与。無ければ要求座標で代替。失敗時は未設定。
    const glat = typeof d.latitude === "number" ? d.latitude : lat;
    const glng = typeof d.longitude === "number" ? d.longitude : lng;
    wx.place = (await reverseCityName(glat, glng)) ?? undefined;
    cache.set(key, wx);
    return wx;
  } catch {
    return null;
  }
}
