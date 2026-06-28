import { memo, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Shop } from "../types";
import { bearingDeg, fmtDistance, haversineKm, roughMinutes, type Pt, type Dest } from "../nav";
import { fetchRoute, projectOnRoute } from "../route";
import { loadHighway, type HwFacility, type HwKind } from "../highwayData";
import { fetchPois, poiBrandStyle, poiIconFile, type Poi, type PoiKind, type BBox } from "../poi";
import {
  loadLocalPois,
  coverageContains,
  localPoisInView,
  LOCAL_KINDS,
  type LocalPoiData,
} from "../poiData";
import { fetchWeather, wmo, type Weather } from "../weather";
import { reverseAddressNoBanchi } from "../geocode";
import { addTrackPoint, getTrackPoints, subscribeTrack } from "../track";
import type { HwOverride } from "../storage";

/** Props は Leaflet 版 RamenMap と完全に同一（ドロップイン差し替え用）。
 *  Phase 1 では shops/focus/userPos/bigLabels/各操作コールバックのみ実装し、
 *  follow/dest/POI/HUD 系（運転モード・経路・勾配など）は Phase 2 以降で追加する。 */
interface Props {
  shops: Shop[];
  focus: Shop | null;
  follow: boolean;
  paneHidden: boolean;
  poiKinds: PoiKind[];
  showTrack: boolean;
  bigLabels: boolean;
  gyroGrade: boolean;
  headingUp?: boolean; // 走行中の地図の向き: true=ヘディングアップ / false=ノースアップ(既定)
  theme?: string; // "dark" | "light"。夜間は地図スタイルをdarkへ切替（Leaflet版はタイルにCSSフィルタ）
  hwOverride: HwOverride;
  onCycleHwOverride: () => void;
  dest: Dest | null;
  onSetDest: (s: Dest) => void;
  onClearDest: () => void;
  userPos: Pt | null;
  isFav: (s: Shop) => boolean;
  onToggleFav: (s: Shop) => void;
  onNav: (s: Dest) => void;
  onShare: (s: Shop) => void;
  distanceTo: (s: Shop) => number | null;
}

const STYLE_LIGHT = "mapbox://styles/mapbox/streets-v12";
const STYLE_DARK = "mapbox://styles/mapbox/dark-v11"; // 夜間用。streets-v12と同じMapbox Streetsソース＝日本語化(name_ja)も同様に効く
const styleFor = (t?: string): string => (t === "dark" ? STYLE_DARK : STYLE_LIGHT);
const MB_VIEW_KEY = "crm_mapview_mb"; // Mapbox 用（bearing/pitch も保存）
const LEAFLET_VIEW_KEY = "crm_mapview"; // 互換: Leaflet 版の保存位置を初期復元に流用

type View = { lng: number; lat: number; zoom: number; bearing: number; pitch: number };

/** トークン解決: ビルド時 env(VITE_MAPBOX_TOKEN＝GitHub Actions secret から注入) を最優先、
 *  なければ localStorage(mapbox_poc_token)、どちらも無ければ null（→アプリ内の入力欄を表示）。
 *  secret を設定すればビルド成果物にだけ埋め込まれ、端末ごとの入力が不要になる（ソースには残さない）。 */
function resolveToken(): string | null {
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

function getInitialView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(MB_VIEW_KEY) || "null");
    if (v && isFinite(v.lng) && isFinite(v.lat) && v.zoom >= 3 && v.zoom <= 20)
      return { lng: v.lng, lat: v.lat, zoom: v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 };
  } catch {
    /* 破損値は無視 */
  }
  try {
    // Leaflet 版の保存位置（{lat,lng,z}）があれば引き継ぐ
    const v = JSON.parse(localStorage.getItem(LEAFLET_VIEW_KEY) || "null");
    if (v && isFinite(v.lat) && isFinite(v.lng) && v.z >= 3 && v.z <= 19)
      return { lng: v.lng, lat: v.lat, zoom: v.z, bearing: 0, pitch: 0 };
  } catch {
    /* 破損値は無視 */
  }
  return { lng: 140.18, lat: 35.55, zoom: 10, bearing: 0, pitch: 0 };
}

function shopsGeoJSON(shops: Shop[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: shops.map((s, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: { idx: i, rating: s.rating, ratingText: s.rating.toFixed(1), tier: tierOf(s.rating) },
    })),
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c)
  );
}

/** text-size を factor 倍する。ズーム依存(interpolate/step)の式は出力値だけを再帰的に倍率適用する
 *  （["*", expr, f] と単純に掛けると「zoom式は乗算の中に置けない」エラーになるため）。 */
function scaleSize(v: unknown, f: number): unknown {
  if (f === 1) return v;
  if (typeof v === "number") return v * f;
  if (Array.isArray(v)) {
    const op = v[0];
    if (op === "interpolate" || op === "interpolate-hcl" || op === "interpolate-lab") {
      // ["interpolate", interp, input, in0, out0, in1, out1, ...] → 出力(out)だけ倍率
      const out: unknown[] = v.slice(0, 3);
      for (let i = 3; i < v.length; i += 2) {
        out.push(v[i]);
        out.push(scaleSize(v[i + 1], f));
      }
      return out;
    }
    if (op === "step") {
      // ["step", input, out0, in1, out1, ...] → 出力だけ倍率
      const out: unknown[] = v.slice(0, 2);
      out.push(scaleSize(v[2], f));
      for (let i = 3; i < v.length; i += 2) {
        out.push(v[i]);
        out.push(scaleSize(v[i + 1], f));
      }
      return out;
    }
  }
  return v; // 数値でも interpolate/step でもない式は触らない（安全側）
}

// 種類→マーカー形状クラス（色は poiBrandStyle のインライン指定。CSSはLeaflet版と共通）
const POI_SHAPE: Record<PoiKind, string> = {
  conv: "poi--conv",
  fuel: "poi--fuel",
  parking: "poi--parking",
  ev: "poi--ev",
  toilet: "poi--toilet",
};

// ===== 勾配メーター（DEMベース・傾斜計）。Leaflet版 RamenMap.tsx から移植 =====
const GRADE_FLAT = 1.5; // これ未満は「ほぼ平坦」
const GRADE_SLOPE_ON = 2.2; // 平坦→「坂」表示に切替える閾値（ヒステリシス帯でちらつき抑制）
const GRADE_MED_N = 3; // 中央値フィルタ窓（孤立した偽勾配を無視）
const GRADE_MAX_PLAUSIBLE = 25; // これ超はDEM/経路ノイズとして無視
const GRADE_SPACING_KM = 0.08; // この先予告用の経路マーク間隔(80m)
const GRADE_LOOK = 11; // 前方何マーク先まで見るか（80m×11＝約880m先まで予告）
const GRADE_STEEP = 8; // この先「急勾配」と警告する閾値(%)

/** 標高を数値(m)で返す。GSI高精度DEM→open-meteo概算の順。海域/取得不可は null。セッション内キャッシュ。 */
const _eleNumCache = new Map<string, number | null>();
async function fetchElevationNum(lat: number, lng: number): Promise<number | null> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = _eleNumCache.get(key);
  if (hit !== undefined) return hit;
  let val: number | null = null;
  try {
    const r = await fetch(
      `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`
    );
    const j = await r.json();
    if (j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation)))
      val = Number(j.elevation);
  } catch {
    /* GSI失敗時は予備へ */
  }
  if (val === null) {
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
      const j = await r.json();
      if (j && Array.isArray(j.elevation) && j.elevation[0] != null) val = Number(j.elevation[0]);
    } catch {
      /* 取得不可 */
    }
  }
  _eleNumCache.set(key, val);
  return val;
}

/** 標高を「12.3 m」形式の文字列で返す（GSI高精度DEM→open-meteo概算）。自車横の常設標高表示用。Leaflet版 fetchElevation 移植。 */
async function fetchElevationStr(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await fetch(
      `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`
    );
    const j = await r.json();
    if (j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation)))
      return `${Number(j.elevation).toFixed(1)} m`;
  } catch {
    /* GSI失敗時は予備へ */
  }
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
    const j = await r.json();
    if (j && Array.isArray(j.elevation) && j.elevation[0] != null)
      return `${Number(j.elevation[0]).toFixed(0)} m（概算）`;
  } catch {
    /* 取得不可 */
  }
  return null;
}

/** スケールバー用の「キリの良い数」。Leaflet標準(1/2/3/5)に1.5・7も許可＝…300/200/150/100/70/50…（150mを出すため）。 */
function roundNum150(num: number): number {
  const pow10 = Math.pow(10, String(Math.floor(num)).length - 1);
  const d0 = num / pow10;
  const d = d0 >= 10 ? 10 : d0 >= 7 ? 7 : d0 >= 5 ? 5 : d0 >= 3 ? 3 : d0 >= 2 ? 2 : d0 >= 1.5 ? 1.5 : 1;
  return pow10 * d;
}

/** 半段(0.5)ズームの +/- コントロール（Leaflet zoomDelta/zoomSnap=0.5 移植）。
 *  Mapbox標準は1段ズーム＝ユーザに「一回タップで2段階」に感じられ、かつ縮尺150mを飛ばすため自作。 */
class HalfStepZoomControl implements mapboxgl.IControl {
  private _c?: HTMLDivElement;
  onAdd(map: mapboxgl.Map): HTMLElement {
    const c = document.createElement("div");
    c.className = "mapboxgl-ctrl mapboxgl-ctrl-group";
    const mk = (kind: "in" | "out", delta: number, aria: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `mapboxgl-ctrl-zoom-${kind}`;
      b.setAttribute("aria-label", aria);
      const ic = document.createElement("span");
      ic.className = "mapboxgl-ctrl-icon";
      ic.setAttribute("aria-hidden", "true");
      b.appendChild(ic);
      b.addEventListener("click", () => {
        const z = map.getZoom();
        // 0.5刻みにスナップ（zoomSnap=0.5相当）
        const next = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), Math.round((z + delta) * 2) / 2));
        map.easeTo({ zoom: next, duration: 200 });
      });
      return b;
    };
    c.appendChild(mk("in", 0.5, "ズームイン"));
    c.appendChild(mk("out", -0.5, "ズームアウト"));
    this._c = c;
    return c;
  }
  onRemove(): void {
    this._c?.remove();
    this._c = undefined;
  }
}

/** 150mを出せるスケールバー（Leaflet ScaleWith150 移植）。Mapbox標準ScaleControlは1.5倍を出さず150mが出ないため自作。 */
class Scale150Control implements mapboxgl.IControl {
  private _map?: mapboxgl.Map;
  private _el?: HTMLDivElement;
  private _update = () => {};
  onAdd(map: mapboxgl.Map): HTMLElement {
    this._map = map;
    const el = document.createElement("div");
    el.className = "mapboxgl-ctrl mapboxgl-ctrl-scale";
    this._el = el;
    const maxWidth = 130;
    this._update = () => {
      const y = map.getContainer().clientHeight / 2;
      const maxMeters = map.unproject([0, y]).distanceTo(map.unproject([maxWidth, y]));
      if (!isFinite(maxMeters) || maxMeters <= 0) return;
      const dist = roundNum150(maxMeters);
      el.style.width = `${Math.round(maxWidth * (dist / maxMeters))}px`;
      el.textContent = dist >= 1000 ? `${dist / 1000} km` : `${dist} m`;
    };
    map.on("move", this._update);
    this._update();
    return el;
  }
  onRemove(): void {
    if (this._map) this._map.off("move", this._update);
    this._el?.remove();
    this._map = undefined;
  }
}

/** from から進行方位 headingDeg(0=北) 方向へ distM メートル進んだ地点。 */
function pointAhead(from: Pt, headingDeg: number, distM: number): Pt {
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111320;
  const dLng = (distM * Math.sin(rad)) / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

/** 経路 coords を距離 spacingKm ごとのマーク点に分割。marks[i] は始点から i*spacingKm の地点（Leaflet版移植）。 */
function buildMarks(coords: [number, number][], spacingKm: number): Pt[] {
  const marks: Pt[] = [];
  if (coords.length === 0) return marks;
  marks.push({ lat: coords[0][0], lng: coords[0][1] });
  let acc = 0;
  let next = spacingKm;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lat: coords[i][0], lng: coords[i][1] };
    const b = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
    const seg = haversineKm(a, b);
    if (seg <= 0) continue;
    while (acc + seg >= next) {
      const t = (next - acc) / seg;
      marks.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      next += spacingKm;
    }
    acc += seg;
  }
  return marks;
}

type GradeMeter = {
  tilt: SVGElement;
  road: SVGElement;
  label: SVGElement;
  warn: HTMLElement;
  hist: number[];
  flat: boolean;
};
const _gradeMeters = new WeakMap<HTMLElement, GradeMeter>();

