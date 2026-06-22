import type { Pt } from "./nav";

/** 現在地・時刻から太陽高度を求め、日中(地平線上)かを返す。
 *  NOAAの近似式（fractional year法）。API不要・オフライン可・精度±数分。
 *  date はローカル時刻でよい（内部でUTCに変換して計算）。 */
export function isDaytime(lat: number, lon: number, date: Date): boolean {
  const rad = Math.PI / 180;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86400000);
  const hour =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hour - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma)); // 分
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma); // ラジアン
  const timeOffset = eqTime + 4 * lon; // 分（UTC基準なのでtz=0）
  const tst = hour * 60 + timeOffset; // 真太陽時(分)
  const ha = tst / 4 - 180; // 時角(度)
  const cosZen =
    Math.sin(lat * rad) * Math.sin(decl) +
    Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha * rad);
  const elevation = 90 - Math.acos(Math.max(-1, Math.min(1, cosZen))) / rad;
  return elevation > -0.833; // 大気差を考慮した地平線
}

/** 現在地と時刻から、表示テーマを返す（日中=light, 夜=dark） */
export function sunTheme(pos: Pt, date: Date): "light" | "dark" {
  return isDaytime(pos.lat, pos.lng, date) ? "light" : "dark";
}
