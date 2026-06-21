import { haversineKm } from "./nav";

/** 走行軌跡（GPSトラック）。走行モード中に記録し、地図表示・GPX書き出しに使う。
 *  React stateにすると高頻度更新でクラスタが再描画されるため、モジュール内で保持し
 *  購読(subscribe)で描画側へ通知する（描画はimperative）。localStorageに永続化。 */
export interface TrackPoint {
  lat: number;
  lng: number;
  t: number;
}

const KEY = "crm_track";
const MAX = 10000; // 上限点数
const MIN_M = 20; // 記録間隔(m)

let points: TrackPoint[] = load();
const listeners = new Set<() => void>();
let saveTimer: number | undefined;

function load(): TrackPoint[] {
  try {
    const v = localStorage.getItem(KEY);
    const a = v ? JSON.parse(v) : [];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(points));
    } catch {
      /* 容量超過は無視 */
    }
  }, 1500);
}
function emit() {
  listeners.forEach((l) => l());
}

/** 走行モードのGPS更新ごとに呼ぶ。前回から約20m以上動いた時だけ記録 */
export function addTrackPoint(lat: number, lng: number, t: number) {
  const last = points[points.length - 1];
  if (
    last &&
    haversineKm({ lat: last.lat, lng: last.lng }, { lat, lng }) * 1000 < MIN_M
  )
    return;
  points.push({ lat, lng, t });
  if (points.length > MAX) points = points.slice(points.length - MAX);
  save();
  emit();
}

export function getTrackPoints(): TrackPoint[] {
  return points;
}

export function clearTrack() {
  points = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
  emit();
}

export function subscribeTrack(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function trackStats() {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  const durMs =
    points.length >= 2 ? points[points.length - 1].t - points[0].t : 0;
  return { count: points.length, km, durMin: Math.round(durMs / 60000) };
}

/** GPXファイルとしてダウンロード */
export function downloadTrackGPX() {
  if (points.length === 0) return;
  const seg = points
    .map(
      (p) =>
        `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(
          p.t
        ).toISOString()}</time></trkpt>`
    )
    .join("");
  const gpx =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="千葉ラーメンMAP" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>走行軌跡</name><trkseg>${seg}</trkseg></trk></gpx>`;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chiba-ramen-track.gpx";
  a.click();
  URL.revokeObjectURL(url);
}