/** box 内に傾斜計SVGを一度だけ構築（以後は属性更新でなめらかにアニメ）。軽バン側面シルエット。 */
function ensureGradeMeter(box: HTMLElement): GradeMeter {
  const cached = _gradeMeters.get(box);
  if (cached) return cached;
  box.innerHTML =
    '<svg class="grade-meter" viewBox="0 0 170 96" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="20" y1="56" x2="150" y2="56" stroke="#3a3f47" stroke-width="2" stroke-dasharray="2 5"/>' +
    '<g class="gm-tilt">' +
    '<line class="gm-road" x1="27" y1="56" x2="143" y2="56" stroke="#9aa0a6" stroke-width="6" stroke-linecap="round"/>' +
    '<g class="gm-car">' +
    '<path d="M56 53 L56 31 Q56 29 58 29 L105 29 Q109 29 111 33 L114 46 L114 53 Z" fill="#86a980"/>' +
    '<path d="M63 33 L85 33 L85 43 L63 43 Z" fill="#222a25"/>' +
    '<path d="M88 33 L104 33 Q106 33 107 36 L107 43 L88 43 Z" fill="#222a25"/>' +
    '<rect x="56.4" y="33" width="2.6" height="8" rx="0.8" fill="#ff5a5a"/>' +
    '<circle cx="112" cy="47" r="2.3" fill="#ffe07a"/>' +
    '<circle cx="67" cy="54" r="5.2" fill="#181b20" stroke="#e8e6e1" stroke-width="1.8"/>' +
    '<circle cx="103" cy="54" r="5.2" fill="#181b20" stroke="#e8e6e1" stroke-width="1.8"/>' +
    "</g></g>" +
    '<text class="gm-label" x="85" y="91" text-anchor="middle" font-size="30" font-weight="800" fill="#cdd3da">0%</text>' +
    "</svg>" +
    '<div class="grade-warn" style="display:none"></div>';
  const m: GradeMeter = {
    tilt: box.querySelector(".gm-tilt") as SVGElement,
    road: box.querySelector(".gm-road") as SVGElement,
    label: box.querySelector(".gm-label") as SVGElement,
    warn: box.querySelector(".grade-warn") as HTMLElement,
    hist: [],
    flat: true,
  };
  _gradeMeters.set(box, m);
  return m;
}

/** 勾配メーター更新。Phase1の中央値フィルタ＋ヒステリシスで平坦路の偽勾配・ちらつきを抑制。
 *  （Phase2のジャイロvetoは既定OFF・横向き要再設計のためMapbox版では未移植）。 */
// Phase2(v2) ジャイロveto（Leaflet版移植・既定OFF=「ジャイロで平坦補正」トグル）。設置向き非依存で
// 端末の傾き(重力ベクトル)を見て、平坦姿勢のままDEMが坂と言う＝平坦路の偽勾配を平坦へveto（値は変えず表示のみ）。
const PITCH_FLAT_DEG = 1.5; // g0からの姿勢差がこれ未満なら「水平」(°)
const PITCH_ACC_GATE = 0.6; // |GPS速度微分|がこれ未満の時だけ傾きを信用(m/s^2)
const G0_GAIN = 0.05; // 平坦基準g0学習の低域通過ゲイン
const GRAV_LP = 0.9; // 重力ベクトル抽出の低域通過係数
// grade effect が書き込み(onMotion=g / onPos=accel,g0,enabled)、updateGradeMeter が demFlat 書込み＆veto読取り。
const _pitch = {
  g: null as number[] | null, // 低域通過した重力ベクトル(端末frame)
  g0: null as number[] | null, // 平坦走行時に学習した基準姿勢
  accel: 0, // GPS速度の微分(m/s^2)
  demFlat: true, // 直近のDEM勾配が平坦か(g0学習ゲート)
  enabled: false, // 設定トグル（既定OFF）
};
/** 2つの重力ベクトルのなす角(度)。設置向き非依存で端末姿勢変化＝路面pitchを測る。 */
function gravAngleDeg(a: number[], b: number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const ma = Math.hypot(a[0], a[1], a[2]);
  const mb = Math.hypot(b[0], b[1], b[2]);
  if (ma === 0 || mb === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (ma * mb)))) * 180) / Math.PI;
}

function updateGradeMeter(
  box: HTMLElement,
  grade: number | null,
  warn: { grade: number; distM: number } | null
) {
  const m = ensureGradeMeter(box);
  if (grade === null) {
    m.hist = [];
    m.flat = true;
    m.tilt.setAttribute("transform", "rotate(0 85 56)");
    m.road.setAttribute("stroke", "#9aa0a6");
    m.label.textContent = "—";
    m.label.setAttribute("fill", "#cdd3da");
    m.warn.style.display = "none";
    return;
  }
  m.hist.push(grade);
  if (m.hist.length > GRADE_MED_N) m.hist.shift();
  const sorted = [...m.hist].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (m.flat) {
    if (Math.abs(med) > GRADE_SLOPE_ON) m.flat = false;
  } else if (Math.abs(med) < GRADE_FLAT) {
    m.flat = true;
  }
  // 直近のDEM勾配が平坦か＝grade effectのg0(基準姿勢)学習ゲートへ渡す（坂で学習しないため）
  _pitch.demFlat = Math.abs(med) < GRADE_FLAT;
  // Phase2 ジャイロveto: トグルON＆基準学習済＆加減速小＆端末姿勢が平坦基準に近いのにDEMが坂
  // ＝平坦路の偽勾配とみなして平坦表示へ。OFF/未学習/加減速中はDEMのまま（安全劣化）。
  if (
    _pitch.enabled &&
    !m.flat &&
    _pitch.g != null &&
    _pitch.g0 != null &&
    Math.abs(_pitch.accel) < PITCH_ACC_GATE &&
    gravAngleDeg(_pitch.g, _pitch.g0) < PITCH_FLAT_DEG
  ) {
    m.flat = true;
  }
  const flat = m.flat;
  const col = flat ? "#9aa0a6" : med > 0 ? "#EF9F27" : "#378ADD"; // 平坦灰/上り琥珀/下り青
  const labelCol = flat ? "#cdd3da" : med > 0 ? "#FAC775" : "#85B7EB";
  const ang = flat ? 0 : Math.max(-34, Math.min(34, med * 2.2)); // 視認性のため誇張（数値は実値）
  m.tilt.setAttribute("transform", `rotate(${(-ang).toFixed(1)} 85 56)`);
  m.road.setAttribute("stroke", col);
  const g = Math.abs(Math.round(med));
  m.label.textContent = flat ? "0%" : med > 0 ? `↗ ${g}%` : `↘ ${g}%`;
  m.label.setAttribute("fill", labelCol);
  if (warn) {
    m.warn.style.display = "";
    m.warn.textContent = `⚠ この先 ${warn.grade > 0 ? "↑" : "↓"}${Math.abs(Math.round(warn.grade))}%・${warn.distM}m`;
  } else {
    m.warn.style.display = "none";
  }
}

// 評価ティアの色（Leaflet rawTierColor と同じ）。tier 0:<4.1 / 1:4.1+ / 2:4.3+
const TIER_COLORS = ["#1c7ed6", "#e8590c", "#d6336c"];
function tierOf(r: number): number {
  return r >= 4.3 ? 2 : r >= 4.1 ? 1 : 0;
}

/** 速度→色（走行軌跡・速度計で共通）。<10赤 / <30黄 / <50緑 / ≥50青。 */
function kmhColor(kmh: number): string {
  if (kmh < 10) return "#e03131";
  if (kmh < 30) return "#f5b800";
  if (kmh < 50) return "#2f9e44";
  return "#1c7ed6";
}

/** 評価ピン（しずく型＋白円）の画像を生成。Leaflet版 pinIcon と同形状（rating数値は別途textレイヤー）。 */
function teardropImageData(color: string, scale: number): ImageData {
  const w = 34 * scale;
  const h = 44 * scale;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  const p = new Path2D("M17 1C8.7 1 2 7.7 2 16c0 10.5 15 27 15 27s15-16.5 15-27C32 7.7 25.3 1 17 1z");
  ctx.fillStyle = color;
  ctx.fill(p);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke(p);
  ctx.beginPath();
  ctx.arc(17, 16, 11, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  return ctx.getImageData(0, 0, w, h);
}

// 走行軌跡の速度別色（kmhColorと同配色）。0:不明/停止 灰, 1:<10 赤, 2:<30 黄, 3:<50 緑, 4:≥50 青
const TRK_COLORS = ["#868e96", "#e03131", "#f5b800", "#2f9e44", "#1c7ed6"];
function speedColorIdx(kmh: number | null): number {
  if (kmh == null) return 0;
  if (kmh < 10) return 1;
  if (kmh < 30) return 2;
  if (kmh < 50) return 3;
  return 4;
}
/** 走行軌跡の方向矢印（上向き三角・北基準。icon-rotateで進行方位へ回す）。Leaflet版 trk-tri と同形状。 */
function triangleImageData(color: string, scale: number): ImageData {
  const s = 16 * scale;
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(8, 1.5);
  ctx.lineTo(13.5, 14);
  ctx.lineTo(8, 11);
  ctx.lineTo(2.5, 14);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

/** 天気バーの中身HTML（Leaflet版と同一）。通常は当日のみ、.expanded で7日間。 */
function weatherBarHTML(wx: Weather): string {
  const c = wmo(wx.current.code);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const cur =
    `<div class="wx-cur">` +
    `<span class="wx-emoji">${c.emoji}</span>` +
    `<span class="wx-temp">${Math.round(wx.current.temp)}°</span>` +
    `<span class="wx-cur-sub">${c.label}<br>${
      wx.current.precip > 0 ? `☔${wx.current.precip}mm ・ ` : ""
    }💨${Math.round(wx.current.wind)}</span>` +
    `</div>`;
  const days = wx.daily
    .map((d, i) => {
      const w = wmo(d.code);
      const name = i === 0 ? "今日" : i === 1 ? "明日" : WD[new Date(d.date).getUTCDay()];
      return (
        `<div class="wx-day">` +
        `<span class="wx-day-name">${name}</span>` +
        `<span class="wx-day-emoji">${w.emoji}</span>` +
        `<span class="wx-day-pop">☔${d.pop ?? 0}%</span>` +
        `<span class="wx-day-temp"><b>${Math.round(d.tmax)}</b>/<span class="wx-lo">${Math.round(d.tmin)}</span></span>` +
        `</div>`
      );
    })
    .join("");
  const t = wx.daily[0];
  const today = t
    ? `<div class="wx-today"><span class="wx-day-pop">☔${t.pop ?? 0}%</span>` +
      `<span class="wx-day-temp"><b>${Math.round(t.tmax)}</b>/<span class="wx-lo">${Math.round(t.tmin)}</span></span></div>`
    : "";
  return (
    `<div class="wx-label">📍 天気</div>${cur}${today}` +
    `<div class="wx-days">${days}</div>` +
    `<span class="wx-toggle" aria-hidden="true">▾</span>`
  );
}

function RamenMapbox(props: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const firstFixRef = useRef(true);
  // 経路スナップ（無料のリアルタイムmap matching）: 経路effectが投影点＋道路方位を書き、
  // followeffectが自車位置/向きに使う。経路案内中だけ新鮮（at が近い）。
  const routeSnapRef = useRef<{ proj: Pt; bearing: number; at: number } | null>(null);
  const weatherBoxRef = useRef<HTMLDivElement | null>(null);
  const routeReapplyRef = useRef<(() => void) | null>(null); // 高速切替を次のGPS待たず即反映
  const hwToggleLabelRef = useRef<(() => void) | null>(null); // 高速トグルのラベル更新（follow基準effectが設定）
  const styleRef = useRef<string>(""); // 現在適用中の地図スタイルURL（テーマ切替の重複setStyle防止）
  const hwActiveRef = useRef(false); // 現在「高速道路扱い」か（経路effectが書き、勾配effectが勾配抑制に読む）
  // この先の急勾配予告: 経路effectが前方GRADE_LOOKマークの標高から最急(≥GRADE_STEEP%)を書き、勾配effectが表示に読む
  const aheadGradeRef = useRef<{ grade: number; distM: number } | null>(null);
  // 日本語化した name 系レイヤーの元 text-size を保持（bigLabels トグルで戻せるように）
  const labelOrigRef = useRef<Record<string, unknown>>({});
  const [tokenMissing, setTokenMissing] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [mapReady, setMapReady] = useState(false); // POIなど「地図準備後に貼る」effectのトリガ
  // POI種類の集合が変わった時だけ再取得（配列の同一性に依存しない）
  const poiKindsKey = useMemo(() => [...props.poiKinds].sort().join(","), [props.poiKinds]);
  // 目的地が変わった時だけ経路を貼り直す
  const destKey = useMemo(
    () => (props.dest ? `${props.dest.lat.toFixed(5)},${props.dest.lng.toFixed(5)}` : ""),
    [props.dest]
  );
  // 天気の再取得キー（現在地・約1km丸め）
  const wxPosKey = useMemo(
    () => (props.userPos ? `${props.userPos.lat.toFixed(2)},${props.userPos.lng.toFixed(2)}` : "center"),
    [props.userPos]
  );

  // imperative ハンドラから常に最新の props を読むための ref
  const propsRef = useRef(props);
  propsRef.current = props;

  // ---- 初期化（マウント時に一度だけ） ----
  useEffect(() => {
    const token = resolveToken();
    if (!token || !containerRef.current) {
      setTokenMissing(!token);
      return;
    }
    mapboxgl.accessToken = token;
    const v = getInitialView();
    styleRef.current = styleFor(propsRef.current.theme); // 初期スタイル（夜間ならdark）
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: styleRef.current,
      center: [v.lng, v.lat],
      zoom: v.zoom,
      bearing: v.bearing,
      pitch: v.pitch,
      maxZoom: 19,
      attributionControl: true,
    });
    mapRef.current = map;
    (window as unknown as Record<string, unknown>).__mbmap = map; // 検証/デバッグ用（試験エンジン時のみ）
    // ズーム+/- は左上（Leaflet版と同じ位置）。コンパスは出さない。Leaflet同様の半段(0.5)ズーム＝
    // 1タップ0.5段（標準1段だと「2段階」に感じる）＋縮尺150mを飛ばさない。CSSで大きくタップしやすく。
    map.addControl(new HalfStepZoomControl(), "top-left");
    // 縮尺バー（実距離m/km）。右下＝著作権表示の上。150mを出せる自作版（Leaflet ScaleWith150 移植）。
    map.addControl(new Scale150Control(), "bottom-right");
    map.touchZoomRotate.enableRotation(); // 2本指回転（ヘディングアップの素地）

    // コンテナのサイズ変化（左ペイン開閉・画面回転・ウィンドウリサイズ）で地図を再計測。
    // Mapboxはコンテナのサイズ変化を自動検知しないため、これが無いとペインを閉じた時に
    // 右側が空白のまま（旧サイズで描画され続ける）になる。
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    let wired = false; // クリック等のインタラクションは1度だけ束縛（テーマ切替のsetStyle再読込で二重登録しない）
    map.on("style.load", () => {
      // style.load は full 'load' より早く確実に発火する（ヘッドレス検証でも動く・実機でも堅牢）。
      // テーマ切替の setStyle でも再発火する。source/layer は消えるので毎回再構築、
      // インタラクション(map.on click)は layer IDで束縛され setStyle を跨いで残るので1度だけ。
      if (!map.getSource("shops")) setupLayers(map);
      if (!wired) {
        wireInteractions(map);
        wired = true;
      }
      applyLabels(map);
      readyRef.current = true;
      setMapReady(true);
      const src = map.getSource("shops") as mapboxgl.GeoJSONSource | undefined;
      src?.setData(shopsGeoJSON(propsRef.current.shops));
      placeUser(map, propsRef.current.userPos);
    });

    // ビュー記憶（中心・ズーム・bearing・pitch）
    const save = () => {
      try {
        const c = map.getCenter();
        localStorage.setItem(
          MB_VIEW_KEY,
          JSON.stringify({
            lng: +c.lng.toFixed(5),
            lat: +c.lat.toFixed(5),
            zoom: +map.getZoom().toFixed(2),
            bearing: Math.round(map.getBearing()),
            pitch: Math.round(map.getPitch()),
          })
        );
      } catch {
        /* 容量超過等は無視 */
      }
    };
    map.on("moveend", save);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- props 反映（地図準備後） ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("shops") as mapboxgl.GeoJSONSource | undefined;
    src?.setData(shopsGeoJSON(props.shops));
  }, [props.shops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !props.focus) return;
    const f = props.focus;
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 15), duration: 0.8 });
    openShopPopup(map, f, [f.lng, f.lat]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    placeUser(map, props.userPos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userPos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    for (const id of Object.keys(labelOrigRef.current)) scaleLabel(map, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.bigLabels]);

  // 夜間/ライト切替: 地図スタイルを dark/light に差し替え（Leaflet版はタイルにCSSフィルタ、Mapboxはstyle切替）。
  // setStyleでsource/layerは消えるため、mapReadyを一旦falseにして全レイヤー追加effectを再実行させ再構築する。
  // 既存の map.on('style.load')(init) が setupLayers+applyLabels+setMapReady(true) を再実行する。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const want = styleFor(props.theme);
    if (want === styleRef.current) return; // 変化なし
    styleRef.current = want;
    labelOrigRef.current = {}; // 新スタイルのラベル原値を取り直す（bigLabels基準）
    readyRef.current = false;
    setMapReady(false); // 全mapReady-effect(route/track/POI/follow/grade/標高プローブ等)を解除→style.loadで再構築
    map.setStyle(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.theme]);

  // 地点標高プローブ（Leaflet ElevationProbe 移植）: 地図をタップ/ホバーした地点の標高を
  // 5秒間表示（タッチはmouseoutが無いので自動消去）。ボタン/情報ボックス上は不感エリア。常時有効。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const box = document.createElement("div");
    box.className = "elev-box";
    box.style.display = "none";
    map.getContainer().appendChild(box);
    let timer = 0;
    let hideTimer = 0;
    let reqId = 0;
    let dragging = false;
    const hide = () => {
      window.clearTimeout(timer);
      window.clearTimeout(hideTimer);
      box.style.display = "none";
      box.textContent = "";
    };
    const place = (px: number, py: number) => {
      const c = map.getContainer();
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (px < W - 150) {
        box.style.left = `${px + 14}px`;
        box.style.right = "";
      } else {
        box.style.right = `${W - px + 14}px`;
        box.style.left = "";
      }
      if (py < H - 44) {
        box.style.top = `${py + 14}px`;
        box.style.bottom = "";
      } else {
        box.style.bottom = `${H - py + 14}px`;
        box.style.top = "";
      }
    };
    // ボタン/情報ボックスの上＋周囲16pxは発火させない（UIタップが地図に貫通して誤標高を出さない）
    const DEAD = 16;
    const UI_SEL =
      ".mapboxgl-ctrl,.recenter-btn,.clear-dest-btn,.hw-toggle,.follow-box,.addr-box,.dest-box,.route-box,.grade-box,.hw-strip,.weather-bar,.poi-hint";
    const overUI = (cx: number, cy: number): boolean => {
      const cont = map.getContainer();
      const cr = cont.getBoundingClientRect();
      const els = cont.querySelectorAll(UI_SEL);
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (
          cx >= r.left - cr.left - DEAD &&
          cx <= r.right - cr.left + DEAD &&
          cy >= r.top - cr.top - DEAD &&
          cy <= r.bottom - cr.top + DEAD
        )
          return true;
      }
      return false;
    };
    const show = (e: mapboxgl.MapMouseEvent) => {
      if (dragging) return;
      const px = e.point.x;
      const py = e.point.y;
      if (overUI(px, py)) {
        hide();
        return;
      }
      // 店舗ピン/クラスタ上はポップアップに任せる（標高は出さない）
      const pinLayers = ["clusters", "shops-pin"].filter((l) => map.getLayer(l));
      if (pinLayers.length && map.queryRenderedFeatures([px, py], { layers: pinLayers }).length) {
        hide();
        return;
      }
      place(px, py);
      box.style.display = "";
      if (!box.textContent) box.textContent = "標高 計測中…";
      const { lat, lng } = e.lngLat;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const id = ++reqId;
        const t = await fetchElevationStr(lat, lng);
        if (id === reqId) box.textContent = t ? `標高 ${t}` : "標高 取得不可";
      }, 280);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, 5000); // タッチはmouseoutが無いので5秒で自動消去
    };
    const onDragStart = () => {
      dragging = true;
      hide();
    };
    const onDragEnd = () => {
      dragging = false;
    };
    map.on("click", show); // タップ（タッチ）＝主用途
    map.on("mousemove", show); // PCホバー追従（おまけ）
    map.on("dragstart", onDragStart);
    map.on("dragend", onDragEnd);
    map.on("zoomstart", hide);
    return () => {
      map.off("click", show);
      map.off("mousemove", show);
      map.off("dragstart", onDragStart);
      map.off("dragend", onDragEnd);
      map.off("zoomstart", hide);
      window.clearTimeout(timer);
      window.clearTimeout(hideTimer);
      box.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // 現在地の天気バー（画面下部中央・常時表示・タップで7日間展開）。Open-Meteo（無料）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const box = document.createElement("div");
    box.className = "weather-bar";
    box.innerHTML = '<div class="wx-label">📍 天気</div><div class="wx-loading">取得中…</div>';
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      box.classList.toggle("expanded");
    });
    map.getContainer().appendChild(box);
    weatherBoxRef.current = box;
    return () => {
      box.remove();
      weatherBoxRef.current = null;
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !weatherBoxRef.current) return;
    const loc = propsRef.current.userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };
    let cancelled = false;
    fetchWeather(loc.lat, loc.lng).then((wx) => {
      if (cancelled || !weatherBoxRef.current) return;
      weatherBoxRef.current.innerHTML = wx
        ? weatherBarHTML(wx)
        : '<div class="wx-label">📍 天気</div><div class="wx-loading">天気を取得できませんでした</div>';
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, wxPosKey]);

  // 走行軌跡（Phase3）: 記録した走行点を速度別色の方向矢印で表示。
  // symbol＋icon-rotation-alignment:map で地図回転に追従、icon-allow-overlap:false で重なりを自動間引き（Leafletの20px間隔相当）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.showTrack) return;
    for (let i = 0; i < TRK_COLORS.length; i++) {
      if (!map.hasImage(`trk${i}`)) map.addImage(`trk${i}`, triangleImageData(TRK_COLORS[i], 2), { pixelRatio: 2 });
    }
    const buildData = (): GeoJSON.FeatureCollection<GeoJSON.Point> => {
      const pts = getTrackPoints();
      const n = pts.length;
      const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        let deg = 0;
        if (i + 1 < n) deg = bearingDeg(p, pts[i + 1]);
        else if (i > 0) deg = bearingDeg(pts[i - 1], p);
        const b = i + 1 < n ? pts[i + 1] : i > 0 ? pts[i - 1] : null;
        let kmh: number | null = null;
        if (b) {
          const dtH = Math.abs(b.t - p.t) / 3600000;
          if (dtH > 0) kmh = haversineKm(p, b) / dtH;
        }
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          properties: { bearing: deg, ci: speedColorIdx(kmh) },
        });
      }
      return { type: "FeatureCollection", features };
    };
    if (!map.getSource("track")) {
      map.addSource("track", { type: "geojson", data: buildData() });
      const before = map.getLayer("route-line")
        ? "route-line"
        : map.getLayer("clusters")
        ? "clusters"
        : undefined;
      map.addLayer(
        {
          id: "track-arrows",
          type: "symbol",
          source: "track",
          layout: {
            "icon-image": ["match", ["get", "ci"], 1, "trk1", 2, "trk2", 3, "trk3", 4, "trk4", "trk0"],
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            // 走行軌跡は累積の履歴。重なりで間引かず全点を表示する（既走行の道を再走行しても矢印が残る・増える）。
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-size": 1,
          },
        },
        before
      );
    } else {
      (map.getSource("track") as mapboxgl.GeoJSONSource).setData(buildData());
    }
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        (map.getSource("track") as mapboxgl.GeoJSONSource | undefined)?.setData(buildData());
      }, 150);
    };
    const unsub = subscribeTrack(refresh);
    return () => {
      window.clearTimeout(timer);
      unsub();
      if (map.getLayer("track-arrows")) map.removeLayer("track-arrows");
      if (map.getSource("track")) map.removeSource("track");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.showTrack]);

  // 周辺POI（コンビニ/GS=同梱データ即時, 駐車場/EV/トイレ=ライブOverpass）。
  // z14未満は非表示・BUFFER余白＋bboxキャッシュ＋最小間隔で過剰取得を抑制（Leaflet版PoiLayer移植）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const active = (poiKindsKey ? poiKindsKey.split(",") : []) as PoiKind[];
    if (active.length === 0) return;

    const MINZOOM = 14;
    const MIN_INTERVAL = 4000;
    const MAX = 600;
    const BUFFER = 0.7;
    const ICON_BASE = `${import.meta.env.BASE_URL}poi-icons/`;
    const ZOOM_HINT = "🏪 ズームすると周辺の施設を表示";

    const hint = document.createElement("div");
    hint.className = "poi-hint";
    hint.textContent = ZOOM_HINT;
    hint.style.display = "none";
    map.getContainer().appendChild(hint);

    let markers: mapboxgl.Marker[] = [];
    const clearMarkers = () => {
      for (const m of markers) m.remove();
      markers = [];
    };

    // アイコンHTMLを種類×ブランドでキャッシュ（マーカー毎にelementは複製する）
    const htmlCache = new Map<string, string>();
    const iconHtml = (kind: PoiKind, label: string): string => {
      const file = poiIconFile(kind, label);
      if (file) {
        const key = `img|${file}`;
        let h = htmlCache.get(key);
        if (!h) {
          const gs = file.startsWith("gs-");
          h = `<div class="${gs ? "poi-img-gs" : "poi-img"}"><img src="${ICON_BASE}${file}" alt="" /></div>`;
          htmlCache.set(key, h);
        }
        return h;
      }
      const st = poiBrandStyle(kind, label);
      const key = `${kind}|${st.bg}|${st.t}`;
      let h = htmlCache.get(key);
      if (!h) {
        const fs = st.emoji ? "14px" : st.t.length >= 2 ? "9.5px" : "12.5px";
        h = `<div class="poi ${POI_SHAPE[kind]}" style="background:${st.bg};color:${st.fg};font-size:${fs}">${st.t}</div>`;
        htmlCache.set(key, h);
      }
      return h;
    };
    const makeEl = (html: string): HTMLElement => {
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      return wrap.firstElementChild as HTMLElement;
    };

    let cachedLive: BBox | null = null;
    let lastReqAt = 0;
    let aborted = false;
    let inFlight = false;
    let failStreak = 0;
    let lastLiveKey = "";
    let lastLocal: Poi[] = [];
    let localArea: BBox | null = null;
    let lastLive: Poi[] = [];
    let shown = false;
    let local: LocalPoiData | null = null;
    let localLoadFailed = false;

    const localActive = active.filter((k) => LOCAL_KINDS.includes(k));
    const liveOnly = active.filter((k) => !LOCAL_KINDS.includes(k));

    const expand = (b: BBox, f: number): BBox => {
      const dy = (b.n - b.s) * f;
      const dx = (b.e - b.w) * f;
      return { s: b.s - dy, w: b.w - dx, n: b.n + dy, e: b.e + dx };
    };
    const inside = (o: BBox, i: BBox) => i.s >= o.s && i.w >= o.w && i.n <= o.n && i.e <= o.e;

    const capPick = (pois: Poi[]): Poi[] => {
      const buckets = new Map<PoiKind, Poi[]>();
      for (const p of pois) {
        const arr = buckets.get(p.kind);
        if (arr) arr.push(p);
        else buckets.set(p.kind, [p]);
      }
      const lists = [...buckets.values()];
      const picked: Poi[] = [];
      for (let i = 0; picked.length < MAX; i++) {
        let added = false;
        for (const list of lists) {
          if (i < list.length) {
            picked.push(list[i]);
            added = true;
            if (picked.length >= MAX) break;
          }
        }
        if (!added) break;
      }
      return picked;
    };

    const popupFor = (p: Poi, popup: mapboxgl.Popup): HTMLElement => {
      const el = document.createElement("div");
      el.className = "poi-popup";
      const nm = document.createElement("div");
      nm.className = "poi-popup__name";
      nm.textContent = p.label;
      el.appendChild(nm);
      const d: Dest = { lat: p.lat, lng: p.lng, name: p.label };
      const bDest = document.createElement("button");
      bDest.type = "button";
      bDest.className = "poi-popup__btn poi-popup__btn--dest";
      bDest.textContent = "🎯 目的地に設定";
      bDest.onclick = () => {
        popup.remove();
        propsRef.current.onSetDest(d);
      };
      const bNav = document.createElement("button");
      bNav.type = "button";
      bNav.className = "poi-popup__btn";
      bNav.textContent = "🚗 Googleマップ";
      bNav.onclick = () => {
        popup.remove();
        propsRef.current.onNav(d);
      };
      el.appendChild(bDest);
      el.appendChild(bNav);
      return el;
    };

    const draw = () => {
      const picked = capPick([...lastLocal, ...lastLive]);
      clearMarkers();
      for (const p of picked) {
        const el = makeEl(iconHtml(p.kind, p.label));
        el.title = p.label;
        const popup = new mapboxgl.Popup({ offset: 14, closeButton: true });
        popup.setDOMContent(popupFor(p, popup));
        markers.push(
          new mapboxgl.Marker({ element: el, anchor: "center" })
            .setLngLat([p.lng, p.lat])
            .setPopup(popup)
            .addTo(map)
        );
      }
      shown = true;
    };

    const refresh = async () => {
      if (aborted) return;
      if (map.getZoom() < MINZOOM) {
        if (shown) {
          clearMarkers();
          shown = false;
        }
        hint.textContent = ZOOM_HINT;
        hint.style.display = "";
        return;
      }
      if (hint.textContent === ZOOM_HINT) hint.style.display = "none";
      const bd = map.getBounds();
      if (!bd) return;
      const view: BBox = { s: bd.getSouth(), w: bd.getWest(), n: bd.getNorth(), e: bd.getEast() };

      let liveNeeded = liveOnly.slice();
      let changed = false;
      if (localActive.length) {
        if (local && coverageContains(local, view)) {
          if (!localArea || !inside(localArea, view)) {
            const larea = expand(view, BUFFER);
            lastLocal = localPoisInView(local, larea, localActive);
            localArea = larea;
            changed = true;
          }
        } else if (local || localLoadFailed) {
          if (lastLocal.length || localArea) {
            lastLocal = [];
            localArea = null;
            changed = true;
          }
          liveNeeded = liveNeeded.concat(localActive);
        }
      }

      const liveKey = [...liveNeeded].sort().join(",");
      if (liveKey !== lastLiveKey) {
        cachedLive = null;
        if (lastLive.length) {
          lastLive = [];
          changed = true;
        }
        lastLiveKey = liveKey;
      }

      if (changed || !shown) draw();

      if (!liveNeeded.length) return;
      if (inFlight) return;
      if (cachedLive && inside(cachedLive, view)) return;
      const now = performance.now();
      if (now - lastReqAt < MIN_INTERVAL) return;
      lastReqAt = now;
      inFlight = true;
      const area = expand(view, BUFFER);
      try {
        const pois = await fetchPois(area, liveNeeded);
        if (aborted) return;
        cachedLive = area;
        failStreak = 0;
        lastLive = pois;
        if (hint.textContent !== ZOOM_HINT) hint.style.display = "none";
        draw();
      } catch {
        if (aborted) return;
        failStreak++;
        if (failStreak >= 2) {
          hint.textContent = "⚠ 周辺施設を取得中…（地図サーバ混雑）";
          hint.style.display = "";
        }
      } finally {
        inFlight = false;
      }
    };

    if (localActive.length) {
      loadLocalPois()
        .then((d) => {
          if (!aborted) {
            local = d;
            refresh();
          }
        })
        .catch(() => {
          if (!aborted) {
            localLoadFailed = true;
            refresh();
          }
        });
    }
    map.on("moveend", refresh);
    const timer = window.setInterval(refresh, 5000);
    refresh();
    return () => {
      aborted = true;
      map.off("moveend", refresh);
      window.clearInterval(timer);
      clearMarkers();
      hint.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, poiKindsKey]);

  // 経路案内（Stage 2a）: 目的地マーカー＋道なり経路線＋残距離/ETA＋走行済みトリム＋逸脱リルート。
  // 勾配計・高速ストリップ・走行追従(follow)は別エフェクト/別段で追加（2c/2b）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.dest) return;
    const to: Pt = { lat: props.dest.lat, lng: props.dest.lng };
    let aborted = false;
    let watchId: number | null = null;
    let lastRouteAt = 0;
    const REROUTE_DEV_KM = 0.05; // 約50m逸脱で再ルート
    const REROUTE_MIN_INTERVAL = 10000; // 連続再ルートの最小間隔(ms)

    // 目的地マーカー（🎯）
    const destEl = document.createElement("div");
    destEl.className = "dest-pin";
    destEl.textContent = "🎯";
    const destMarker = new mapboxgl.Marker({ element: destEl, anchor: "bottom" })
      .setLngLat([to.lng, to.lat])
      .addTo(map);

    // 経路線（GeoJSON。店舗ピン/クラスタの下に置く）
    const lineData = (coords: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> => ({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords.map((c) => [c[1], c[0]]) },
    });
    if (!map.getSource("route")) {
      // lineMetrics:true は line-trim-offset（走行済み区間のGPUトリム）に必須。
      map.addSource("route", { type: "geojson", lineMetrics: true, data: lineData([]) });
      const before = map.getLayer("clusters") ? "clusters" : undefined;
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          // line-trim-offset で走行済み区間[0,frac]をGPU側で透明化（線を再スライスせず高頻度に更新可）
          paint: { "line-color": "#0b57d0", "line-width": 7, "line-opacity": 0.95, "line-trim-offset": [0, 0] },
        },
        before
      );
    }
    const setLine = (coords: [number, number][]) => {
      (map.getSource("route") as mapboxgl.GeoJSONSource | undefined)?.setData(lineData(coords));
    };

    // 走行済みルートの消去を自車(カメラ)と同じ補間で滑らかに。
    // 旧実装はGPSフィックス毎(1Hz)に線を再スライス＝自車は60fpsで滑らかなのに消去だけ1Hzでカクついた。
    // line-trim-offset(GPU側トリム・再テッセレーション無し)を rAF で targetFrac へ補間し、毎フレーム更新する。
    let trimFrac = 0; // 現在のトリム率（line-trim-offset の end）
    let trimFrom = 0;
    let trimTo = 0;
    let trimStart = 0;
    let trimRaf = 0;
    const TRIM_DUR = 1100; // follow カメラの easeTo と同じ補間時間
    const applyTrim = (f: number) => {
      if (!map.getLayer("route-line")) return;
      map.setPaintProperty("route-line", "line-trim-offset", [0, Math.max(0, Math.min(1, f))]);
    };
    const tickTrim = () => {
      const t = Math.min(1, (performance.now() - trimStart) / TRIM_DUR);
      trimFrac = trimFrom + (trimTo - trimFrom) * t;
      applyTrim(trimFrac);
      trimRaf = t < 1 ? requestAnimationFrame(tickTrim) : 0;
    };
    const animateTrimTo = (target: number) => {
      trimTo = Math.max(0, Math.min(1, target));
      // 変化が微小（停車/低速）なら rAF を回さず即適用＝GPUを起こさない（省電力・発熱低減）。
      if (Math.abs(trimTo - trimFrac) < 0.0008) {
        if (trimRaf) {
          cancelAnimationFrame(trimRaf);
          trimRaf = 0;
        }
        trimFrac = trimTo;
        applyTrim(trimFrac);
        return;
      }
      trimFrom = trimFrac;
      trimStart = performance.now();
      if (!trimRaf) trimRaf = requestAnimationFrame(tickTrim);
    };
    const resetTrim = () => {
      if (trimRaf) cancelAnimationFrame(trimRaf);
      trimRaf = 0;
      trimFrac = trimFrom = trimTo = 0;
      applyTrim(0);
    };
    // sim/debug: rAFがヘッドレスで抑制されてもトリムの目標値/paint反映を決定論検証するフック
    if (new URLSearchParams(window.location.search).get("sim") === "drive" || new URLSearchParams(window.location.search).get("debug") === "1") {
      (window as unknown as Record<string, unknown>).__trim = {
        offset: () => map.getPaintProperty("route-line", "line-trim-offset"),
        state: () => ({ frac: trimFrac, from: trimFrom, to: trimTo }),
        force: () => {
          trimFrac = trimTo;
          applyTrim(trimFrac);
          return map.getPaintProperty("route-line", "line-trim-offset");
        },
      };
    }

    // 残距離/ETA ボックス（左上・既存CSS .route-box）
    const box = document.createElement("div");
    box.className = "route-box";
    box.textContent = "🛣 現在地を取得中…";
    map.getContainer().appendChild(box);

    // ルート解除ボタン
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear-dest-btn"; // 右・中央下（Leaflet版と同じ位置）
    clearBtn.textContent = "✕ ルート解除";
    clearBtn.onclick = () => propsRef.current.onClearDest();
    map.getContainer().appendChild(clearBtn);

    let rCoords: [number, number][] | null = null;
    let rSuffix: number[] = [];
    let rKm = 0;
    let rMin = 0;
    let lastHeading: number | null = null;
    let headingPrevPos: Pt | null = null;
    let lastHereHw: Pt | null = null;
    // この先急勾配の予告: 経路を80mマークに分割し、前方GRADE_LOOK先までの標高をキャッシュして最急を探す
    let gradeMarks: Pt[] = [];
    let eleAtMark: (number | null | undefined)[] = [];
    let gradeReqId = 0;

    // ===== ハイウェイモード: この先のSA/PA/IC/JCTを近い順に右ストリップ表示（Leaflet版移植） =====
    const hwStrip = document.createElement("div");
    hwStrip.className = "hw-strip";
    hwStrip.style.display = "none";
    map.getContainer().appendChild(hwStrip);
    // 高速切替ボタン(.hw-toggle)は follow 基準の独立 effect で生成（フリー走行でも表示）。
    // ここ(route effect)は propsRef.current.hwOverride を読むだけ。

    let hwRanges: [number, number][] = [];
    const isHwSeg = (segIdx: number) => hwRanges.some(([a, b]) => segIdx >= a && segIdx < b);
    let onHighway = false;
    let fastCount = 0;
    let slowCount = 0;
    const updateHighwayState = (kmh: number | null) => {
      if (kmh == null || !isFinite(kmh)) return;
      if (kmh >= 65) {
        fastCount++;
        slowCount = 0;
        if (fastCount >= 8) onHighway = true;
      } else if (kmh < 50) {
        slowCount++;
        fastCount = 0;
        if (slowCount >= 60) onHighway = false;
      } else {
        fastCount = 0;
        slowCount = 0;
      }
    };
    let effHighway = false;
    const computeEffHighway = (segIdx: number) => {
      const ov = propsRef.current.hwOverride;
      if (ov === "on") return true;
      if (ov === "off") return false;
      if (hwRanges.length > 0) return isHwSeg(segIdx);
      return onHighway;
    };

    const HW_SNAP_KM = 0.3;
    const HW_LOOK = 4; // 表示する前方施設数（多いとストリップが画面上端で見切れるため抑制）
    const HW_BADGE: Record<HwKind, string> = { sa: "SA", pa: "PA", ic: "IC", jct: "JCT" };
    const AMEN_EMOJI: Record<string, string> = { conv: "🏪", fuel: "⛽", food: "🍴", cafe: "☕", shop: "🛍️", toilet: "🚻", ev: "⚡" };
    const HW_ICON_BASE = `${import.meta.env.BASE_URL}poi-icons/`;
    const amenIconHtml = (a: string, f: HwFacility): string => {
      if (a === "conv") {
        const file = poiIconFile("conv", f.convBrand || "");
        return `<img class="hw-amen-ic hw-amen-conv" src="${HW_ICON_BASE}${file}" alt="コンビニ">`;
      }
      if (a === "fuel") {
        const file = poiIconFile("fuel", f.fuelBrand || "");
        if (file) return `<img class="hw-amen-ic hw-amen-gs" src="${HW_ICON_BASE}${file}" alt="GS">`;
      }
      return `<span class="hw-amen-em">${AMEN_EMOJI[a] || ""}</span>`;
    };
    let hwFacilities: HwFacility[] | null = null;
    let routeFacilities: { f: HwFacility; distKm: number; devKm: number }[] = [];
    const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    const computeRouteFacilities = () => {
      routeFacilities = [];
      if (!rCoords || !hwFacilities || rKm <= 0) return;
      let s = 90,
        w = 180,
        n = -90,
        e = -180;
      for (const c of rCoords) {
        if (c[0] < s) s = c[0];
        if (c[0] > n) n = c[0];
        if (c[1] < w) w = c[1];
        if (c[1] > e) e = c[1];
      }
      const M = 0.01;
      for (const f of hwFacilities) {
        if (f.lat < s - M || f.lat > n + M || f.lng < w - M || f.lng > e + M) continue;
        const prj = projectOnRoute(rCoords, rSuffix, { lat: f.lat, lng: f.lng });
        if (prj.devKm > HW_SNAP_KM) continue;
        routeFacilities.push({ f, distKm: rKm - prj.remKm, devKm: prj.devKm });
      }
      // 施設名から方向/路線名の枝番を除いた基準名（全角→半角・括弧/空白除去・上り/下り/内外回り(廻り)を除去）
      const baseName = (nm: string) =>
        nm
          .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
          .replace(/[\s（）()]/g, "")
          .replace(/(上り|下り|内回り|外回り|内廻り|外廻り)$/, "");
      // 同名（上り/下り違い含む）は1つに集約。**ルート線に最も近い(devKm最小)＝自車の車線＝進行方向側**を残す。
      // （従来は最短距離順の先頭を残したため、対向車線(上り)の施設が残ることがあった＝下り走行で上りSA表示の不具合）
      const best = new Map<string, { f: HwFacility; distKm: number; devKm: number }>();
      for (const rf of routeFacilities) {
        const k = `${rf.f.kind}:${baseName(rf.f.name)}`;
        const cur = best.get(k);
        if (!cur || rf.devKm < cur.devKm) best.set(k, rf);
      }
      routeFacilities = Array.from(best.values()).sort((a, b) => a.distKm - b.distKm);
    };
    const updateHwStrip = (carDistKm: number) => {
      if (!effHighway || routeFacilities.length === 0) {
        hwStrip.style.display = "none";
        return;
      }
      const ahead = routeFacilities.filter((rf) => rf.distKm >= carDistKm - 0.1).slice(0, HW_LOOK);
      if (ahead.length === 0) {
        hwStrip.style.display = "none";
        return;
      }
      hwStrip.style.display = "";
      hwStrip.innerHTML = ahead
        .map((rf) => {
          const remKm = Math.max(0, rf.distKm - carDistKm);
          const remMin = rKm > 0 ? Math.round(rMin * (remKm / rKm)) : 0;
          const dist = remKm < 10 ? remKm.toFixed(1) : Math.round(remKm).toString();
          const am = rf.f.amenities;
          const amenRow =
            (rf.f.kind === "sa" || rf.f.kind === "pa") && am && am.length
              ? `<div class="hw-amen">${am.map((a) => amenIconHtml(a, rf.f)).join("")}</div>`
              : "";
          return (
            `<div class="hw-row hw-${rf.f.kind}"><div class="hw-top"><span class="hw-badge">${HW_BADGE[rf.f.kind]}</span>` +
            `<span class="hw-name">${escHtml(rf.f.name)}</span></div>${amenRow}` +
            `<div class="hw-dist">${dist}<small>km</small> ・ ${remMin}<small>分</small></div></div>`
          );
        })
        .join("");
    };
    loadHighway()
      .then((d) => {
        if (aborted) return;
        hwFacilities = d.facilities;
        if (rCoords) computeRouteFacilities();
      })
      .catch(() => {
        /* highway.json 無し時はストリップ非表示のまま */
      });
    // 高速切替を次のGPS取得を待たず即、ストリップへ反映（トグルのラベルは hwToggleLabelRef 側で更新）
    routeReapplyRef.current = () => {
      if (lastHereHw && rCoords) refresh(lastHereHw);
    };

    const fmtEta = (min: number) =>
      new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })
        .format(new Date(Date.now() + Math.max(0, min) * 60000));

    // この先(前方GRADE_LOOKマーク=約880m)で最も急な勾配(≥GRADE_STEEP%)を探し aheadGradeRef に書く。
    // 高速道路ではDEMが道路と乖離するため予告しない（勾配メーター本体もhwActiveRefで非表示）。
    const updateAheadGrade = (carDistKm: number) => {
      if (effHighway || gradeMarks.length < 2) {
        aheadGradeRef.current = null;
        return;
      }
      const cur = Math.min(Math.max(Math.round(carDistKm / GRADE_SPACING_KM), 0), gradeMarks.length - 1);
      const end = Math.min(cur + GRADE_LOOK, gradeMarks.length - 1);
      const scan = () => {
        let steepGrade = 0;
        let steepDistM = -1;
        for (let i = cur; i < end; i++) {
          const a = eleAtMark[i];
          const b = eleAtMark[i + 1];
          if (typeof a === "number" && typeof b === "number") {
            const g = ((b - a) / (GRADE_SPACING_KM * 1000)) * 100;
            if (Math.abs(g) >= GRADE_STEEP && Math.abs(g) <= GRADE_MAX_PLAUSIBLE && Math.abs(g) > Math.abs(steepGrade)) {
              steepGrade = g;
              steepDistM = Math.max(0, Math.round((i * GRADE_SPACING_KM - carDistKm) * 1000));
            }
          }
        }
        aheadGradeRef.current = steepDistM >= 0 ? { grade: steepGrade, distM: steepDistM } : null;
      };
      scan(); // 既知の標高で即時更新（チラつき防止）
      const need: number[] = [];
      for (let i = cur; i <= end; i++) if (eleAtMark[i] === undefined) need.push(i);
      if (!need.length) return;
      const reqId = ++gradeReqId;
      Promise.allSettled(
        need.map(async (i) => {
          eleAtMark[i] = await fetchElevationNum(gradeMarks[i].lat, gradeMarks[i].lng);
        })
      ).then(() => {
        if (aborted || reqId !== gradeReqId) return;
        scan();
      });
    };

    const refresh = (here: Pt) => {
      if (!rCoords || rKm <= 0) return null;
      const pr = projectOnRoute(rCoords, rSuffix, here);
      if (pr.remKm < 0.08) {
        box.textContent = "🛣 まもなく到着";
      } else {
        const remMin = rMin * (pr.remKm / rKm);
        const dist = pr.remKm < 10 ? pr.remKm.toFixed(1) : Math.round(pr.remKm).toString();
        box.textContent = `🛣 残り ${dist}km ・ ${fmtEta(remMin)}着`;
      }
      // 走行済み区間の消去は line-trim-offset を自車(カメラ)と同じ補間で動かす（線は再スライスしない）。
      // 全ルートを描いたまま [0, 道なり進行率] をGPU側で透明化＝自車の滑らかさに同期して消える。
      animateTrimTo(rKm > 0 ? (rKm - pr.remKm) / rKm : 0);
      // 経路スナップ用に投影点＋道路セグメント方位を共有（followが自車位置/向きに使う）
      let segBearing = routeSnapRef.current?.bearing ?? 0;
      if (pr.segIdx + 1 < rCoords.length) {
        const a = rCoords[pr.segIdx];
        const b = rCoords[pr.segIdx + 1];
        segBearing = bearingDeg({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
      }
      routeSnapRef.current = { proj: pr.proj, bearing: segBearing, at: Date.now() };
      // 高速判定（手動＞経路waycategory＞速度）＋この先の高速施設ストリップ更新
      effHighway = computeEffHighway(pr.segIdx);
      hwActiveRef.current = effHighway; // 勾配effectが高速時の勾配抑制に使う
      updateHwStrip(rKm - pr.remKm);
      updateAheadGrade(rKm - pr.remKm); // この先の急勾配を先読みして aheadGradeRef に反映
      return pr;
    };

    const route = (from: Pt) => {
      lastRouteAt = Date.now();
      if (!rCoords) box.textContent = "🛣 経路を計算中…";
      fetchRoute(from, to, lastHeading).then((r) => {
        if (aborted) return;
        if (!r) {
          if (!rCoords) box.textContent = "🛣 経路を取得できませんでした";
          return;
        }
        setLine(r.coords);
        resetTrim(); // 新ルート(初回/再ルート)は全線を描き直しトリムを0へ戻す
        rCoords = r.coords;
        rKm = r.km;
        rMin = r.min;
        rSuffix = new Array(r.coords.length).fill(0);
        for (let i = r.coords.length - 2; i >= 0; i--) {
          rSuffix[i] =
            rSuffix[i + 1] +
            haversineKm(
              { lat: r.coords[i][0], lng: r.coords[i][1] },
              { lat: r.coords[i + 1][0], lng: r.coords[i + 1][1] }
            );
        }
        hwRanges = r.hwRanges ?? []; // 経路の高速/有料区間（ORS waycategory）
        gradeMarks = buildMarks(r.coords, GRADE_SPACING_KM); // この先急勾配の予告用マーク（再ルートで作り直し）
        eleAtMark = []; // 経路が変わったので標高キャッシュをリセット
        computeRouteFacilities(); // 経路沿いの高速施設を再計算
        refresh(from);
      });
    };

    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
      lastHereHw = here;
      const spk = p.coords.speed;
      updateHighwayState(spk != null && spk >= 0 ? spk * 3.6 : null);
      const hd = p.coords.heading;
      const gpsHeadingOk = hd != null && isFinite(hd) && hd >= 0;
      if (gpsHeadingOk) lastHeading = hd;
      if (!headingPrevPos) headingPrevPos = here;
      else if (haversineKm(headingPrevPos, here) >= 0.02) {
        if (!gpsHeadingOk) lastHeading = bearingDeg(headingPrevPos, here);
        headingPrevPos = here;
      }
      if (!rCoords) {
        if (Date.now() - lastRouteAt > REROUTE_MIN_INTERVAL) route(here);
        return;
      }
      const pr = refresh(here);
      if (pr && pr.devKm > REROUTE_DEV_KM && Date.now() - lastRouteAt > REROUTE_MIN_INTERVAL) {
        route(here);
      }
    };

    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(
        onPos,
        () => {
          if (!aborted && !rCoords) box.textContent = "🛣 現在地を取得できませんでした";
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } else {
      box.textContent = "🛣 現在地が使えません（HTTPSが必要）";
    }

    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (trimRaf) cancelAnimationFrame(trimRaf); // トリム補間のrAFを停止
      destMarker.remove();
      box.remove();
      clearBtn.remove();
      hwStrip.remove();
      routeSnapRef.current = null;
      routeReapplyRef.current = null;
      hwActiveRef.current = false;
      aheadGradeRef.current = null; // 経路解除で予告をクリア（古い警告を残さない）
      if (map.getLayer("route-line")) map.removeLayer("route-line");
      if (map.getSource("route")) map.removeSource("route");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, destKey]);

  // 高速道路切替(自動/高速/一般道)を次のGPS取得を待たず即、ストリップ＆トグル表示へ反映
  useEffect(() => {
    routeReapplyRef.current?.(); // 経路ストリップの即時反映（経路ありの時）
    hwToggleLabelRef.current?.(); // トグルのラベル更新（フリー走行時もここで反映）
  }, [props.hwOverride]);

  // フリー走行(ルート無し)＋高速モードON時の高速施設ストリップ。経路に投影できないので、
  // 現在地と進行方位から「前方(±75°)・40km以内」の施設を距離順に表示（ユーザー要望: 走行の向きで判断）。
  // 経路effectはdest必須なので別系統。dest設定中はこちらは無効（経路effect側が出す）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.follow || destKey || props.hwOverride !== "on") return;
    let aborted = false;
    let watchId: number | null = null;
    let facilities: HwFacility[] | null = null;
    const LOOK = 4;
    const MAXKM = 40;
    const BADGE: Record<HwKind, string> = { sa: "SA", pa: "PA", ic: "IC", jct: "JCT" };
    const EMO: Record<string, string> = { conv: "🏪", fuel: "⛽", food: "🍴", cafe: "☕", shop: "🛍️", toilet: "🚻", ev: "⚡" };
    const ICON = `${import.meta.env.BASE_URL}poi-icons/`;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    const bn = (nm: string) =>
      nm
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[\s（）()]/g, "")
        .replace(/(上り|下り|内回り|外回り|内廻り|外廻り)$/, "");
    const amen = (a: string, f: HwFacility) => {
      if (a === "conv") return `<img class="hw-amen-ic hw-amen-conv" src="${ICON}${poiIconFile("conv", f.convBrand || "")}" alt="">`;
      if (a === "fuel") {
        const file = poiIconFile("fuel", f.fuelBrand || "");
        if (file) return `<img class="hw-amen-ic hw-amen-gs" src="${ICON}${file}" alt="">`;
      }
      return `<span class="hw-amen-em">${EMO[a] || ""}</span>`;
    };
    const strip = document.createElement("div");
    strip.className = "hw-strip";
    strip.style.display = "none";
    map.getContainer().appendChild(strip);
    let lastHd: number | null = null;
    let prevPt: Pt | null = null;
    let lastKmh = 0;
    const render = (here: Pt, hd: number) => {
      if (!facilities) {
        strip.style.display = "none";
        return;
      }
      const cands: { f: HwFacility; d: number }[] = [];
      for (const f of facilities) {
        const d = haversineKm(here, { lat: f.lat, lng: f.lng });
        if (d > MAXKM || d < 0.05) continue;
        const rel = Math.abs(((bearingDeg(here, { lat: f.lat, lng: f.lng }) - hd + 540) % 360) - 180);
        if (rel > 75) continue; // 前方のみ（後方・側方は除外）
        cands.push({ f, d });
      }
      cands.sort((a, b) => a.d - b.d);
      const best = new Map<string, { f: HwFacility; d: number }>();
      for (const c of cands) {
        const k = `${c.f.kind}:${bn(c.f.name)}`;
        if (!best.has(k)) best.set(k, c); // 距離順に先頭＝最も近い同名を残す
      }
      const ahead = Array.from(best.values()).slice(0, LOOK);
      if (!ahead.length) {
        strip.style.display = "none";
        return;
      }
      strip.style.display = "";
      strip.innerHTML = ahead
        .map((c) => {
          const f = c.f;
          const dist = c.d < 10 ? c.d.toFixed(1) : Math.round(c.d).toString();
          const min = lastKmh > 5 ? Math.round((c.d / lastKmh) * 60) : null;
          const am = f.amenities;
          const amenRow =
            (f.kind === "sa" || f.kind === "pa") && am && am.length
              ? `<div class="hw-amen">${am.map((a) => amen(a, f)).join("")}</div>`
              : "";
          const minTxt = min != null ? ` ・ ${min}<small>分</small>` : "";
          return (
            `<div class="hw-row hw-${f.kind}"><div class="hw-top"><span class="hw-badge">${BADGE[f.kind]}</span>` +
            `<span class="hw-name">${esc(f.name)}</span></div>${amenRow}` +
            `<div class="hw-dist">${dist}<small>km</small>${minTxt}</div></div>`
          );
        })
        .join("");
    };
    loadHighway()
      .then((d) => {
        if (!aborted) facilities = d.facilities;
      })
      .catch(() => {});
    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
      const h = p.coords.heading;
      if (h != null && isFinite(h) && h >= 0) lastHd = h;
      else if (prevPt && haversineKm(prevPt, here) >= 0.015) lastHd = bearingDeg(prevPt, here);
      if (!prevPt || haversineKm(prevPt, here) >= 0.015) prevPt = here;
      const sp = p.coords.speed;
      if (sp != null && sp >= 0) lastKmh = sp * 3.6;
      if (lastHd == null) {
        strip.style.display = "none";
        return;
      }
      render(here, lastHd);
    };
    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(onPos, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    }
    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      strip.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.follow, destKey, props.hwOverride]);

  // 高速道路切替トグル(.hw-toggle)。Leaflet版(active={follow})と同じく走行(follow)中は常に表示
  // ＝経路の有無に関わらずフリー走行でも出す。フリー走行では手動「高速:ON」で勾配計を抑制できる。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.follow) return;
    const hwToggle = document.createElement("button");
    hwToggle.type = "button";
    hwToggle.className = "hw-toggle"; // 右・中央下（Leaflet版と同じ位置）
    // Leaflet版と同じ二段表示（ラベル＋色付き値ピル）。textContentだと__t/__vのフォント指定が
    // 当たらず極小になる（=今回のフォント不具合の原因）。modifierクラスで枠/ピル色も切替。
    const label = () => {
      const o = propsRef.current.hwOverride;
      const v = o === "on" ? "高速" : o === "off" ? "一般道" : "自動";
      hwToggle.className = `hw-toggle hw-toggle--${o}`;
      hwToggle.innerHTML = `<span class="hw-toggle__t">🛣 HW切替</span><span class="hw-toggle__v">${v}</span>`;
    };
    label();
    hwToggle.onclick = () => propsRef.current.onCycleHwOverride();
    map.getContainer().appendChild(hwToggle);
    hwToggleLabelRef.current = label; // hwOverride変化時にラベル更新（上のeffectが呼ぶ）
    return () => {
      hwToggleLabelRef.current = null;
      hwToggle.remove();
    };
  }, [mapReady, props.follow]);

  // 走行追従モード（Stage 2b）: ヘディングアップ回転＋3Dピッチ＋自車マーカー＋速度計＋Wake Lock。
  // Mapboxはカメラを進行方位へ回せるので、自車矢印は常に上向き（Leaflet版のコンパス補正は不要）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.follow) return;
    let aborted = false;
    let watchId: number | null = null;
    let first = true;
    // 地図の向き（ノースアップ=北固定/ヘディングアップ=進行方向上）。変更時は deps で再マウント。
    const headingUp = propsRef.current.headingUp ?? false;
    const DRIVE_ZOOM = 16.5;
    const MOVE_KMH = 3; // これ以上で進行方位を採用（停車時のふらつきで地図が回らないように）
    const leadPx = () => (headingUp ? map.getContainer().clientHeight * 0.22 : 0);
    let lastBearing = headingUp ? map.getBearing() : 0;
    let lastHere: [number, number] | null = null;
    let prevCam: [number, number] | null = null; // 直近のカメラ追従先（>150mジャンプ検出・停車時パン抑制に使用）
    let following = true;
    // 進行方位（真北基準・ノース/ヘディング非依存）。停車時コンパス較正とトンネルDRの前進方向に使う。
    let lastTravelHeading: number | null = null;
    // 端末コンパス（ジャイロ＋地磁気）。許可はApp.tsxがタップ内で取得済み（requestOrientationPermission）。
    let rawCompass: number | null = null; // 生値(0-360,真北基準)
    let compassOffset: number | null = null; // 真方位 ≒ rawCompass + offset（走行中にGPS方位で学習）
    // トンネルDR（GPSロス時の推測走行）: 直前速度×経過×方位で合成前進し、GPS復帰で実位置へ補正。
    let haveFix = false;
    let lastFixPerf = 0; // 直近フィックスの performance.now()
    let lastGoodSpeedMs = 0; // 直近の有効速度(m/s)
    let drMode = false; // 推測走行中か
    let drLat = 0;
    let drLng = 0; // 推測中の合成位置
    let drLastPerf = 0;
    let hdgPrevPt: Pt | null = null; // GPS heading 無し端末向け: 位置差分から方位を出すフォールバック用
    let carRot = 0; // ノースアップ時の自車矢印の連続回転角（最短回転）

    const CAR_SVG =
      '<svg class="car-arrow" width="54" height="54" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="18" cy="18" r="15" fill="rgba(26,115,232,0.18)"/>' +
      '<path d="M18 4 L27 26 L18 21 L9 26 Z" fill="#1a73e8" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
    // 自車の右に標高(m)を常設表示（Leaflet版＝自車マーク横ツールチップ「標高 ◯m」移植）。約40m毎更新。
    const CAR_HTML = CAR_SVG + '<span class="car-elev-label">標高 …</span>';
    // 追従中の自車＝画面固定オーバーレイ（カメラが自車を中央追従するので地図がなめらかに流れる）。
    // ヘディングアップは下寄り(72%・前方ワイド)、ノースアップは中央(50%)。
    const carEl = document.createElement("div");
    carEl.setAttribute(
      "style",
      `position:absolute;left:50%;top:${headingUp ? "72%" : "50%"};transform:translate(-50%,-50%);z-index:600;pointer-events:none;`
    );
    carEl.innerHTML = CAR_HTML;
    map.getContainer().appendChild(carEl);
    // 手動パンで追従を外した時の自車＝地理マーカー（実位置に残す）。追従中は非表示。
    const geoEl = document.createElement("div");
    geoEl.style.position = "relative"; // 標高ラベル(absolute)の位置基準
    geoEl.innerHTML = CAR_HTML;
    geoEl.style.display = "none";
    const geoMarker = new mapboxgl.Marker({ element: geoEl, anchor: "center" });
    const c0 = propsRef.current.userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };
    geoMarker.setLngLat([c0.lng, c0.lat]).addTo(map);

    // 「現在地」ボタン（手動パンで追従が外れた時だけ表示→タップで自車へ復帰）
    const recBtn = document.createElement("button");
    recBtn.type = "button";
    recBtn.className = "recenter-btn"; // 右・中央（Leaflet版と同じ位置）
    recBtn.textContent = "📍 現在地";
    recBtn.style.display = "none"; // 追従中は非表示（パンで表示）
    const setFollowing = (on: boolean) => {
      following = on;
      carEl.style.display = on ? "" : "none"; // 追従中だけ画面固定の自車
      geoEl.style.display = on ? "none" : ""; // パン中だけ地理マーカー（実位置）
      recBtn.style.display = on ? "none" : "";
    };
    recBtn.onclick = () => {
      setFollowing(true);
      if (lastHere)
        map.easeTo({ center: lastHere, bearing: headingUp ? lastBearing : 0, offset: [0, leadPx()], duration: 600 });
    };
    map.getContainer().appendChild(recBtn);
    // ユーザーの手動パンのみで追従解除（easeTo等の自動移動は originalEvent が無いので除外）
    const onUserPan = (e: { originalEvent?: unknown }) => {
      if (!following || !e.originalEvent) return;
      setFollowing(false);
    };
    map.on("dragstart", onUserPan);

    // 右上: 現在地の住所（番地除く）をリアルタイム表示（約40m移動ごと・GSI逆ジオコーダ）
    const addrBox = document.createElement("div");
    addrBox.className = "addr-box";
    addrBox.textContent = "📍 現在地 測位中…";
    map.getContainer().appendChild(addrBox);
    let lastAddrPt: Pt | null = null;
    let addrReqId = 0;
    let elevReqId = 0; // 自車横の標高表示の競合排除（住所と同じ約40m毎に更新）

    // 左上(残距離の下): 目的地名＋方位矢印（地図の向きに対する相対方位）。目的地セット時のみ表示。
    const destBox = document.createElement("div");
    destBox.className = "dest-box";
    destBox.style.display = "none";
    destBox.innerHTML =
      '<svg class="dest-arrow" width="20" height="20" viewBox="0 0 24 24"><path d="M12 2 L19 20 L12 15 L5 20 Z" fill="#2f9e44" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<span class="dest-txt"></span>';
    map.getContainer().appendChild(destBox);
    const norm360 = (d: number) => ((d % 360) + 360) % 360;
    const angDiff = (a: number, b: number) => (((a - b + 540) % 360) - 180); // a-b を[-180,180)
    // 較正済みコンパス方位（停車時の地図回転・DRのカーブ追従に使う）。コンパス未取得なら null。
    const compassHeading = (): number | null =>
      rawCompass == null ? null : compassOffset != null ? norm360(rawCompass + compassOffset) : rawCompass;
    // DRの前進方向: 較正済みコンパス優先（トンネルのカーブ追従）→ 無ければ直近の進行方位 → 北。
    const drHeading = (): number => compassHeading() ?? lastTravelHeading ?? 0;

    // 速度計（左下・Leaflet版と同じリングゲージ：背景トラック＋速度色アーク＋先端ビーズ＋数値）
    const box = document.createElement("div");
    box.className = "follow-box";
    const CX = 50;
    const CY = 52;
    const MAXKMH = 120;
    const R_ARC = 44;
    const angOf = (kmh: number) => -120 + (Math.min(Math.max(kmh, 0), MAXKMH) / MAXKMH) * 240;
    const speedColor = (kmh: number) => (kmh < 1 ? "#868e96" : kmhColor(kmh));
    const arcPath = (kmh: number) => {
      const a0 = ((angOf(0) - 90) * Math.PI) / 180;
      const a1 = ((angOf(kmh) - 90) * Math.PI) / 180;
      const p0 = `${(CX + R_ARC * Math.cos(a0)).toFixed(2)} ${(CY + R_ARC * Math.sin(a0)).toFixed(2)}`;
      const p1 = `${(CX + R_ARC * Math.cos(a1)).toFixed(2)} ${(CY + R_ARC * Math.sin(a1)).toFixed(2)}`;
      const large = angOf(kmh) - angOf(0) > 180 ? 1 : 0;
      return `M ${p0} A ${R_ARC} ${R_ARC} 0 ${large} 1 ${p1}`;
    };
    const trackD = arcPath(MAXKMH);
    const startA = ((angOf(0) - 90) * Math.PI) / 180;
    const tipX0 = (CX + R_ARC * Math.cos(startA)).toFixed(2);
    const tipY0 = (CY + R_ARC * Math.sin(startA)).toFixed(2);
    box.innerHTML =
      '<svg class="speedo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      `<path d="${trackD}" fill="none" stroke="#262b34" stroke-width="6" stroke-linecap="round"/>` +
      '<path class="speedo-arc" d="" fill="none" stroke="#868e96" stroke-width="6" stroke-linecap="round"/>' +
      `<circle class="speedo-tip" cx="${tipX0}" cy="${tipY0}" r="3.4" fill="#868e96" stroke="#11141a" stroke-width="1.4"/>` +
      `<text class="speedo-num" x="${CX}" y="59" font-size="33" font-weight="800" fill="#eef1f5" text-anchor="middle">0</text>` +
      `<text x="${CX}" y="72" font-size="8.5" font-weight="600" fill="#9aa3ae" text-anchor="middle" letter-spacing="1">km/h</text>` +
      '</svg><div class="speedo-status">測位中…</div>';
    map.getContainer().appendChild(box);
    const tipEl = box.querySelector(".speedo-tip");
    const numEl = box.querySelector(".speedo-num");
    const arcEl = box.querySelector(".speedo-arc");
    const statusEl = box.querySelector(".speedo-status");
    let targetKmh = 0;
    let dispKmh = 0;
    const speedoAnim = window.setInterval(() => {
      dispKmh += (targetKmh - dispKmh) * 0.18;
      if (Math.abs(targetKmh - dispKmh) < 0.15) dispKmh = targetKmh;
      const col = speedColor(dispKmh);
      if (arcEl) {
        arcEl.setAttribute("d", dispKmh < 0.5 ? "" : arcPath(dispKmh));
        arcEl.setAttribute("stroke", col);
      }
      if (tipEl) {
        const a = ((angOf(dispKmh) - 90) * Math.PI) / 180;
        tipEl.setAttribute("cx", (CX + R_ARC * Math.cos(a)).toFixed(2));
        tipEl.setAttribute("cy", (CY + R_ARC * Math.sin(a)).toFixed(2));
        tipEl.setAttribute("fill", col);
      }
      if (numEl) numEl.textContent = String(Math.round(dispKmh));
    }, 50);
    const updateSpeedo = (kmh: number | null, moving: boolean, accuracy: number | null) => {
      targetKmh = kmh ?? 0;
      if (statusEl)
        statusEl.textContent =
          (moving ? "走行中" : "停車") + (accuracy ? ` ・ ±${Math.round(accuracy)}m` : "");
    };

    // 走行中は通常の現在地ドットを隠す
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;

    // 自車の向き表示: ヘディングアップは地図が回るので矢印は上向き固定。
    // ノースアップ(既定)は地図が北固定なので、自車「矢印」を進行方位へ回す（Leaflet版と同じ）。
    // 走行中はGPS/経路方位、停車中はコンパス方位。最短回転(carRot)でなめらかに。
    const applyCarRotation = () => {
      if (headingUp) return;
      const moving = targetKmh > MOVE_KMH;
      const hd = moving ? lastTravelHeading : compassHeading() ?? lastTravelHeading;
      if (hd == null) return;
      carRot += angDiff(hd, carRot);
      const a = carEl.querySelector(".car-arrow") as HTMLElement | null;
      const b = geoEl.querySelector(".car-arrow") as HTMLElement | null;
      if (a) a.style.transform = `rotate(${carRot}deg)`;
      if (b) b.style.transform = `rotate(${carRot}deg)`;
    };

    const onFix = (p: GeolocationPosition) => {
      if (aborted) return;
      if (drMode) {
        // GPS復帰: 推測走行を解除（以降のeaseToが推定位置→実フィックスを滑らかに補正）
        drMode = false;
        carEl.classList.remove("car-dr");
      }
      addTrackPoint(p.coords.latitude, p.coords.longitude, p.timestamp); // 走行軌跡を記録（生GPS）
      const sp = p.coords.speed; // m/s
      const kmh = sp != null && sp >= 0 ? sp * 3.6 : null;
      updateSpeedo(kmh, kmh != null && kmh > MOVE_KMH, p.coords.accuracy ?? null);
      // トンネルDR用の記録: 直近フィックス時刻と有効速度（無効値は前回を保持）
      haveFix = true;
      lastFixPerf = performance.now();
      if (sp != null && sp >= 0) lastGoodSpeedMs = sp;
      // 経路案内中はGPSを経路へスナップ（無料のmap matching）し、向きも道路セグメント方位に。
      // 経路が無い/古い時は生GPS＋GPS進行方位にフォールバック。rAFが tgt へ補間して描画する。
      const snap = routeSnapRef.current;
      const useSnap = !!snap && Date.now() - snap.at < 3000;
      const here: [number, number] = useSnap
        ? [snap!.proj.lng, snap!.proj.lat]
        : [p.coords.longitude, p.coords.latitude];
      lastHere = here;
      geoMarker.setLngLat(here); // 地理マーカーは常に実位置（パン中の自車表示用）
      // 現在地の住所（番地除く）を約40m移動ごとに更新（生GPSで）
      const rawPt = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (!lastAddrPt || haversineKm(lastAddrPt, rawPt) > 0.04) {
        lastAddrPt = rawPt;
        const aid = ++addrReqId;
        reverseAddressNoBanchi(rawPt.lat, rawPt.lng).then((a) => {
          if (aid === addrReqId && !aborted) addrBox.textContent = a ? `📍 ${a}` : "📍 現在地 取得できません";
        });
        // 自車横の標高(m)も同じ約40m毎に更新（Leaflet版「標高 ◯m」常設表示の移植・GSI標高API無料）
        const eid = ++elevReqId;
        fetchElevationStr(rawPt.lat, rawPt.lng).then((t) => {
          if (eid !== elevReqId || aborted) return;
          const txt = t ? `標高 ${t}` : "標高 -";
          const a = carEl.querySelector(".car-elev-label");
          const b = geoEl.querySelector(".car-elev-label");
          if (a) a.textContent = txt;
          if (b) b.textContent = txt;
        });
      }
      // 目的地方位ボックス: 目的地名＋方位矢印（地図の向きに対する相対方位）
      const dst = propsRef.current.dest;
      if (dst) {
        destBox.style.display = "";
        const dkm = haversineKm(rawPt, { lat: dst.lat, lng: dst.lng });
        const txt = destBox.querySelector(".dest-txt") as HTMLElement | null;
        const arr = destBox.querySelector(".dest-arrow") as HTMLElement | null;
        if (dkm < 0.06) {
          if (txt) txt.textContent = `まもなく到着: ${dst.name ?? ""}`;
          if (arr) arr.style.visibility = "hidden";
        } else {
          if (txt) txt.textContent = dst.name ?? "目的地";
          if (arr) {
            arr.style.visibility = "";
            const rel = norm360(bearingDeg(rawPt, { lat: dst.lat, lng: dst.lng }) - map.getBearing());
            arr.style.transform = `rotate(${rel}deg)`;
          }
        }
      } else {
        destBox.style.display = "none";
      }
      const hd = p.coords.heading;
      const gpsHdOk = hd != null && isFinite(hd) && hd >= 0;
      let travelHd: number | null = useSnap ? snap!.bearing : gpsHdOk ? hd : null;
      // GPS heading を返さない端末向けフォールバック: 連続GPS位置の差分から進行方位（約15m以上動いた時）
      if (!hdgPrevPt) hdgPrevPt = rawPt;
      else if (haversineKm(hdgPrevPt, rawPt) >= 0.015) {
        if (travelHd == null) travelHd = bearingDeg(hdgPrevPt, rawPt);
        hdgPrevPt = rawPt;
      }
      if (kmh != null && kmh > MOVE_KMH && travelHd != null) {
        lastTravelHeading = travelHd; // DRの前進方向（真北基準・ノース/ヘディング非依存）
        // 走行中はGPS/経路方位を正解として、停車時用にコンパスoffsetを学習（低域通過）
        if (sp != null && sp > 3 && rawCompass != null) {
          const o = angDiff(travelHd, rawCompass);
          compassOffset = compassOffset == null ? o : compassOffset + 0.3 * angDiff(o, compassOffset);
        }
        if (headingUp) lastBearing = travelHd; // ヘディングアップは地図を進行方位へ回す
      }
      applyCarRotation(); // ノースアップは自車矢印を進行方位へ回す（ヘディングアップは地図回転に任せる）
      if (!following) return; // 手動パン中はカメラを動かさない（自車は地理マーカーで実位置に表示）
      const bearing = headingUp ? lastBearing : 0;
      if (first) {
        first = false;
        // 追従開始時はユーザーの現在ズームを保持（150m等の設定を尊重）。広域閲覧中(<14)なら運転用にDRIVE_ZOOMへ寄せる。
        const startZoom = map.getZoom() >= 14 ? map.getZoom() : DRIVE_ZOOM;
        map.easeTo({ center: here, bearing, pitch: 0, zoom: startZoom, offset: [0, leadPx()], duration: 800 });
        prevCam = here;
      } else {
        // GPSグリッチ/トンネル復帰で前回カメラ位置から150m超ジャンプしたら、滑らかに追わず即スナップ
        // （誤った遠方へ1.1秒かけて流れて戻る不快な動きを防ぐ。Leaflet版の>150m即スナップ移植）。
        const movedKm = prevCam ? haversineKm({ lng: prevCam[0], lat: prevCam[1] }, { lng: here[0], lat: here[1] }) : 0;
        const isJump = !!prevCam && movedKm > 0.15;
        const stationary = kmh == null || kmh <= MOVE_KMH;
        // 停車中＋ほぼ不動(20m未満)はパンを打たない（毎フィックスのeaseToによる微ジッタ・電力を抑制。Leaflet版同様）。
        if (!isJump && stationary && prevCam && movedKm < 0.02) {
          /* 据え置き（パンしない） */
        } else {
          // 1Hzフィックス間を線形イージング(間隔より少し長い1100ms)で繋ぎ、画面固定の自車に地図がなめらかに流れる。
          map.easeTo({ center: here, bearing, offset: [0, leadPx()], duration: isJump ? 0 : 1100, easing: (t) => t });
          prevCam = here;
        }
      }
    };

    // Wake Lock（画面を消さない）
    const nav = navigator as unknown as {
      wakeLock?: { request(type: string): Promise<{ release(): void }> };
    };
    let wake: { release(): void } | null = null;
    const reqWake = () => {
      nav.wakeLock
        ?.request("screen")
        .then((w) => {
          wake = w;
        })
        .catch(() => {
          /* 取得不可は無視 */
        });
    };
    reqWake();
    const onVis = () => {
      if (document.visibilityState === "visible") reqWake();
    };
    document.addEventListener("visibilitychange", onVis);

    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(onFix, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 15000,
      });
    }

    // 端末コンパス: 停車時にヘディングアップで地図を向きへ追従回転（駐車中に車を回すと地図も回る）。
    // 走行中はGPS方位(onFix)に任せ、DR中は staleTimer 側で扱う。許可はApp.tsxがタップ内で取得済み。
    let lastCompassEase = 0;
    const onOrient = (e: DeviceOrientationEvent) => {
      const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      let raw: number | null = null;
      if (ev.webkitCompassHeading != null && !Number.isNaN(ev.webkitCompassHeading)) raw = ev.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) raw = (360 - e.alpha) % 360;
      if (raw == null || Number.isNaN(raw)) return;
      rawCompass = norm360(raw);
      if (!following || drMode) return;
      if (targetKmh > MOVE_KMH) return; // 走行中はGPS方位(onFix)に任せる
      if (headingUp) {
        // ヘディングアップ停車中: 地図をコンパス方位へ追従回転（駐車中に車を回すと地図も回る）
        const ch = compassHeading();
        if (ch == null) return;
        const now = performance.now();
        if (now - lastCompassEase < 250) return; // 連続イベントを間引き
        if (Math.abs(angDiff(ch, lastBearing)) < 2) return; // 微小変化は無視（ジッタ抑制）
        lastCompassEase = now;
        lastBearing = ch;
        if (lastHere) map.easeTo({ center: lastHere, bearing: ch, offset: [0, leadPx()], duration: 250 });
      } else {
        // ノースアップ停車中: コンパスで自車「矢印」を回す（地図は北固定）
        applyCarRotation();
      }
    };
    // コンパスは追従中つねに起動（ヘディングアップ=停車時に地図回転／ノースアップ=停車時に自車矢印を回す）。
    // 許可はApp.tsxがタップ内で取得済み（requestOrientationPermission）。
    window.addEventListener("deviceorientationabsolute", onOrient as EventListener, true);
    window.addEventListener("deviceorientation", onOrient, true);

    // トンネルDR: GPSが GPS_STALE_MS 途切れ、直前まで走行していたら推測走行へ。直前速度×方位で前進し地図を流す。
    const GPS_STALE_MS = 4000;
    const staleTimer = window.setInterval(() => {
      if (!haveFix || !following) return;
      const now = performance.now();
      if (!drMode) {
        if (now - lastFixPerf > GPS_STALE_MS && lastGoodSpeedMs > 1.5 && lastHere) {
          drMode = true;
          drLng = lastHere[0];
          drLat = lastHere[1];
          drLastPerf = now;
          carEl.classList.add("car-dr"); // 自車をゴースト表示
          if (statusEl) statusEl.textContent = "📡 推定走行中（GPS弱・トンネル？）";
        }
        return;
      }
      const dt = Math.min(1.5, (now - drLastPerf) / 1000); // タブ復帰時の暴走防止に上限
      drLastPerf = now;
      const hdg = drHeading();
      const distKm = (lastGoodSpeedMs * dt) / 1000;
      const rad = (hdg * Math.PI) / 180;
      drLat += (distKm / 111.32) * Math.cos(rad);
      drLng += (distKm / (111.32 * Math.cos((drLat * Math.PI) / 180))) * Math.sin(rad);
      lastHere = [drLng, drLat];
      geoMarker.setLngLat(lastHere);
      if (headingUp) lastBearing = compassHeading() ?? hdg;
      map.easeTo({
        center: lastHere,
        bearing: headingUp ? lastBearing : 0,
        offset: [0, leadPx()],
        duration: 1000,
        easing: (t) => t,
      });
      prevCam = lastHere; // DRの前進もカメラ追従先として記録（GPS復帰時のジャンプ判定を正しく）
    }, 1000);

    // sim時のみ: タイマー/コンパスのスロットルに依存せずDR・コンパスを決定論検証するフック
    if (new URLSearchParams(window.location.search).get("sim") === "drive") {
      (window as unknown as Record<string, unknown>).__follow = {
        state: () => ({
          drMode,
          lat: drLat,
          lng: drLng,
          heading: drHeading(),
          lastGoodSpeedMs,
          sinceFixMs: Math.round(performance.now() - lastFixPerf),
          compass: rawCompass,
          offset: compassOffset,
          bearing: map.getBearing(),
        }),
        enterDr: () => {
          if (!lastHere) return null;
          drMode = true;
          drLng = lastHere[0];
          drLat = lastHere[1];
          drLastPerf = performance.now();
          carEl.classList.add("car-dr");
          if (statusEl) statusEl.textContent = "📡 推定走行中（GPS弱・トンネル？）";
          return [drLng, drLat];
        },
        drStep: (ms: number) => {
          const hdg = drHeading();
          const distKm = (lastGoodSpeedMs * (ms / 1000)) / 1000;
          const rad = (hdg * Math.PI) / 180;
          drLat += (distKm / 111.32) * Math.cos(rad);
          drLng += (distKm / (111.32 * Math.cos((drLat * Math.PI) / 180))) * Math.sin(rad);
          lastHere = [drLng, drLat];
          return [drLng, drLat];
        },
        setCompass: (deg: number) => {
          rawCompass = norm360(deg);
          return compassHeading();
        },
      };
    }

    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      window.clearInterval(staleTimer);
      window.removeEventListener("deviceorientationabsolute", onOrient as EventListener, true);
      window.removeEventListener("deviceorientation", onOrient, true);
      document.removeEventListener("visibilitychange", onVis);
      try {
        wake?.release();
      } catch {
        /* 無視 */
      }
      map.off("dragstart", onUserPan);
      carEl.remove();
      geoMarker.remove();
      recBtn.remove();
      addrBox.remove();
      destBox.remove();
      box.remove();
      window.clearInterval(speedoAnim);
      // ブラウズ表示へ戻す（北向き・水平）
      map.easeTo({ bearing: 0, pitch: 0, duration: 600 });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.follow, props.headingUp]);

  // 標高/勾配メーター（Stage 2c）: 追従走行中、進行方位の前方80mのDEM標高差から勾配を先読み表示。
  // 経路スナップ中は道路セグメント方位を使うので route/free 両対応。GSI標高API=無料。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.follow) return;
    let aborted = false;
    let watchId: number | null = null;
    const AHEAD_M = 80;
    const MIN_MOVE_KM = 0.05; // 50m移動ごとに勾配を再計測（表示は維持）
    let lastHeading: number | null = null;
    let lastUpdatePos: Pt | null = null;
    let prevPos: Pt | null = null;
    let reqId = 0;
    let lastGrade: number | null = null;
    let prevSpeed: number | null = null; // ジャイロveto: 加減速(速度微分)算出用
    let lastFixT = 0;

    const box = document.createElement("div");
    box.className = "grade-box";
    map.getContainer().appendChild(box);
    const render = (g: number | null) => {
      // 高速道路ではDEM標高が道路と乖離し勾配が誤るため非表示（Leaflet版と同じ。経路の高速判定 or 手動高速ON時）
      if (hwActiveRef.current || propsRef.current.hwOverride === "on") {
        box.style.display = "none";
        return;
      }
      box.style.display = "";
      updateGradeMeter(box, g, aheadGradeRef.current); // 現在勾配＋この先の急勾配予告（経路effectが供給）
    };
    render(lastGrade); // マウント直後から「—」で表示

    // sim/debug時のみ: 中央値フィルタ＋ヒステリシスを実boxで決定論検証するフック
    const q = new URLSearchParams(window.location.search);
    if (q.get("sim") === "drive" || q.get("debug") === "1") {
      (window as unknown as Record<string, unknown>).__grade = {
        feed: (v: number | null) => {
          updateGradeMeter(box, v, null);
          return box.querySelector(".gm-label")?.textContent;
        },
        label: () => box.querySelector(".gm-label")?.textContent,
        ahead: () => aheadGradeRef.current, // 経路effectが先読みした「この先急勾配」の中身
        feedWarn: (w: { grade: number; distM: number } | null) => {
          updateGradeMeter(box, lastGrade ?? 1, w); // 予告描画の確認用
          const el = box.querySelector(".grade-warn") as HTMLElement | null;
          return { text: el?.textContent ?? null, shown: el ? el.style.display !== "none" : null };
        },
      };
    }

    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
      // Phase2 ジャイロveto: トグル状態を反映し、定速巡航＆DEM平坦時のみ基準姿勢g0を学習（坂では学習しない）
      _pitch.enabled = propsRef.current.gyroGrade;
      const sp = p.coords.speed;
      const dtFix = lastFixT > 0 ? (p.timestamp - lastFixT) / 1000 : 0;
      lastFixT = p.timestamp;
      if (sp != null && sp >= 0) {
        if (prevSpeed != null && dtFix > 0.05) _pitch.accel = (sp - prevSpeed) / dtFix;
        prevSpeed = sp;
        if (sp > 3 && Math.abs(_pitch.accel) < PITCH_ACC_GATE && _pitch.demFlat && _pitch.g) {
          if (!_pitch.g0) _pitch.g0 = [..._pitch.g];
          else _pitch.g0 = _pitch.g0.map((v, i) => v + G0_GAIN * (_pitch.g![i] - v));
        }
      }
      // 向き: 経路スナップ中は道路方位、なければGPS進行方位、それも無ければ移動方向
      const snap = routeSnapRef.current;
      const useSnap = !!snap && Date.now() - snap.at < 3000;
      const hd = p.coords.heading;
      const gpsOk = hd != null && isFinite(hd) && hd >= 0;
      if (useSnap) lastHeading = snap!.bearing;
      else if (gpsOk) lastHeading = hd;
      if (!prevPos) prevPos = here;
      else if (haversineKm(prevPos, here) >= 0.02) {
        if (!useSnap && !gpsOk) lastHeading = bearingDeg(prevPos, here);
        prevPos = here;
      }
      render(lastGrade);
      if (lastHeading == null) return; // 方位不明(未発進)は「—」表示のみ
      if (lastUpdatePos && haversineKm(here, lastUpdatePos) < MIN_MOVE_KM) return;
      lastUpdatePos = here;
      const ahead = pointAhead(here, lastHeading, AHEAD_M);
      const id = ++reqId;
      Promise.all([
        fetchElevationNum(here.lat, here.lng),
        fetchElevationNum(ahead.lat, ahead.lng),
      ]).then(([e0, e1]) => {
        if (aborted || id !== reqId) return;
        let g: number | null = null;
        if (e0 != null && e1 != null) {
          const gv = ((e1 - e0) / AHEAD_M) * 100;
          if (Math.abs(gv) <= GRADE_MAX_PLAUSIBLE) g = gv;
        }
        lastGrade = g;
        render(g);
      });
    };

    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(onPos, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      });
    }
    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      box.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.follow]);

  // ジャイロ平坦補正(gyroGrade)ON時だけ devicemotion を起動。既定OFFでは加速度センサーを
  // 起動せず省電力（発熱低減）。重力ベクトルgを低域通過抽出し updateGradeMeter の veto が読む。
  useEffect(() => {
    if (!mapReady || !props.follow || !props.gyroGrade) return;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const s = [a.x, a.y, a.z];
      if (!_pitch.g) _pitch.g = s;
      else _pitch.g = _pitch.g.map((v, i) => v * GRAV_LP + s[i] * (1 - GRAV_LP));
    };
    window.addEventListener("devicemotion", onMotion);
    return () => {
      window.removeEventListener("devicemotion", onMotion);
      _pitch.g = null; // OFFにしたら基準をクリア（古い姿勢でvetoが誤発火しないよう）
    };
  }, [mapReady, props.follow, props.gyroGrade]);

  // ---- 以下はクロージャ内ヘルパ（関数宣言＝巻き上げ済み。propsRef で最新値を読む） ----

  function setupLayers(map: mapboxgl.Map) {
    map.addSource("shops", {
      type: "geojson",
      data: shopsGeoJSON(propsRef.current.shops),
      cluster: true,
      clusterRadius: 44,
      clusterMaxZoom: 14,
    });
    // クラスタ（件数で色・大きさを段階表示）
    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "shops",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#4dabf7", 25, "#4263eb", 100, "#7048e8"],
        "circle-radius": ["step", ["get", "point_count"], 16, 25, 20, 100, 26],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 0.92,
      },
    });
    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "shops",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-size": 13,
        "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
      },
      paint: { "text-color": "#ffffff" },
    });
    // 個別ピン＝しずく型（Leaflet版 pinIcon と同形状）。tier別にしずく画像を生成して登録。
    for (let i = 0; i < TIER_COLORS.length; i++) {
      if (!map.hasImage(`pin${i}`)) {
        map.addImage(`pin${i}`, teardropImageData(TIER_COLORS[i], 2), { pixelRatio: 2 });
      }
    }
    map.addLayer({
      id: "shops-pin",
      type: "symbol",
      source: "shops",
      filter: ["!", ["has", "point_count"]],
      layout: {
        "icon-image": ["match", ["get", "tier"], 2, "pin2", 1, "pin1", "pin0"],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-size": 1,
        // 評価値をしずく上部の白円に重ねる（数値色は tier 色）
        "text-field": ["get", "ratingText"],
        "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Bold"],
        "text-size": 11,
        "text-offset": [0, -2.55],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": ["match", ["get", "tier"], 2, "#d6336c", 1, "#e8590c", "#1c7ed6"],
      },
    });
  }

  function wireInteractions(map: mapboxgl.Map) {
    map.on("click", "clusters", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
      if (!f || !f.properties) return;
      const id = f.properties.cluster_id as number;
      const src = map.getSource("shops") as mapboxgl.GeoJSONSource;
      src.getClusterExpansionZoom(id, (err, zoom) => {
        if (err || zoom == null) return;
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        map.easeTo({ center: c, zoom });
      });
    });
    const openFromFeature = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
      const f = e.features && e.features[0];
      if (!f || !f.properties) return;
      const shop = propsRef.current.shops[f.properties.idx as number];
      const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      openShopPopup(map, shop, c);
    };
    map.on("click", "shops-pin", openFromFeature);
    for (const ly of ["clusters", "shops-pin"]) {
      map.on("mouseenter", ly, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", ly, () => {
        map.getCanvas().style.cursor = "";
      });
    }
  }

  function openShopPopup(map: mapboxgl.Map, shop: Shop | undefined, lngLat: [number, number]) {
    if (!shop) return;
    const p = propsRef.current;
    const km = p.distanceTo(shop);
    const fav = p.isFav(shop);
    const el = document.createElement("div");
    el.className = "popup";
    el.innerHTML = `
      <div class="name">${esc(shop.name)}</div>
      <div><span class="r">★ ${shop.rating.toFixed(1)}</span> ／ 口コミ ${shop.reviews.toLocaleString()}件</div>
      ${km != null ? `<div class="popup__dist">📍 直線${esc(fmtDistance(km))}・車で約${roughMinutes(km)}分（目安）</div>` : ""}
      ${shop.address ? `<div>${esc(shop.address)}</div>` : ""}
      <div class="popup__actions">
        <button class="act act--nav" type="button">🚗 Googleマップ</button>
        <button class="act act--route" type="button">🧭 ルート</button>
        <button class="act act--fav${fav ? " on" : ""}" type="button" aria-pressed="${fav}">${fav ? "★" : "☆"}</button>
        <button class="act act--share" type="button">共有</button>
      </div>
      <a href="${esc(shop.reviewsUrl ?? shop.mapsUrl)}" target="_blank" rel="noreferrer">💬 口コミを見る →</a>
    `;
    const q = (sel: string) => el.querySelector(sel) as HTMLButtonElement | null;
    q(".act--nav") && (q(".act--nav")!.onclick = () => p.onNav(shop));
    q(".act--route") && (q(".act--route")!.onclick = () => p.onSetDest(shop));
    q(".act--share") && (q(".act--share")!.onclick = () => p.onShare(shop));
    const favBtn = q(".act--fav");
    if (favBtn)
      favBtn.onclick = () => {
        p.onToggleFav(shop);
        const on = p.isFav(shop);
        favBtn.textContent = on ? "★" : "☆";
        favBtn.classList.toggle("on", on);
        favBtn.setAttribute("aria-pressed", String(on));
      };
    popupRef.current?.remove();
    popupRef.current = new mapboxgl.Popup({ offset: 16, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setDOMContent(el)
      .addTo(map);
  }

  function placeUser(map: mapboxgl.Map, pos: Pt | null) {
    if (!pos) return;
    if (propsRef.current.follow) {
      // 走行追従中は自車矢印（follow effect）が現在地を示すので通常ドットは出さない
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "userloc";
      el.innerHTML = `<div class="userloc__dot"></div>`;
      userMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([pos.lng, pos.lat])
        .addTo(map);
    } else {
      userMarkerRef.current.setLngLat([pos.lng, pos.lat]);
    }
    // UserFocus 相当: 走行追従中以外は現在地へ寄せる。初回は復元ズーム（最低13）。
    if (!propsRef.current.follow) {
      const z = firstFixRef.current
        ? Math.max(getInitialView().zoom, 13)
        : Math.max(map.getZoom(), 13);
      firstFixRef.current = false;
      map.flyTo({ center: [pos.lng, pos.lat], zoom: z, duration: 0.6 });
    }
  }

  /** name 系ラベルを日本語化（name_ja優先）。ref=路線番号シールドは触らない（番号が消えないように）。
   *  元の text-size を保存して bigLabels トグルで拡大/復帰できるようにする。 */
  function applyLabels(map: mapboxgl.Map) {
    const layers = map.getStyle().layers || [];
    for (const ly of layers) {
      if (ly.type !== "symbol") continue;
      let tf: unknown;
      try {
        tf = map.getLayoutProperty(ly.id, "text-field");
      } catch {
        continue;
      }
      const s = tf == null ? "" : JSON.stringify(tf);
      if (!(s.indexOf("name") !== -1 && s.indexOf('"ref"') === -1)) continue;
      // 元の text-size はレイヤーごとに一度だけ捕捉（再実行で倍率が多重適用されないように）
      if (!(ly.id in labelOrigRef.current)) {
        let sz: unknown;
        try {
          sz = map.getLayoutProperty(ly.id, "text-size");
        } catch {
          sz = undefined;
        }
        labelOrigRef.current[ly.id] = sz == null ? 16 : sz;
      }
      try {
        map.setLayoutProperty(ly.id, "text-field", [
          "coalesce",
          ["get", "name_ja"],
          ["get", "name"],
          ["get", "name_en"],
        ]);
      } catch {
        /* レイヤーによっては不可 */
      }
      scaleLabel(map, ly.id);
    }
  }

  function scaleLabel(map: mapboxgl.Map, id: string) {
    const base = labelOrigRef.current[id];
    if (base === undefined) return;
    const factor = propsRef.current.bigLabels ? 1.3 : 1;
    try {
      map.setLayoutProperty(id, "text-size", scaleSize(base, factor) as unknown as number);
    } catch {
      /* 無視 */
    }
  }

  return (
    <div className="map" ref={containerRef}>
      {tokenMissing && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 500,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "24px",
            gap: "12px",
            background: "#15171a",
            color: "#e9ecef",
            font: "14px/1.7 -apple-system, sans-serif",
          }}
        >
          <div style={{ maxWidth: 440 }}>
            Mapboxの公開トークン（<code>pk.</code> で始まる文字列）を貼り付けてください。
            <br />
            一度入力すればこの端末に保存され、次回から自動で読み込まれます。
          </div>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="pk.…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{
              width: "min(90%, 440px)",
              padding: "12px",
              borderRadius: 8,
              border: "1px solid #444",
              background: "#000",
              color: "#0f0",
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
            }}
          />
          <button
            type="button"
            onClick={() => {
              const t = tokenInput.trim();
              if (!/^pk\./.test(t)) {
                alert("「pk.」で始まる公開トークンを貼り付けてください。");
                return;
              }
              try {
                localStorage.setItem("mapbox_poc_token", t);
              } catch {
                /* localStorage 不可 */
              }
              window.location.reload();
            }}
            style={{
              padding: "12px 24px",
              borderRadius: 8,
              border: 0,
              background: "#2e7d32",
              color: "#fff",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            適用して地図を表示
          </button>
          <div style={{ fontSize: 12, color: "#9ca3af", maxWidth: 440 }}>
            ※ 通常（Leaflet）版に戻すには URL 末尾に <code>?engine=leaflet</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(RamenMapbox);
