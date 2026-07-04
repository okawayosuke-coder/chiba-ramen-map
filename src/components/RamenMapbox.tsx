import { memo, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Shop } from "../types";
import { bearingDeg, bearingToArrowAngle, fmtDistance, haversineKm, roughMinutes, type Pt, type Dest } from "../nav";
import { fetchRoute, projectOnRoute, type RouteResult, type RouteManeuver } from "../route";
import { loadHighway, type HwFacility, type HwKind } from "../highwayData";
import { loadHighwayGeom, nearestHighway, type HighwayGeom } from "../highwayGeom";
import { loadSurfaceGeom, nearestSurface, type SurfaceGeom } from "../surfaceGeom";
import { ensureRegions, regionOf, regionsForCoords } from "../hwRegions";
import { buildPathIndex, buildForwardPath, projectToPath, type ForwardPathIndex } from "../forwardPath";
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
  traffic?: boolean; // リアルタイム渋滞表示（Mapbox Traffic v1）
  threeD?: boolean; // 3D表示（地形＋3D建物＋俯瞰ピッチ）。任意・既定OFF
  onToggle3D?: () => void; // 地図上「3D」ボタン（縮尺ボタンの下）から2D/3D切替
  onToggleHeadingUp?: () => void; // 地図上「方位」コンパスボタン（3Dボタンの下）からノースアップ/ヘディングアップ切替
  hwOverride: HwOverride;
  onCycleHwOverride: () => void;
  dest: Dest | null;
  onSetDest: (s: Dest) => void;
  onClearDest: () => void;
  candidate?: { lat: number; lng: number; name: string; subtitle?: string } | null; // 検索候補の目的地プレビュー（決定前・地図にピン＋確認ポップアップ）
  onCandidateClose?: () => void; // プレビューを閉じる（決定でルート化 or 取消）
  recenterDest?: number; // 増えるたびに地図を目的地（＋現在地）へ寄せる信号（目的地カードの「地図で見る」）
  home?: Dest | null; // 自宅（登録済みなら地図に🏠帰宅ボタンを表示）
  onGoHome?: () => void; // 🏠帰宅ボタン: 自宅を目的地に設定
  userPos: Pt | null;
  isFav: (s: Shop) => boolean;
  onToggleFav: (s: Shop) => void;
  onNav: (s: Dest) => void;
  onShare: (s: Shop) => void;
  distanceTo: (s: Shop) => number | null;
}

const STYLE_LIGHT = "mapbox://styles/mapbox/streets-v12";
// 夜間用。Mapbox Standard の night ライトプリセット＝駅/地名/POI/道路名がフル表示される本格的なダーク地図。
// （旧 dark-v11 はデータ可視化向けで駅ラベル層が無く情報量が極端に少なかったため刷新）
const STYLE_DARK = "mapbox://styles/mapbox/standard";
const styleFor = (t?: string): string => (t === "dark" ? STYLE_DARK : STYLE_LIGHT);
// Standard スタイルか（設定はconfig API、ラベルはconfigのlanguageで制御＝classicスタイルと扱いが異なる）
const isStandard = (url: string): boolean => url.indexOf("/standard") !== -1;
const PITCH_3D = 60; // 3D表示ON時の俯瞰ピッチ角（度）。OFFは0=真上から平面
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

/** 目的地（と現在地）が見えるよう地図を寄せる。現在地が60km圏ならfitBounds、遠ければ目的地へflyTo。 */
function fitCameraToDest(map: mapboxgl.Map, dest: Pt, userPos: Pt | null): void {
  if (userPos && haversineKm(userPos, dest) < 60) {
    map.fitBounds(
      [
        [Math.min(userPos.lng, dest.lng), Math.min(userPos.lat, dest.lat)],
        [Math.max(userPos.lng, dest.lng), Math.max(userPos.lat, dest.lat)],
      ],
      { padding: 80, maxZoom: 15, duration: 800 }
    );
  } else {
    map.flyTo({ center: [dest.lng, dest.lat], zoom: 13, duration: 800 });
  }
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
const GRADE_FLAT = 1.5; // これ未満は「ほぼ平坦」（g0学習ゲート・DEM符号判定に使用）
// 表示のヒステリシス帯（融合後 eff に適用）。履歴: [1.5,2.2]→(敏感すぎ報告)→[1.8,2.8]→(感度を若干戻す要望)→[1.5,2.4]。
// 却下された [1.5,2.2] よりONは高く保ち(2.4)、緩い坂を出しつつ偽の坂は抑える中間値。
const GRADE_SLOPE_ON = 2.4; // 平坦→「坂」表示へ切替える閾値（これを超えて初めて坂表示）
const GRADE_SLOPE_OFF = 1.5; // 「坂」→平坦へ戻す閾値（これ未満で平坦へ）。ON>OFFでちらつき抑制
const GRADE_MED_N = 5; // 中央値フィルタ窓（孤立した偽勾配を無視）。3→5に拡大し連続スパイク(橋手前+橋上等)にも耐性
const GRADE_MAX_PLAUSIBLE = 25; // これ超はDEM/経路ノイズとして無視
// 現在勾配は「現在地中心の標高プロファイルを最小二乗回帰」で算出（2点差分はノイズ過大のため廃止）。
const GRADE_REG_HALF = 100; // 回帰窓の片側(m)。現在地±100m
const GRADE_REG_STEP = 25; // 標高サンプル間隔(m)。±100m/25m間隔=9点
const GRADE_REG_MIN_PTS = 5; // 有効GSIサンプルがこれ未満なら勾配を出さない(「—」)
const GRADE_SPACING_KM = 0.08; // この先予告用の経路マーク間隔(80m)
const GRADE_LOOK = 11; // 前方何マーク先まで見るか（80m×11＝約880m先まで予告）
const GRADE_STEEP = 8; // この先「急勾配」と警告する閾値(%)

/** 標高を取得元タグ付き {v(m), src} で返す。GSI高精度DEM(src='gsi')→open-meteo概算(src='om')の順。
 *  海域/取得不可は null。セッション内キャッシュ。勾配計算は src='gsi' のみ採用し源混在を排除する。 */
type Elev = { v: number; src: "gsi" | "om" };
const _eleCache = new Map<string, Elev | null>();
async function fetchElev(lat: number, lng: number): Promise<Elev | null> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = _eleCache.get(key);
  if (hit !== undefined) return hit;
  let out: Elev | null = null;
  try {
    const r = await fetch(
      `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`
    );
    const j = await r.json();
    if (j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation)))
      out = { v: Number(j.elevation), src: "gsi" };
  } catch {
    /* GSI失敗時は予備へ */
  }
  if (out === null) {
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
      const j = await r.json();
      if (j && Array.isArray(j.elevation) && j.elevation[0] != null) out = { v: Number(j.elevation[0]), src: "om" };
    } catch {
      /* 取得不可 */
    }
  }
  _eleCache.set(key, out);
  return out;
}

/** 標高を数値(m)で返す（取得元は問わない）。この先急勾配予告など源を区別しない用途用。 */
async function fetchElevationNum(lat: number, lng: number): Promise<number | null> {
  const r = await fetchElev(lat, lng);
  return r ? r.v : null;
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

/** 縮尺(+/-)ボタンの下に置く「3D」ボタン＝2D/3D切替。ON時は青く点灯。 */
class ThreeDToggleControl implements mapboxgl.IControl {
  private _c?: HTMLDivElement;
  private _btn?: HTMLButtonElement;
  constructor(private opts: { isOn: () => boolean; onToggle: () => void }) {}
  onAdd(): HTMLElement {
    const c = document.createElement("div");
    c.className = "mapboxgl-ctrl mapboxgl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crm-3d-btn";
    b.setAttribute("aria-label", "2D/3D切替");
    b.textContent = "3D";
    b.addEventListener("click", () => this.opts.onToggle());
    c.appendChild(b);
    this._c = c;
    this._btn = b;
    this.setActive(this.opts.isOn());
    return c;
  }
  setActive(on: boolean): void {
    if (!this._btn) return;
    this._btn.classList.toggle("crm-3d-btn--on", on);
    this._btn.setAttribute("aria-pressed", String(on));
  }
  onRemove(): void {
    this._c?.remove();
    this._c = undefined;
    this._btn = undefined;
  }
}

/** 「3D」ボタンの下に置く方位コンパスボタン＝ノースアップ/ヘディングアップ切替。
 *  一般的カーナビ(Google/Appleマップ)に倣い、丸いコンパス意匠＋赤い北針＋N文字。
 *  針は地図の回転(bearing)に追従して常に真北を指す(setBearing)。ヘディングアップ時は青く点灯(setActive)。 */
class HeadingUpControl implements mapboxgl.IControl {
  private _c?: HTMLDivElement;
  private _btn?: HTMLButtonElement;
  private _rose?: SVGGElement;
  constructor(private opts: { isOn: () => boolean; onToggle: () => void }) {}
  onAdd(): HTMLElement {
    const c = document.createElement("div");
    c.className = "mapboxgl-ctrl mapboxgl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crm-heading-btn";
    b.setAttribute("aria-label", "地図の向き切替（ノースアップ/ヘディングアップ）");
    // コンパス: 円盤＋回転する針(赤い北＋N・灰色の南尾)。針だけ .crm-compass-rose を bearing で回す。
    b.innerHTML =
      '<svg viewBox="0 0 36 36" width="30" height="30" aria-hidden="true">' +
      '<circle cx="18" cy="18" r="15" fill="#f0f2f5" stroke="#c7ccd4" stroke-width="1"/>' +
      '<g class="crm-compass-rose">' +
      '<text x="18" y="9" text-anchor="middle" font-size="8" font-weight="800" fill="#e8483a">N</text>' +
      '<path d="M18 10.5 L21.5 26 L18 22.5 L14.5 26 Z" fill="#e8483a"/>' + // 北針(赤・上向き)
      '<path d="M18 30 L20.5 24 L18 25.5 L15.5 24 Z" fill="#9aa0a6"/>' + // 南尾(灰・下向き)
      "</g></svg>";
    b.addEventListener("click", () => this.opts.onToggle());
    c.appendChild(b);
    this._c = c;
    this._btn = b;
    this._rose = b.querySelector(".crm-compass-rose") as SVGGElement;
    this.setActive(this.opts.isOn());
    return c;
  }
  /** ヘディングアップ時に青点灯。ノースアップ(既定)は非点灯（＝標準状態）。 */
  setActive(on: boolean): void {
    if (!this._btn) return;
    this._btn.classList.toggle("crm-heading-btn--on", on);
    this._btn.setAttribute("aria-pressed", String(on));
  }
  /** 地図の bearing に合わせてコンパス針を回し、常に真北を指す（bearing=90(東が上)なら針は左向き）。 */
  setBearing(bearing: number): void {
    this._rose?.setAttribute("transform", `rotate(${-bearing} 18 18)`);
  }
  onRemove(): void {
    this._c?.remove();
    this._c = undefined;
    this._btn = undefined;
    this._rose = undefined;
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

/** 縮尺バーが「150 m」を表示するズームを返す。Scale150Controlは中心緯度で maxWidth(130px) 幅の実距離を
 *  roundNum150 で丸める＝実距離が [150,200) m のとき「150 m」と表示する。確実に150mへ入れるため中央付近の
 *  170m を狙う。Mapbox: metersPerPixel = 40075016.686 * cos(lat) / 2^(zoom+9)（512pxタイル）。 */
function zoomForScale150(lat: number): number {
  const TARGET_M = 170; // [150,200) の中央付近＝縮尺バーが確実に「150 m」表示になる
  const MAX_WIDTH = 130; // Scale150Control の maxWidth と一致
  return Math.log2((MAX_WIDTH * 40075016.686 * Math.cos((lat * Math.PI) / 180)) / TARGET_M) - 9;
}

/** from から進行方位 headingDeg(0=北) 方向へ distM メートル進んだ地点。 */
function pointAhead(from: Pt, headingDeg: number, distM: number): Pt {
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111320;
  const dLng = (distM * Math.sin(rad)) / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

/** 最小二乗で y=ax+b を当て {a:傾き, b:切片} を返す（x:沿道距離m, y:標高m → a=勾配[無次元]）。点<2 or 退化で null。 */
function lsqFit(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const a = (n * sxy - sx * sy) / denom;
  return { a, b: (sy - a * sx) / n };
}

/** ロバスト回帰の傾き(=勾配)を返す。一旦フィット→残差のMADで外れ値(道路を外れたDEMサンプル・橋/切土の
 *  飛び値)を除去して再フィット。2点差分より空間ノイズに頑健で、曲線部で一部サンプルが道路外の地形を
 *  拾っても外れ値除去で吸収する。点<2 or 退化で null。 */
function robustSlope(xs: number[], ys: number[]): number | null {
  const fit = lsqFit(xs, ys);
  if (!fit) return null;
  const res = xs.map((x, i) => Math.abs(ys[i] - (fit.a * x + fit.b)));
  const sorted = [...res].sort((a, b) => a - b);
  const mad = sorted[Math.floor(sorted.length / 2)];
  const thr = Math.max(3 * mad, 1.5); // 1.5m床: DEM量子化/微小起伏は残し、道路外れの数m級飛び値だけ落とす
  const kx: number[] = [], ky: number[] = [];
  for (let i = 0; i < xs.length; i++) if (res[i] <= thr) { kx.push(xs[i]); ky.push(ys[i]); }
  if (kx.length < 5) return fit.a; // 落としすぎたら初回フィットを採用
  const fit2 = lsqFit(kx, ky);
  return fit2 ? fit2.a : fit.a;
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
const PITCH_FLAT_GRADE = 3.0; // これ未満(%)の端末勾配は「水平」とみなし平坦表示(veto)。実走で敏感すぎのため2.6→3.0に不感帯拡大
const PITCH_ACC_GATE = 0.6; // |GPS速度微分|がこれ未満の時だけ傾きを信用(m/s^2)。加減速の前後G混入を除外
const PITCH_TURN_GATE = 6; // 進行方位の変化率がこれ未満(°/s)の時だけ傾きを信用＝急旋回のローリング混入を除外
const PITCH_LAT_GATE = 1.0; // 横G(=速度×方位変化率)がこれ未満(m/s^2)の時だけ傾きを信用。カーブ/車線変更/横勾配の
//                            ローリングが勾配に化けるのを除外（5%坂で20%等の偽値の主因）
const DEV_LP = 0.2; // 端末勾配のEMA平滑係数。実走で敏感すぎのため0.3→0.2（時定数≒3s→5s@1Hz）でより鈍く
const PITCH_DEV_MAXSTEP = 3; // 端末勾配の1サンプル最大変化(%)。段差/瞬間横Gのスパイクをハードに制限（5→3で強化）
const G0_GAIN = 0.05; // 平坦基準g0学習の低域通過ゲイン
const GRAV_LP = 0.9; // 重力ベクトル抽出の低域通過係数
// grade effect が書き込み(onMotion=g / onPos=accel,heading,g0,enabled)、updateGradeMeter が demFlat 書込み＆融合読取り。
const _pitch = {
  g: null as number[] | null, // 低域通過した重力ベクトル(端末frame)
  g0: null as number[] | null, // 平坦・直進巡航時に学習した基準姿勢
  accel: 0, // GPS速度の微分(m/s^2)
  headingRate: 0, // 進行方位の変化率(°/s)。旋回検出（高いと傾きを信用しない）
  lateralAccel: 0, // 横G(=速度×方位変化率, m/s^2)。カーブ/横勾配のローリング混入検出
  devGrade: 0, // 端末傾き由来の勾配%をEMA平滑した値（スパイク除去後の現在値）
  demFlat: true, // 直近のDEM勾配が平坦か(g0学習ゲート)
  lastSign: 1 as 1 | -1, // 直近の勾配符号（DEM平坦時の上り/下り判定に保持）
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
  // 直近のDEM勾配が平坦か＝grade effectのg0(基準姿勢)学習ゲートへ渡す（坂で学習しないため）
  _pitch.demFlat = Math.abs(med) < GRADE_FLAT;
  // ===== ジャイロは「平坦veto」専用（v0.8.13で双方向融合から降格）=====
  // 表示値は常にDEM(med=現在地中心の最小二乗回帰)。ジャイロは大きさも符号も足さない。
  // 「端末が明らかに水平なのにDEMが坂と言う」時だけ平坦化する片方向vetoのみ＝安全側。
  // 理由(実測): 旧融合は実体が加速度センサーのみ(rotationRate未使用)で、gravAngleDegがピッチとロールを
  //   区別できず路面カント/マウント横傾き4°で7%、登坂時のアクセル加速混入で過大評価、符号はDEM(遅)・
  //   大きさはジャイロ(速)で「逆/遅れ」を生んでいた。vetoに限定すればこれらは「vetoが発火しない=DEM値」
  //   に縮退し、偽の坂を押し上げない。
  let eff = med;
  if (
    _pitch.enabled &&
    _pitch.g != null &&
    _pitch.g0 != null &&
    Math.abs(_pitch.accel) < PITCH_ACC_GATE &&
    _pitch.headingRate < PITCH_TURN_GATE &&
    _pitch.lateralAccel < PITCH_LAT_GATE // 横G中（カーブ/車線変更/横勾配）は横傾きが混入するので信用しない
  ) {
    // 端末の傾き角→勾配%。1サンプル変化を制限＋EMAで平滑（段差/横Gの瞬間スパイク除去）。vetoのみに使用。
    const pitchDeg = gravAngleDeg(_pitch.g, _pitch.g0);
    const raw = Math.min(GRADE_MAX_PLAUSIBLE, Math.tan((pitchDeg * Math.PI) / 180) * 100);
    const stepped = Math.max(_pitch.devGrade - PITCH_DEV_MAXSTEP, Math.min(_pitch.devGrade + PITCH_DEV_MAXSTEP, raw));
    _pitch.devGrade += DEV_LP * (stepped - _pitch.devGrade);
    if (_pitch.devGrade < PITCH_FLAT_GRADE) eff = 0; // 端末ほぼ水平＝路面平坦（DEMの偽勾配のみvetoで平坦化）
    // devGradeが高い（ロール/加速混入含む）場合は veto しない＝DEM(med)をそのまま表示（偽の坂を作らない）
  }
  // ヒステリシス（融合後の eff に対して。ちらつき防止）。帯 [GRADE_SLOPE_OFF, GRADE_SLOPE_ON]。
  if (m.flat) {
    if (Math.abs(eff) > GRADE_SLOPE_ON) m.flat = false;
  } else if (Math.abs(eff) < GRADE_SLOPE_OFF) {
    m.flat = true;
  }
  const flat = m.flat;
  const col = flat ? "#9aa0a6" : eff > 0 ? "#EF9F27" : "#378ADD"; // 平坦灰/上り琥珀/下り青
  const labelCol = flat ? "#cdd3da" : eff > 0 ? "#FAC775" : "#85B7EB";
  const ang = flat ? 0 : Math.max(-34, Math.min(34, eff * 2.2)); // 視認性のため誇張（数値は実値）
  m.tilt.setAttribute("transform", `rotate(${(-ang).toFixed(1)} 85 56)`);
  m.road.setAttribute("stroke", col);
  const g = Math.abs(Math.round(eff));
  m.label.textContent = flat ? "0%" : eff > 0 ? `↗ ${g}%` : `↘ ${g}%`;
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
  // 白い輪郭は廃止（要望）。小型化(icon-size 0.65)で輪郭が矢印を覆い速度色が分かりづらくなるため、色塗りのみに。
  return ctx.getImageData(0, 0, s, s);
}

/** ミリ秒タイムスタンプ→JSTの "HH:MM"。渋滞/天気の更新時刻表示用。 */
function fmtHM(ts: number): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

/** 天気バーの中身HTML（Leaflet版と同一）。通常は当日のみ、.expanded で7日間。
 *  ラベル下に天気の取得時刻、渋滞ON時は渋滞タイルの取得時刻(.wx-traffic, 別途更新)を表示。 */
function weatherBarHTML(wx: Weather): string {
  const c = wmo(wx.current.code);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  // 現在温度の下に「予報地点」の市区町村名（Open-Meteo格子点の逆ジオ）。取得できた時だけ表示。
  const place = wx.place
    ? `<span class="wx-place" title="Open-Meteo予報地点（数値予報モデルの格子点）">📍${wx.place}</span>`
    : "";
  // 気象庁フォールバック時は現在の風速・降水量が無いため天気ラベルのみ（Open-Meteo時は従来どおり風・降水も出す）。
  const isJma = wx.source === "jma";
  const curSub = isJma
    ? c.label
    : `${c.label}<br>${wx.current.precip > 0 ? `☔${wx.current.precip}mm ・ ` : ""}💨${Math.round(
        wx.current.wind
      )}`;
  const cur =
    `<div class="wx-cur">` +
    `<span class="wx-emoji">${c.emoji}</span>` +
    `<span class="wx-temp-col"><span class="wx-temp">${Math.round(wx.current.temp)}°</span>${place}</span>` +
    `<span class="wx-cur-sub">${curSub}</span>` +
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
    `<div class="wx-label"><span class="wx-head">📍 天気 <span class="wx-upd">${fmtHM(
      wx.fetchedAt
    )}時点${isJma ? " ・ 気象庁" : ""}</span></span><span class="wx-traffic"></span></div>${cur}${today}` +
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
  // 追従カメラの一時停止API（followeffectが実体を書く）。目的地プレビュー/ルート全体表示のとき、
  // 走行モードを抜けずにカメラ追従だけ止めて全体を見せるために candidate/route effect から呼ぶ。
  // 復帰は「現在地」ボタン（followeffect内・setFollowing(true)）で手動。
  const followApiRef = useRef<{ suspend: () => void } | null>(null);
  const weatherBoxRef = useRef<HTMLDivElement | null>(null);
  const lastTrafficAtRef = useRef<number>(0); // 渋滞タイルを最後に取得した時刻(ms)。天気バーに「渋滞 HH:MM時点」表示
  const routeReapplyRef = useRef<(() => void) | null>(null); // 高速切替を次のGPS待たず即反映
  const hwToggleLabelRef = useRef<(() => void) | null>(null); // 高速トグルのラベル更新（follow基準effectが設定）
  const styleRef = useRef<string>(""); // 現在適用中の地図スタイルURL（テーマ切替の重複setStyle防止）
  const threeDCtrlRef = useRef<ThreeDToggleControl | null>(null); // 地図上「3D」ボタン（点灯状態の同期用）
  const headingCtrlRef = useRef<HeadingUpControl | null>(null); // 地図上「方位」コンパスボタン（点灯＋針回転の同期用）
  // 追従中(true)か手動パンで閲覧中(false)か。follow effect の再構築（headingUp/テーマ変更）を跨いで保持し、
  // 閲覧中に方位を切替えても追従が勝手に再開（＝自車へ再センター＋ズーム）しないようにする。
  const followingRef = useRef(true);
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

  // 地図長押しが発火した直後の click（指離し）を、標高プローブが拾わないよう1回だけ抑制するフラグ
  const suppressClickRef = useRef(false);

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
      // 日本語(漢字/かな)ラベルを端末ローカルフォントで生成＝CJKグリフのサーバDLが0に。
      // 読み込み高速化・通信減・描画負荷軽減（発熱対策にも寄与）。iOSのヒラギノを優先。
      localIdeographFontFamily: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans CJK JP', sans-serif",
    });
    mapRef.current = map;
    (window as unknown as Record<string, unknown>).__mbmap = map; // 検証/デバッグ用（試験エンジン時のみ）
    // ズーム+/- は左上（Leaflet版と同じ位置）。コンパスは出さない。Leaflet同様の半段(0.5)ズーム＝
    // 1タップ0.5段（標準1段だと「2段階」に感じる）＋縮尺150mを飛ばさない。CSSで大きくタップしやすく。
    map.addControl(new HalfStepZoomControl(), "top-left");
    // 縮尺ボタンの直下に「3D」ボタン（2D/3D切替）。同じ top-left に後から足すと縮尺の下へ積まれる。
    const threeDCtrl = new ThreeDToggleControl({
      isOn: () => !!propsRef.current.threeD,
      onToggle: () => propsRef.current.onToggle3D?.(),
    });
    map.addControl(threeDCtrl, "top-left");
    threeDCtrlRef.current = threeDCtrl;
    // 「3D」ボタンの直下に方位コンパスボタン（ノースアップ/ヘディングアップ切替）。同じ top-left で下へ積まれる。
    const headingCtrl = new HeadingUpControl({
      isOn: () => !!propsRef.current.headingUp,
      onToggle: () => propsRef.current.onToggleHeadingUp?.(),
    });
    map.addControl(headingCtrl, "top-left");
    headingCtrlRef.current = headingCtrl;
    // コンパス針を常に真北へ向ける＝地図の回転(gesture/easeTo/追従ループ)に追従。move/rotate 両方で更新（軽量）。
    const syncCompass = () => headingCtrlRef.current?.setBearing(map.getBearing());
    map.on("rotate", syncCompass);
    map.on("move", syncCompass);
    syncCompass();
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
      applyStandardConfig(map); // Standardスタイルなら night プリセット＋日本語ラベルを適用
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

    // 渋滞タイルを取得し終えた時刻を記録（Mapbox Traffic はデータ自体に時刻が無いため取得時刻で代用）。
    // 走行で新エリアのタイルが読まれる度に更新。天気バーの「🚗渋滞 HH:MM時点」に反映。
    map.on("sourcedata", (e) => {
      if (e.sourceId === "traffic" && e.isSourceLoaded) {
        lastTrafficAtRef.current = Date.now();
        paintTrafficTime();
      }
    });

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

  // リアルタイム渋滞表示のON/OFF（traffic レイヤの visibility 切替）。レイヤは setupLayers で常設。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer("traffic")) return;
    map.setLayoutProperty("traffic", "visibility", props.traffic ? "visible" : "none");
    paintTrafficTime(); // ON/OFFで渋滞時刻ラベルの表示を更新
  }, [mapReady, props.traffic]);

  // 3D表示（任意・既定OFF）: 地形起伏(raster-dem terrain)＋3D建物(fill-extrusion)＋俯瞰ピッチ。
  // dark/light切替の setStyle で source/layer は消えるが、mapReady false→true の再実行で再構築される。
  // ピッチは follow effect 側も propsRef.current.threeD を見て first/cleanup で設定（走行中も3D俯瞰に）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    threeDCtrlRef.current?.setActive(!!props.threeD); // 地図上「3D」ボタンの点灯を同期
    if (props.threeD) {
      if (!map.getSource("mapbox-dem")) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }
      map.setTerrain({ source: "mapbox-dem", exaggeration: 1.3 });
      // 手動の3D建物押出は classic スタイル(streets-v12)用。Standard(夜間)は建物を内蔵描画する
      // （pitchを倒すと自動で3D建物が立つ）ので composite/building の手動追加はスキップ＝二重描画/エラー回避。
      if (!isStandard(styleRef.current) && !map.getLayer("3d-buildings")) {
        const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
        map.addLayer(
          {
            id: "3d-buildings",
            type: "fill-extrusion",
            source: "composite",
            "source-layer": "building",
            filter: ["==", ["get", "extrude"], "true"],
            minzoom: 14,
            paint: {
              "fill-extrusion-color": "#8c98a8",
              "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, ["get", "height"]],
              "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, ["get", "min_height"]],
              "fill-extrusion-opacity": 0.6,
            },
          },
          firstSymbol
        );
      }
      map.easeTo({ pitch: PITCH_3D, duration: 600 });
    } else {
      map.setTerrain(null);
      if (map.getLayer("3d-buildings")) map.removeLayer("3d-buildings");
      map.easeTo({ pitch: 0, duration: 600 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.threeD]);

  // 走行モード終了時は追従状態を初期化＝次回の走行モード開始は必ず「追従」から始める
  // （前回セッションで手動パンして閲覧中(false)のまま終わっても持ち越さない）。
  useEffect(() => {
    if (!props.follow) followingRef.current = true;
  }, [props.follow]);

  // 方位コンパスボタン: 点灯状態を props.headingUp に同期＋ノースアップ切替時の即時「北へスナップ」。
  // スナップは「中心・ズームを維持したまま bearing だけ北へ」＝閲覧中のスクロール位置と縮尺を尊重する。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    headingCtrlRef.current?.setActive(!!props.headingUp); // 地図上コンパスボタンの点灯を同期（設定チップ操作にも追従）
    // 「自車ロック追従中」だけは follow effect が向きを制御するのでここでは触らない。
    // 非走行(ブラウズ) or 走行モードでも手動パンで閲覧中(followingRef=false)なら、ノースアップ化で向きだけ北へ回す
    // （中心・ズームは変えない＝手動でスクロールした位置と縮尺のまま北上にする。要望対応）。
    const carLocked = props.follow && followingRef.current;
    if (!props.headingUp && !carLocked && Math.abs(map.getBearing()) > 0.5) {
      map.easeTo({ bearing: 0, duration: 300 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.headingUp]);

  // 🏠帰宅ボタン（地図右・中央下＝ルート解除/HW切替の下）。自宅登録済みのときだけ常時表示し、
  // タップで自宅を目的地に設定（onGoHome→App）。走行中も駐車中も押せるよう地図オーバーレイに置く。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.home) return; // 自宅未登録なら出さない
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-btn";
    btn.textContent = "🏠 帰宅";
    btn.onclick = () => propsRef.current.onGoHome?.();
    map.getContainer().appendChild(btn);
    return () => {
      btn.remove();
    };
  }, [mapReady, props.home]);

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
      ".mapboxgl-ctrl,.recenter-btn,.clear-dest-btn,.hw-toggle,.home-btn,.follow-box,.addr-box,.dest-box,.route-box,.grade-box,.hw-strip,.weather-bar,.poi-hint,.lp-hint,.nav-sign";
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
      // 長押しで目的地候補を出した直後の click は標高を出さない（1回だけ消費）
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
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

  // 地図長押し → 任意地点を目的地に（Google/Apple Maps 流）。
  // 約600ms静止押下で仮ピン📍＋逆ジオの住所＋「ここへ案内」確認ポップアップを出す。
  // 単タップ（標高表示）・パン・ピンチズーム/回転とは独立（移動やマルチタッチで不成立）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const HOLD_MS = 600;
    const MOVE_TOL = 12; // px。押下後これ以上動いたら長押し不成立（パン扱い）
    let timer = 0;
    let backstop = 0;
    let startPt: { x: number; y: number } | null = null;
    let startLngLat: mapboxgl.LngLat | null = null;
    let candMarker: mapboxgl.Marker | null = null;
    let candPopup: mapboxgl.Popup | null = null;
    let candAddrTimer = 0; // 逆ジオの応答待ちタイムアウト

    const clearTimer = () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
    };
    const removeCandidate = () => {
      if (candAddrTimer) {
        window.clearTimeout(candAddrTimer);
        candAddrTimer = 0;
      }
      candPopup?.remove();
      candPopup = null;
      candMarker?.remove();
      candMarker = null;
    };

    const showCandidate = (lat: number, lng: number) => {
      removeCandidate();
      const pinEl = document.createElement("div");
      pinEl.className = "cand-pin";
      pinEl.textContent = "📍";
      candMarker = new mapboxgl.Marker({ element: pinEl, anchor: "bottom" })
        .setLngLat([lng, lat])
        .addTo(map);

      const el = document.createElement("div");
      el.className = "popup popup--cand";
      el.innerHTML = `
        <div class="name">この地点を目的地に</div>
        <div class="cand-addr">住所を取得中…</div>
        <div class="popup__actions">
          <button class="act act--route" type="button">🧭 ここへ案内</button>
          <button class="act act--cancel" type="button">取消</button>
        </div>`;
      const addrEl = el.querySelector(".cand-addr") as HTMLElement | null;
      const goBtn = el.querySelector(".act--route") as HTMLButtonElement | null;
      const cancelBtn = el.querySelector(".act--cancel") as HTMLButtonElement | null;
      let destName = "地図で選択した地点";
      let addrResolved = false;
      // 逆ジオが遅い/落ちた時に「住所を取得中…」のままハングさせない（7秒で打ち切り）。
      // destName はフォールバックの「地図で選択した地点」のままなので「ここへ案内」は使える。
      candAddrTimer = window.setTimeout(() => {
        candAddrTimer = 0;
        if (!addrResolved && addrEl) addrEl.textContent = "（住所不明）";
      }, 7000);
      reverseAddressNoBanchi(lat, lng).then((a) => {
        addrResolved = true;
        if (candAddrTimer) {
          window.clearTimeout(candAddrTimer);
          candAddrTimer = 0;
        }
        if (a) {
          destName = a;
          if (addrEl) addrEl.textContent = a;
        } else if (addrEl) {
          addrEl.textContent = "（住所不明）";
        }
      });
      if (goBtn)
        goBtn.onclick = () => {
          propsRef.current.onSetDest({ lat, lng, name: destName });
          removeCandidate();
        };
      if (cancelBtn) cancelBtn.onclick = () => removeCandidate();
      // closeOnClick:false ＝ 地図タップでは消えない（Google/Apple Maps 流に「ここへ案内 / 取消 / ✕」で明示的に閉じる）。
      candPopup = new mapboxgl.Popup({ offset: 28, maxWidth: "260px", closeOnClick: false })
        .setLngLat([lng, lat])
        .setDOMContent(el)
        .addTo(map);
      // ✕ や 取消 でポップアップを閉じたら仮ピンも消す
      candPopup.on("close", () => {
        candMarker?.remove();
        candMarker = null;
      });
    };

    const fire = () => {
      timer = 0;
      if (!startLngLat) return;
      const { lat, lng } = startLngLat;
      // 指離しで飛んでくる click を標高プローブに拾わせない
      suppressClickRef.current = true;
      window.clearTimeout(backstop);
      backstop = window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 1500);
      showCandidate(lat, lng);
    };

    const onDown = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) => {
      const oe = e.originalEvent as TouchEvent | MouseEvent;
      // マルチタッチ（ピンチズーム/回転）は対象外
      if (oe && "touches" in oe && oe.touches && oe.touches.length > 1) {
        clearTimer();
        return;
      }
      startPt = { x: e.point.x, y: e.point.y };
      startLngLat = e.lngLat;
      clearTimer();
      timer = window.setTimeout(fire, HOLD_MS);
    };
    const onMove = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) => {
      if (!timer || !startPt) return;
      if (
        Math.abs(e.point.x - startPt.x) > MOVE_TOL ||
        Math.abs(e.point.y - startPt.y) > MOVE_TOL
      )
        clearTimer();
    };

    map.on("mousedown", onDown);
    map.on("touchstart", onDown);
    map.on("mousemove", onMove);
    map.on("touchmove", onMove);
    map.on("mouseup", clearTimer);
    map.on("touchend", clearTimer);
    map.on("touchcancel", clearTimer);
    map.on("dragstart", clearTimer);
    map.on("zoomstart", clearTimer);
    map.on("rotatestart", clearTimer);
    map.on("pitchstart", clearTimer);

    return () => {
      clearTimer();
      window.clearTimeout(backstop);
      removeCandidate();
      map.off("mousedown", onDown);
      map.off("touchstart", onDown);
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", clearTimer);
      map.off("touchend", clearTimer);
      map.off("touchcancel", clearTimer);
      map.off("dragstart", clearTimer);
      map.off("zoomstart", clearTimer);
      map.off("rotatestart", clearTimer);
      map.off("pitchstart", clearTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // 検索候補の目的地プレビュー: candidate が設定されたら、地図にピン＋カメラ移動＋確認ポップアップを出す。
  // ここで即ルート化せず、「🧭 ここへ案内」を押して初めて onSetDest（＝ルート化）。取消/✕はプレビューだけ消す。
  useEffect(() => {
    const map = mapRef.current;
    const cand = props.candidate;
    if (!map || !mapReady || !cand) return;
    // カメラを候補「目的地そのもの」へ寄せて「まず地図に出す」（現在地と両方を収めるのではなく目的地中心）。
    // bearing:0＝ノースアップ固定で表示（ヘディングアップで地図が回転していると土地の方向感が掴みにくいため）。
    // 走行モード中でもプレビューできるよう、カメラ追従だけ一時停止（走行モード自体は維持＝HUD/「現在地」ボタンは残る）。
    // 非走行モードでは followApiRef は null＝no-op（追従ループが無いので flyTo はそのまま効く）。復帰は「現在地」ボタン。
    followApiRef.current?.suspend();
    map.flyTo({ center: [cand.lng, cand.lat], zoom: 15, bearing: 0, duration: 800 });
    const pinEl = document.createElement("div");
    pinEl.className = "cand-pin";
    pinEl.textContent = "📍";
    const marker = new mapboxgl.Marker({ element: pinEl, anchor: "bottom" })
      .setLngLat([cand.lng, cand.lat])
      .addTo(map);
    const el = document.createElement("div");
    el.className = "popup popup--cand";
    el.innerHTML =
      '<div class="name"></div><div class="cand-addr"></div>' +
      '<div class="popup__actions"><button class="act act--route" type="button">🧭 ここへ案内</button>' +
      '<button class="act act--cancel" type="button">取消</button></div>';
    (el.querySelector(".name") as HTMLElement).textContent = cand.name;
    const addrEl = el.querySelector(".cand-addr") as HTMLElement;
    if (cand.subtitle) addrEl.textContent = cand.subtitle;
    else addrEl.style.display = "none";
    let closed = false;
    let cleaningUp = false; // アンマウント/再実行の cleanup で popup.remove() が発火する "close" を取消扱いにしないためのフラグ
    const close = () => {
      if (closed) return;
      closed = true;
      propsRef.current.onCandidateClose?.();
    };
    (el.querySelector(".act--route") as HTMLButtonElement).onclick = () => {
      propsRef.current.onSetDest({ lat: cand.lat, lng: cand.lng, name: cand.name }); // ここで初めてルート化
      close();
    };
    (el.querySelector(".act--cancel") as HTMLButtonElement).onclick = () => close();
    const popup = new mapboxgl.Popup({ offset: 28, maxWidth: "260px", closeOnClick: false })
      .setLngLat([cand.lng, cand.lat])
      .setDOMContent(el)
      .addTo(map);
    // ✕（ユーザー操作）で閉じたら取消扱い。ただし cleanup 由来の popup.remove() は無視（自己クリア防止）。
    popup.on("close", () => {
      if (!cleaningUp) close();
    });
    return () => {
      cleaningUp = true;
      marker.remove();
      popup.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, props.candidate]);

  // 目的地カードの「🧭 地図で見る」: recenterDest が増えたら目的地（＋現在地）へカメラを寄せる。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.recenterDest || !props.dest) return;
    fitCameraToDest(map, { lat: props.dest.lat, lng: props.dest.lng }, propsRef.current.userPos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.recenterDest]);

  // 地図長押しの初回ヒント（一度だけ）。「長押しで目的地」を周知し、OK か12秒で消える。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      if (localStorage.getItem("crm_lphint_done")) return;
    } catch {
      return;
    }
    const hint = document.createElement("div");
    hint.className = "lp-hint";
    hint.innerHTML =
      '<span class="lp-hint__t">💡 地図を長押しすると、その場所を目的地にできます</span>' +
      '<button type="button" class="lp-hint__ok">OK</button>';
    map.getContainer().appendChild(hint);
    let timer = 0;
    const dismiss = () => {
      try {
        localStorage.setItem("crm_lphint_done", "1");
      } catch {
        /* noop */
      }
      window.clearTimeout(timer);
      hint.remove();
    };
    const okBtn = hint.querySelector(".lp-hint__ok") as HTMLButtonElement | null;
    if (okBtn) okBtn.onclick = dismiss;
    timer = window.setTimeout(dismiss, 12000);
    return () => {
      window.clearTimeout(timer);
      hint.remove();
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
      paintTrafficTime(); // innerHTML差替で消えた渋滞時刻ラベルを再描画
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, wxPosKey]);

  // 天気・渋滞の更新時刻を停車中でも随時更新するための定期自動更新。
  // 渋滞: Mapboxは期限切れタイルを自動再取得(refreshExpiredTiles)するが、時刻を確実に進めるため
  //       5分ごとに source.reload()（渋滞ON時のみ）。sourcedataハンドラが取得時刻を更新する。
  // 天気: 移動が無いと再取得が起きないため、20分ごとに force 再取得してバーを再描画。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const trafficTimer = window.setInterval(() => {
      if (!propsRef.current.traffic) return;
      try {
        (map.getSource("traffic") as { reload?: () => void } | undefined)?.reload?.();
      } catch {
        /* 無視 */
      }
    }, 5 * 60 * 1000);
    const wxTimer = window.setInterval(() => {
      const loc = propsRef.current.userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };
      fetchWeather(loc.lat, loc.lng, true).then((wx) => {
        if (!weatherBoxRef.current || !wx) return;
        weatherBoxRef.current.innerHTML = weatherBarHTML(wx);
        paintTrafficTime();
      });
    }, 20 * 60 * 1000);
    return () => {
      window.clearInterval(trafficTimer);
      window.clearInterval(wxTimer);
    };
  }, [mapReady]);

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
            "icon-size": 0.65, // 走行軌跡の矢印を少し小さく（要望・従来1.0→0.85→0.75→0.65）
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

    // 新しい目的地が画面外なら見えるようにカメラを寄せる（走行追従中は動かさない）。
    // 店舗ルートは focus 効果が、地図長押しは押した地点が、既に画面内なので実質ノーオペ。
    // 主に住所検索・最近の目的地で遠方を設定したときに効く。
    if (!propsRef.current.follow) {
      const b = map.getBounds();
      if (b && !b.contains([to.lng, to.lat])) {
        fitCameraToDest(map, to, propsRef.current.userPos);
      }
    }

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
      // ケーシング(白い縁取り): ルート線の下に少し太い白線を敷き、夜の濃紺地図でも輪郭が立つように。
      // 色は変えず(青#0b57d0のまま)。先に追加＝route-lineより下。走行済みトリムは route-line と同期(applyTrim)。
      map.addLayer(
        {
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          // line-emissive-strength:1 ＝ Standardのナイトライティングで暗転させず本来の色で発光表示（夜に黒くならない）
          paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9, "line-emissive-strength": 1, "line-trim-offset": [0, 0] },
        },
        before
      );
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          // line-emissive-strength:1 ＝ Standardのナイトライティングで暗転させず本来の青で表示（夜に黒くならない）。
          // line-trim-offset で走行済み区間[0,frac]をGPU側で透明化（線を再スライスせず高頻度に更新可）
          paint: { "line-color": "#0b57d0", "line-width": 7, "line-opacity": 0.95, "line-emissive-strength": 1, "line-trim-offset": [0, 0] },
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
    let trimLastFrame = 0;
    const TRIM_DUR = 1100; // follow カメラと同じ補間時間
    const applyTrim = (f: number) => {
      const v: [number, number] = [0, Math.max(0, Math.min(1, f))];
      if (map.getLayer("route-line")) map.setPaintProperty("route-line", "line-trim-offset", v);
      // ケーシングも同期トリム（走行済み区間の白縁が残らないように）
      if (map.getLayer("route-casing")) map.setPaintProperty("route-casing", "line-trim-offset", v);
    };
    const tickTrim = () => {
      const now = performance.now();
      if (now - trimLastFrame < 33) {
        trimRaf = requestAnimationFrame(tickTrim); // 約30fpsに間引き（追従カメラと統一・省電力）
        return;
      }
      trimLastFrame = now;
      const t = Math.min(1, (now - trimStart) / TRIM_DUR);
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

    // 高速・有料道路を含む経路の案内バッジ（含む時だけ表示。区間はルート線を緑で色分け）
    const hwNotice = document.createElement("div");
    hwNotice.className = "route-hwnote";
    hwNotice.textContent = "🛣 高速・有料道路を含む";
    hwNotice.style.display = "none";
    map.getContainer().appendChild(hwNotice);

    // 分岐/方面/レーンの案内標識カード（画面上部中央・この先の分岐が近い時だけ表示。Mapbox banner由来）
    const signCard = document.createElement("div");
    signCard.className = "nav-sign";
    signCard.style.display = "none";
    map.getContainer().appendChild(signCard);

    // ルート選択（高速あり / 一般道のみ）。高速を使う経路の時だけ表示し所要時間で選べる。
    const altPanel = document.createElement("div");
    altPanel.className = "route-alt";
    altPanel.style.display = "none";
    altPanel.innerHTML =
      '<button class="route-alt__opt" data-opt="fast" type="button"></button>' +
      '<button class="route-alt__opt" data-opt="local" type="button"></button>';
    map.getContainer().appendChild(altPanel);
    const altFastBtn = altPanel.querySelector('[data-opt="fast"]') as HTMLButtonElement;
    const altLocalBtn = altPanel.querySelector('[data-opt="local"]') as HTMLButtonElement;

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
    let congestion: (number | null)[] = []; // セグメント毎の渋滞度(Mapbox congestion_numeric)。ルート線の渋滞色分け用
    let maneuvers: RouteManeuver[] = []; // 分岐/方面/レーンの案内標識列(Mapbox banner由来)。案内カード用
    let curRouteCoords: [number, number][] | null = null; // 現在有効なルートの座標列（非同期再判定の鮮度ガード）
    const isHwSeg = (segIdx: number) => hwRanges.some(([a, b]) => segIdx >= a && segIdx < b);

    // 経路の高速/有料区間: ORS waycategory があればそれ、無ければ(Mapbox等)同梱の高速形状で経路座標を判定。
    let routeHwGeom: HighwayGeom | null = null;
    loadHighwayGeom().then((g) => { routeHwGeom = g; }).catch(() => {});
    const geomHwRanges = (coords: [number, number][]): [number, number][] => {
      const g = routeHwGeom;
      if (!g) return [];
      const HW_M = 45; // 経路座標がこの距離以内に高速センターラインがあれば高速の候補
      const ALIGN_COS = 0.82; // 進行方向と高速セグメント方向が約35°以内で「沿って走行」＝高速。直交(跨ぎ)は除外
      const GAP_M = 200; // 連続高速の一時的な非整合(簡略化された形状の折れ点等)はこの距離まで橋渡しして繋ぐ
      const MIN_HW_M = 120; // これ未満の高速区間は跨ぎ/掠りとみなし無視（誤検出の安全網）
      // ① 近接 かつ 方向整合（平行/反平行）な頂点だけを高速候補にフラグ。
      //    高速を「跨ぐだけ」の交差点では進行方向が高速とほぼ直交するので除外される。
      const flags: boolean[] = new Array(coords.length).fill(false);
      for (let i = 0; i < coords.length; i++) {
        const snap = nearestHighway(g, coords[i][0], coords[i][1]);
        if (!snap || snap.distM >= HW_M) continue;
        const a = coords[Math.max(0, i - 1)];
        const b = coords[Math.min(coords.length - 1, i + 1)];
        const mLat = 110540;
        const mLng = 111320 * Math.cos((coords[i][0] * Math.PI) / 180);
        const rE = (b[1] - a[1]) * mLng; // 進行方向 東成分
        const rN = (b[0] - a[0]) * mLat; // 進行方向 北成分
        const rMag = Math.hypot(rE, rN);
        const sMag = Math.hypot(snap.segE, snap.segN);
        // 方向が取れない(停止点/端点/データ欠損)時は距離のみで従来どおり採用（安全側）
        const aligned =
          rMag < 1 || sMag < 1
            ? true
            : Math.abs(rE * snap.segE + rN * snap.segN) / (rMag * sMag) >= ALIGN_COS;
        flags[i] = aligned;
      }
      // 経路上の index 区間 [a,b) の道なり距離(m)
      const pathM = (a: number, b: number) => {
        let m = 0;
        for (let k = a; k < b; k++)
          m += haversineKm({ lat: coords[k][0], lng: coords[k][1] }, { lat: coords[k + 1][0], lng: coords[k + 1][1] }) * 1000;
        return m;
      };
      // ② 連続フラグを生の範囲に。
      const raw: [number, number][] = [];
      let start = -1;
      for (let i = 0; i < coords.length; i++) {
        if (flags[i] && start < 0) start = i;
        else if (!flags[i] && start >= 0) { raw.push([start, i]); start = -1; }
      }
      if (start >= 0) raw.push([start, coords.length - 1]);
      // ③ 近接ギャップ(<GAP_M)を橋渡し（連続高速の一時的な非整合を吸収）。ただし橋渡しで埋める中間頂点が
      //    高速近傍(BRIDGE_M以内)に留まる場合のみ繋ぐ。高速に近接並走する一般道(側道・県道)と、その先の
      //    IC付近との間に高速から離れる区間があると、従来は道なり距離だけで橋渡しして離れた一般道まで
      //    高速判定に巻き込んでいた（実走FB: E51本線から最大240m離れた並走一般道が高速扱い）。中間頂点が
      //    離れる(>BRIDGE_M)ギャップは繋がず分断する。本線走行は全頂点が近接するので橋渡しが維持される。
      const BRIDGE_M = HW_M * 2; // 90m。本線の簡略化形状に伴う一時的な離れは許容、別道(>90m)は分断
      const bridgeable = (from: number, to: number): boolean => {
        for (let k = from + 1; k < to; k++) {
          const sn = nearestHighway(g, coords[k][0], coords[k][1]);
          if (!sn || sn.distM >= BRIDGE_M) return false;
        }
        return true;
      };
      const merged: [number, number][] = [];
      for (const r of raw) {
        const last = merged[merged.length - 1];
        if (last && pathM(last[1], r[0]) < GAP_M && bridgeable(last[1], r[0])) last[1] = r[1];
        else merged.push([r[0], r[1]]);
      }
      // ④ 区間の先頭/末尾を「確実に高速上（センターライン<15m）」の頂点まで刈り込む。
      //    ICの取り付け部では一般道が高速に45m以内・方向一致で並走しやすく、その頂点が範囲の頭/尻に
      //    連なると高速判定がICのかなり手前から始まって見える（実走FB。8ルート実測で最大898m先行）。
      //    ランプ上はセンターライン0〜6mなので「ランプ起点=IC入口からの判定」は保たれ、並走一般道の
      //    頭出し/尻残りだけが落ちる。中央は触らない（高架下に側道が並走する区間を巻き添えにしない）。
      const TRIM_SOLID_M = 15;
      const solid = (k: number) => {
        const sn = nearestHighway(g, coords[k][0], coords[k][1]);
        return !!sn && sn.distM < TRIM_SOLID_M;
      };
      const trimmed: [number, number][] = [];
      for (const [a0, b0] of merged) {
        let a = a0, b = b0;
        while (a < b && !solid(a)) a++;
        while (b > a && !solid(b - 1)) b--;
        if (a < b) trimmed.push([a, b]);
      }
      // ⑤ 短区間（跨ぎ/掠り）を距離で足切り。
      return trimmed.filter(([a, b]) => pathM(a, b) >= MIN_HW_M);
    };
    // ルート線を渋滞度(congestion_numeric)で色分け＝緑(空)/黄(やや混)/橙(混)/赤(激混)・不明は青。
    // 高速/有料の有無はここでは扱わず「🛣含む」バッジ(hwNotice)で別途示す(色の意味を渋滞1つに統一)。
    // 走行済みトリム(line-trim-offset)と両立させるため単一線の line-gradient(step) で塗る。rSuffix=各点→終点の残距離。
    const applyRouteColor = () => {
      if (!map.getLayer("route-line")) return;
      // 「🛣 高速・有料道路を含む」バッジは高速区間の有無で(色分けとは独立。selectorが別途上書き制御)。
      hwNotice.style.display = hwRanges.length ? "" : "none";
      const total = rSuffix[0] || 0;
      const segCount = rSuffix.length - 1;
      const hasCong = congestion.length >= 1;
      // 渋滞データも高速区間も無ければ青単色(line-color)へ戻す。
      if (segCount < 1 || total <= 0 || (!hasCong && hwRanges.length === 0)) {
        map.setPaintProperty("route-line", "line-gradient", undefined);
        return;
      }
      const BLUE = "#0b57d0", GREEN = "#1aa64b", AMBER = "#f5b800", ORANGE = "#e8590c", RED = "#e03131";
      // 混雑(>=40)は警告色を優先(黄→橙→赤)。空き(<40)・不明(null)は道路種別の色＝高速緑/一般道青(日本の標識準拠)。
      const cong = (i: number): number | null => (hasCong && i < congestion.length ? congestion[i] : null);
      const band = (v: number | null, hw: boolean) =>
        v != null && v >= 40 ? (v < 60 ? AMBER : v < 80 ? ORANGE : RED) : hw ? GREEN : BLUE;
      const frac = (i: number) => {
        const ii = Math.max(0, Math.min(rSuffix.length - 1, i));
        return Math.max(0, Math.min(1, (total - rSuffix[ii]) / total));
      };
      // セグメントi(coords[i]→[i+1])の色=band(congestion[i])。同色連続をまとめ step式に(stopは厳密増加必須)。
      const expr: unknown[] = ["step", ["line-progress"], band(cong(0), isHwSeg(0))];
      let prevColor = band(cong(0), isHwSeg(0));
      let prevStop = 0;
      for (let i = 1; i < segCount; i++) {
        const c = band(cong(i), isHwSeg(i));
        if (c !== prevColor) {
          const stop = Math.max(frac(i), prevStop + 1e-4);
          if (stop < 0.9999) { expr.push(stop, c); prevStop = stop; prevColor = c; }
        }
      }
      map.setPaintProperty("route-line", "line-gradient", expr as never);
    };
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
    const HW_LOOK = 6; // 表示する前方施設数の上限。実際の表示数は高さ(現在地ボタン〜画面天井)に収まる分だけ＝render側で自動間引き（低い行=方面/設備なしICが並ぶ区間では6件、背高行が混じれば5件以下）
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
    // 方面行(矢印+地名)。IC/JCTのtoward(highway.jsonの静的データ・絶対方位)を自車の進行方位(heading)
    // との相対角度に変換して矢印を描く。ルート案内中はheadingに現在の道なり方位(segBearing)を使う。
    const towardRowHtml = (f: HwFacility, heading: number): string => {
      if ((f.kind !== "ic" && f.kind !== "jct") || !f.toward?.length) return "";
      const exitBadge = f.exit ? `<span class="hw-exit">${escHtml(f.exit)}</span>` : "";
      const items = f.toward
        .slice(0, 3)
        .map((t) => {
          const deg = bearingToArrowAngle(t.bearing, heading);
          return `<span class="hw-dir" style="transform:rotate(${deg}deg)">⬆</span>${escHtml(t.name)}`;
        })
        .join("");
      return `<div class="hw-toward">${exitBadge}${items}</div>`;
    };
    const updateHwStrip = (carDistKm: number, heading: number) => {
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
            `<span class="hw-name">${escHtml(rf.f.name)}</span></div>${amenRow}${towardRowHtml(rf.f, heading)}` +
            `<div class="hw-dist">${dist}<small>km</small> ・ ${remMin}<small>分</small></div></div>`
          );
        })
        .join("");
      // 設備アイコン付き(背の高い)施設が並ぶと縦に溢れて上端で見切れるため、入り切らない遠い施設から落とす（最寄り優先を維持）
      while (hwStrip.children.length > 1 && hwStrip.scrollHeight > hwStrip.clientHeight + 1) {
        hwStrip.removeChild(hwStrip.lastElementChild!);
      }
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

    // 分岐の向き(modifier)→矢印の回転角(度・0=直進/正=右)。
    const modAngle = (m?: string): number =>
      (({ straight: 0, "slight right": 45, right: 90, "sharp right": 135, uturn: 180, "sharp left": -135, left: -90, "slight left": -45 } as Record<string, number>)[m || "straight"]) ?? 0;
    const arrowSpan = (deg: number, cls: string) =>
      `<span class="nav-arrow ${cls}" style="transform:rotate(${deg}deg)">⬆</span>`;
    const SIGN_SHOW_KM_HW = 3; // 高速の分岐標識はこの距離以内だけ表示（約2km手前から見える想定）
    const SIGN_SHOW_KM_ROAD = 0.7; // 一般道は交差点間隔が短いため700m手前から表示
    const SKIP_MAN = new Set(["continue", "new name", "notification", "depart"]); // 全道路共通の案内不要種別
    const SKIP_MAN_ROAD_ONLY = new Set(["merge"]); // 一般道限定の追加除外（高速のランプ合流=isHwは除外しない）
    const DIR_TEXT: Record<string, string> = {
      straight: "直進", "slight right": "やや右方向", right: "右方向", "sharp right": "右方向",
      uturn: "Uターン", "sharp left": "左方向", left: "左方向", "slight left": "やや左方向",
    };
    // atKm(経路始点からの累積km)に最も近い頂点のセグメントindexを求める（rSuffixは終点までの残距離km・降順）。
    const segIdxAtKm = (atKm: number): number => {
      for (let i = 0; i < rSuffix.length; i++) if (rKm - rSuffix[i] >= atKm) return i;
      return Math.max(0, rSuffix.length - 1);
    };
    // 分岐が高速上のものか判定（type/出口番号を優先、判定材料が無ければ一般道扱い=安全側）。
    const isHwManeuver = (m: RouteManeuver): boolean => {
      if (m.type === "off ramp" || m.type === "on ramp") return true;
      if (m.exit) return true;
      if (hwRanges.length) return isHwSeg(segIdxAtKm(m.atKm));
      return false;
    };
    // 位置から都道府県道の種別語を返す（Mapboxのstep.refは番号のみで種別が無いため補う）。
    // 北海道=道道 / 東京=都道 / 京都・大阪=府道 / その他=県道。境界際は generic な県道に寄せる。
    const prefRoadWord = (lat: number, lng: number): string => {
      if (lat >= 41.4) return "道道"; // 北海道（本州と海で隔絶＝安全）
      if (lat >= 35.5 && lat <= 35.83 && lng >= 138.95 && lng <= 139.9) return "都道"; // 東京都（区部＋多摩の内側）
      if (lat >= 34.3 && lat <= 35.78 && lng >= 135.0 && lng <= 135.83) return "府道"; // 京都・大阪（内側）
      return "県道";
    };
    // 路線番号refを種別付きラベルへ。step.refは番号のみ("65"/"7; 64")だが step.name に種別が入る
    // （国道="国道121号; 一般国道121号"／県道は"会津若松裏磐梯線"等の固有名）。nameに「◯◯号」の正式路線名が
    // あれば最優先、無ければ nameの国道有無＋位置から都道府県道の語を付ける。裸の「65」を「県道65号」に。
    const refRoadLabel = (m: RouteManeuver): string => {
      const name = m.name || "";
      const exact = name.match(/(国道|県道|都道|府道|道道)\s*(\d+)\s*号/);
      if (exact) return `${exact[1]}${exact[2]}号`;
      const num = (m.ref || "").split(/[;,]/)[0].trim();
      if (!num) return name; // 番号が無ければ固有名（あれば）をそのまま
      if (!/^\d/.test(num)) return name || m.ref || ""; // E49等の高速refは番号化しない
      if (/国道/.test(name)) return `国道${num}号`;
      return `${prefRoadWord(m.lat, m.lng)}${num}号`;
    };
    // 方面テキストの解決: 方面名→路線(種別付き番号/道路名)→指示文から地名抽出→方向語、の優先順位。
    const resolveTowardText = (next: RouteManeuver): string => {
      if (next.toward) return next.toward.split(";").slice(0, 3).join("・");
      const roadLabel = refRoadLabel(next);
      if (roadLabel) return roadLabel;
      if (next.name) return next.name;
      // 「◯◯を右方向です。」のような指示文から「を」の直前(地名/道路名)を抽出。方向語のみの文（例:「左方向です。」）はここで空になり方向語フォールバックへ。
      const afterLead = (next.instruction || "").replace(/^[^、]*、/, "");
      const placeMatch = afterLead.match(/^(.+?)を/);
      if (placeMatch && placeMatch[1]) return placeMatch[1];
      return DIR_TEXT[next.modifier || "straight"] || "";
    };
    // 案内標識カード更新: 前方の直近の意味ある分岐(方面/出口/レーン/距離)を表示。無ければ隠す。
    const updateSignCard = (carDistKm: number) => {
      if (!maneuvers.length) { signCard.style.display = "none"; return; }
      const next = maneuvers.find((m) => {
        if (SKIP_MAN.has(m.type) || m.atKm <= carDistKm + 0.02) return false;
        if (!isHwManeuver(m)) {
          if (SKIP_MAN_ROAD_ONLY.has(m.type)) return false;
          if (m.type === "turn" && m.modifier === "straight") return false;
        }
        return true;
      });
      if (!next) { signCard.style.display = "none"; return; }
      const isHw = isHwManeuver(next);
      const distM = Math.max(0, (next.atKm - carDistKm) * 1000);
      const showKm = isHw ? SIGN_SHOW_KM_HW : SIGN_SHOW_KM_ROAD;
      if (distM > showKm * 1000) { signCard.style.display = "none"; return; }
      const distTxt = distM >= 1000 ? (distM / 1000).toFixed(1) + "km" : Math.round(distM / 10) * 10 + "m";
      const toward = resolveTowardText(next) || "この先分岐";
      const exitBadge = next.exit ? `<span class="nav-exit">出口 ${escHtml(next.exit)}</span>` : "";
      const laneRow =
        next.lanes && next.lanes.length
          ? `<div class="nav-lanes-label">${escHtml(toward)}</div><div class="nav-lanes">${next.lanes
              .map((l) => arrowSpan(modAngle(l.activeDir || l.dirs[0]), l.active ? "lane-on" : "lane-off"))
              .join("")}</div>`
          : "";
      signCard.classList.toggle("nav-sign--road", !isHw);
      signCard.style.display = "";
      signCard.innerHTML =
        `<div class="nav-top">${arrowSpan(modAngle(next.modifier), "nav-dir")}` +
        `<div class="nav-info"><div class="nav-toward">${exitBadge}${escHtml(toward)}</div>` +
        `<div class="nav-dist">${distTxt}</div></div></div>${laneRow}`;
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
      updateHwStrip(rKm - pr.remKm, segBearing);
      updateSignCard(rKm - pr.remKm); // 前方の分岐/方面/レーン案内カードを更新
      updateAheadGrade(rKm - pr.remKm); // この先の急勾配を先読みして aheadGradeRef に反映
      return pr;
    };

    // ===== ルート選択（高速あり fast / 一般道のみ local）＝所要時間で選べる =====
    let avoidHw = false; // 現在の選択。既定は高速あり(速い方)
    let fastRoute: RouteResult | null = null; // 高速あり案
    let localRoute: RouteResult | null = null; // 一般道のみ案
    let fastHasHw = false; // 高速あり案が実際に高速/有料を使うか（使う時だけ選択UIを出す）

    // 高速あり/一般道の選択UIの表示更新（＋高速案内バッジ hwNotice の排他制御）。
    const updateSelector = () => {
      // 高速を使う経路で一般道の代替が取れている時は「常に」選択UIを表示（走行中も。要望）。
      // follow(走行モード)には依存させない＝同一店舗なら状態に関わらず一貫して選択UIが出る。
      const showSel = fastHasHw && !!fastRoute && !!localRoute;
      // 選択UI(route-alt)は目的地名(dest-box)と同じ左上位置に重なるため、出す時だけコンテナに印を付け
      // CSS側で dest-box を選択UIの下へ退避させる（別effectのdest-boxとはこのクラス経由で協調）。
      map.getContainer().classList.toggle("crm-has-route-alt", showSel);
      if (showSel) {
        altFastBtn.innerHTML =
          `<span class="route-alt__lb">🛣 高速あり</span><span class="route-alt__t">${fastRoute!.min}<small>分</small>・${Math.round(fastRoute!.km)}<small>km</small></span>`;
        altLocalBtn.innerHTML =
          `<span class="route-alt__lb">🚗 一般道のみ</span><span class="route-alt__t">${localRoute!.min}<small>分</small>・${Math.round(localRoute!.km)}<small>km</small></span>`;
        altFastBtn.classList.toggle("is-active", !avoidHw);
        altLocalBtn.classList.toggle("is-active", avoidHw);
        altPanel.style.display = "";
        hwNotice.style.display = "none"; // 選択UIが高速利用を表すのでバッジは隠す
      } else {
        altPanel.style.display = "none";
        hwNotice.style.display = hwRanges.length ? "" : "none";
      }
    };

    // 1本のRouteResultを地図・ETA・トリム・色分け・施設に反映（doFit時はルート全体へ引き）。
    const applyRoute = (r: RouteResult, here: Pt | null, doFit: boolean) => {
      setLine(r.coords);
      resetTrim(); // 新ルートは全線を描き直しトリムを0へ
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
      // 高速/有料区間: ORS waycategory優先。無ければ同梱高速形状で判定。ただし一般道のみ案(avoidHw)は
      // 構造上高速を使わないので緑判定しない（下道が高架高速の真下を通る=357型の誤検出を避ける）。
      hwRanges = r.hwRanges ?? (avoidHw ? [] : geomHwRanges(r.coords));
      curRouteCoords = r.coords; // 非同期の再判定(形状ロード/地方ブロック到着)が古いルートを上書きしないための鮮度ガード
      congestion = r.congestion ?? []; // 渋滞色分け用(Mapbox取得時のみ・無ければ青単色)
      maneuvers = r.maneuvers ?? []; // 分岐/方面/レーンの案内標識列(Mapbox取得時のみ)
      applyRouteColor(); // ルート線を渋滞度＋道路種別（高速緑/一般道青）で色分け
      // Mapboxルートは高速判定を同梱形状(geomHwRanges/routeHwGeom)に頼るが、その形状は非同期ロード。
      // 初回は1.77MBのfetch＋パースがルート取得に間に合わず hwRanges=[] のまま applyRouteColor が1回きり
      // 走り、高速緑が出ないことがある（バッジ/ストリップは走行中に再計算されるので効く＝非対称の実走FB）。
      // routeHwGeom 未ロードでルートを引いた場合は、ロード完了後に高速区間を再判定して塗り直す。
      if (!r.hwRanges && !avoidHw && !routeHwGeom) {
        loadHighwayGeom()
          .then((gg) => {
            if (!gg || !map.getLayer("route-line") || curRouteCoords !== r.coords) return;
            routeHwGeom = gg;
            hwRanges = geomHwRanges(r.coords);
            applyRouteColor();
            computeRouteFacilities();
          })
          .catch(() => {});
      }
      // 全国化: ルートが関東(同梱データ範囲)の外へ跨ぐ場合、該当する地方ブロックをオンデマンド取得し、
      // 届いたら高速区間を再判定して塗り直す（未着の間はその区間の高速判定が出ないため後追いで補完）。
      if (!r.hwRanges && !avoidHw) {
        const need = regionsForCoords(r.coords);
        if (need.length) {
          void ensureRegions(need).then((changed) => {
            if (!changed || !map.getLayer("route-line") || curRouteCoords !== r.coords) return;
            hwRanges = geomHwRanges(r.coords);
            applyRouteColor();
            computeRouteFacilities();
          });
        }
      }
      gradeMarks = buildMarks(r.coords, GRADE_SPACING_KM);
      eleAtMark = [];
      computeRouteFacilities();
      // ルート設定時は「引き」で現在地〜目的地(ルート全体)を北上表示。走行モードでも同じ挙動にする（要望）＝
      // 走行モードを抜けずにカメラ追従だけ一時停止して全体を見せ、「現在地」ボタンで自車追従へ復帰。
      // doFit は初回ルートのみ true（再ルート＝走行中の逸脱時は全体表示せず追従を維持）。
      if (doFit && r.coords.length >= 2) {
        followApiRef.current?.suspend(); // 非走行モードでは null＝no-op
        let s = 90, w = 180, n = -90, e = -180;
        for (const [la, ln] of r.coords) {
          if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln;
        }
        map.fitBounds([[w, s], [e, n]], {
          padding: { top: 80, bottom: 90, left: 80, right: 80 },
          maxZoom: 15,
          bearing: 0,
          duration: 800,
        });
      }
      if (here) refresh(here);
      updateSelector();
    };

    // 選択ボタン: タップで avoidHw を切替え、取得済みルートを即適用（全体へ引き直す）。
    altFastBtn.onclick = () => {
      if (avoidHw && fastRoute) { avoidHw = false; applyRoute(fastRoute, lastHereHw, true); }
    };
    altLocalBtn.onclick = () => {
      if (!avoidHw && localRoute) { avoidHw = true; applyRoute(localRoute, lastHereHw, true); }
    };

    // fetchRoute を最大 tries 回リトライ（APIの一時失敗で片方の案が欠けると選択UIが黙って出ない対策）。
    const fetchRouteRetry = (from: Pt, avoid: boolean, tries = 3): Promise<RouteResult | null> =>
      fetchRoute(from, to, lastHeading, avoid).then((r) => {
        if (r || aborted || tries <= 1) return r;
        return new Promise<null>((res) => setTimeout(() => res(null), 900)).then(() => fetchRouteRetry(from, avoid, tries - 1));
      });

    // 初回に「高速あり」「一般道のみ」の両案を確保し、高速あり案が高速を使う時だけ選択UIを出す。
    const fetchAlternatives = (from: Pt) => {
      const jobs: Promise<void>[] = [];
      if (!fastRoute) jobs.push(fetchRouteRetry(from, false).then((r) => { if (r) fastRoute = r; }));
      if (!localRoute) jobs.push(fetchRouteRetry(from, true).then((r) => { if (r) localRoute = r; }));
      Promise.all(jobs).then(() => {
        if (aborted) return;
        fastHasHw = !!fastRoute && (fastRoute.hwRanges ?? geomHwRanges(fastRoute.coords)).length > 0;
        // 一般道案が高速案とほぼ同じ(=下道が無い/同一)なら選択の意味が薄いので出さない
        if (fastRoute && localRoute && Math.abs(fastRoute.km - localRoute.km) < 0.3 && Math.abs(fastRoute.min - localRoute.min) < 1) fastHasHw = false;
        updateSelector();
      });
    };

    const route = (from: Pt) => {
      lastRouteAt = Date.now();
      const isFirst = !rCoords;
      if (isFirst) box.textContent = "🛣 経路を計算中…";
      fetchRoute(from, to, lastHeading, avoidHw).then((r) => {
        if (aborted || !r) {
          if (!rCoords && !aborted) box.textContent = "🛣 経路を取得できませんでした";
          return;
        }
        if (avoidHw) localRoute = r; else fastRoute = r;
        applyRoute(r, from, isFirst);
        if (isFirst) fetchAlternatives(from); // 初回は両案の所要時間を揃えて選べるように
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
      hwNotice.remove();
      signCard.remove();
      altPanel.remove();
      map.getContainer().classList.remove("crm-has-route-alt"); // dest-box退避の印を解除
      clearBtn.remove();
      hwStrip.remove();
      routeSnapRef.current = null;
      routeReapplyRef.current = null;
      hwActiveRef.current = false;
      aheadGradeRef.current = null; // 経路解除で予告をクリア（古い警告を残さない）
      if (map.getLayer("route-line")) map.removeLayer("route-line");
      if (map.getLayer("route-casing")) map.removeLayer("route-casing"); // ケーシングもsource削除前に除去
      if (map.getSource("route")) map.removeSource("route");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, destKey]);

  // 高速道路切替(自動/高速/一般道)を次のGPS取得を待たず即、ストリップ＆トグル表示へ反映
  useEffect(() => {
    routeReapplyRef.current?.(); // 経路ストリップの即時反映（経路ありの時）
    hwToggleLabelRef.current?.(); // トグルのラベル更新（フリー走行時もここで反映）
  }, [props.hwOverride]);

  // フリー走行(ルート無し)の高速施設ストリップ＋高速の自動判定。
  // ・高速判定(自動): ①位置スナップ優先＝現在地を高速道路センターライン(highways-geom.json)に投影し、
  //   <35mなら高速ON / >90mなら高速OFF（一般道を飛ばしても誤検知せず、渋滞徐行でも高速と判る）。
  //   ②曖昧(35〜90m)・形状未読込・範囲外は速度ヒステリシス(≥65km/hが8フィックス→ON, <50が60→OFF)へフォールバック
  //   （coords.speed が無い端末は前回位置との差分から速度算出）。hwOverride=「高速」は常時ON。
  // ・施設の絞り込み(どの高速か): 自車位置＋進行方位の前方コリドー(横ズレが小さい施設のみ)で並走道路(京葉道路 等)を除外。
  // 経路effectはdest必須なので別系統。dest設定中はこちらは無効（経路effect側が経路に投影して出す）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !props.follow || destKey || props.hwOverride === "off") return;
    let aborted = false;
    let watchId: number | null = null;
    let facilities: HwFacility[] | null = null;
    let roadSet: Set<string> = new Set(); // 施設が実在する路線名の集合（curRoadの信頼性判定用）
    const LOOK = 6; // フリー走行の表示施設数の上限（route側HW_LOOKと揃える。入り切らない分はrender側で自動間引き）
    const MAXKM = 25;
    const FP_MIN_KM = 3; // 前方経路がこの長さ以上構築できた時だけ経路投影を採用（短ければ従来ロジックへ）
    const FP_LATERAL_M = 250; // 施設が前方経路からこの横距離以内なら「その経路上の施設」とみなす
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
    let prevT = 0;
    let lastKmh = 0;
    // 速度ベースの高速自動判定（位置判定が曖昧/未読込のときのフォールバック）。ヒステリシスでちらつき防止。
    let autoHw = false;
    let fast = 0;
    let slow = 0;
    let hwGeom: HighwayGeom | null = null; // 高速道路センターライン形状（位置判定用・遅延読込）
    let hwPathIdx: ForwardPathIndex | null = null; // 前方経路構築用の端点インデックス（hwGeom読込時に作成）
    let sgGeom: SurfaceGeom | null = null; // 高速近傍の一般道形状（357等・高速誤認の打ち消し用）
    let surfHits = 0; // 「一般道が明確に近い」が連続したフィックス数（誤OFFのちらつき防止）
    let autoEff = false; // 実効の自動判定（位置スナップ優先・速度フォールバック）
    let curRoad = ""; // 現在走行中の路線名（位置スナップで把握）。施設を路線名で絞り並走道路を除外する
    const updateAutoHw = (kmh: number) => {
      if (!isFinite(kmh)) return;
      if (kmh >= 65) {
        fast++;
        slow = 0;
        if (fast >= 8) autoHw = true;
      } else if (kmh < 50) {
        slow++;
        fast = 0;
        if (slow >= 60) autoHw = false;
      } else {
        fast = 0;
        slow = 0;
      }
    };
    // 高速モードが実効ONか（手動「高速」＝常時／「自動」＝速度判定）
    const effOn = () =>
      propsRef.current.hwOverride === "on" ||
      (propsRef.current.hwOverride === "auto" && autoEff);
    const toRad = (d: number) => (d * Math.PI) / 180;
    const render = (here: Pt, hd: number) => {
      if (!facilities || !effOn()) {
        strip.style.display = "none";
        return;
      }
      // 現在路線が確定し、かつその名前の施設が実在する(=信頼できる)ときだけ路線名で厳密に絞る。
      // curRoadが施設0件の別名/化けた名のときは信用せず従来コリドーへ（黙ってストリップを空にしない）。
      const useRoad = !!curRoad && roadSet.has(curRoad);
      // byRoad=true: 走行中の路線に属す施設だけ（並走道路を確実に除外）。
      // byRoad=false: 従来の前方コリドー（横ズレが小さい施設のみ）。
      const collect = (byRoad: boolean) => {
        const out: { f: HwFacility; fwd: number }[] = [];
        for (const f of facilities!) {
          const fp = { lat: f.lat, lng: f.lng };
          const d = haversineKm(here, fp);
          if (d > MAXKM || d < 0.05) continue;
          const diff = Math.abs(((bearingDeg(here, fp) - hd + 540) % 360) - 180); // 0=正面
          if (diff > 90) continue; // 後方は除外（前方のみ）
          const fwd = d * Math.cos(toRad(diff)); // 進行方向の前方距離(km)
          if (byRoad && f.road) {
            if (f.road !== curRoad) continue; // 走行中の路線(京葉 等の並走道路を確実に除外)
          } else {
            const lateral = d * Math.sin(toRad(diff));
            if (lateral > Math.min(0.45 + 0.05 * fwd, 1.0)) continue;
          }
          out.push({ f, fwd });
        }
        return out;
      };
      // ① 前方経路投影（最優先）: 高速センターラインを現在地から前方へ辿った経路に施設を投影し、
      //    沿道距離順に並べる。路線名境界(東関東道→湾岸線)・カーブ・JCTを越えて「この先この高速を
      //    走り続ける」前提で前方施設を安定表示（並走道路は経路から外れ除外）。
      // ② 経路が十分構築できない区間（細切れ/端点ギャップ/起点ランプ等）は従来の路線名＋コリドーへ。
      const collectPath = (): { f: HwFacility; fwd: number }[] | null => {
        if (!hwGeom || !hwPathIdx) return null;
        const path = buildForwardPath(hwGeom, hwPathIdx, here.lat, here.lng, hd, MAXKM, curRoad);
        if (!path || path.length < 2 || path[path.length - 1].dist < FP_MIN_KM) return null;
        // onRoad=施設の路線が「投影地点での経路の路線」と一致(＋判定不能)。all=横距離のみ(従来)。
        // 経路は複数路線を跨ぐ(東関東道→湾岸線)ため単一curRoadでは絞れない→投影点ごとの経路路線と突合し
        // 並走他路線(京葉道路等)の施設を除外する。経路路線が施設集合に実在する(roadSet)時だけ厳密に絞る。
        const onRoad: { f: HwFacility; fwd: number }[] = [];
        const all: { f: HwFacility; fwd: number }[] = [];
        for (const f of facilities!) {
          const pr = projectToPath(path, f.lat, f.lng);
          if (!pr || pr.lateralM > FP_LATERAL_M || pr.alongKm <= 0.05 || pr.alongKm > MAXKM) continue;
          all.push({ f, fwd: pr.alongKm });
          const knownRoad = !!pr.road && roadSet.has(pr.road);
          if (!knownRoad || !f.road || f.road === pr.road) onRoad.push({ f, fwd: pr.alongKm });
        }
        // 路線一致で絞れた結果があればそれを優先、空なら従来の横距離のみ(黙って空にしない安全網)。
        return onRoad.length ? onRoad : all;
      };
      let cands = collectPath();
      if (!cands || !cands.length) {
        cands = collect(useRoad);
        // 路線名で絞った結果が空（その路線に前方施設が無い／curRoadの取りこぼし等）なら、
        // 黙って空表示にせず従来コリドーへフォールバックする（安全網）。
        if (useRoad && !cands.length) cands = collect(false);
      }
      cands.sort((a, b) => a.fwd - b.fwd);
      const best = new Map<string, { f: HwFacility; fwd: number }>();
      for (const c of cands) {
        const k = `${c.f.kind}:${bn(c.f.name)}`;
        if (!best.has(k)) best.set(k, c); // 前方距離順に最も近い同名を残す
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
          const dist = c.fwd < 10 ? c.fwd.toFixed(1) : Math.round(c.fwd).toString();
          const min = lastKmh > 5 ? Math.round((c.fwd / lastKmh) * 60) : null;
          const am = f.amenities;
          const amenRow =
            (f.kind === "sa" || f.kind === "pa") && am && am.length
              ? `<div class="hw-amen">${am.map((a) => amen(a, f)).join("")}</div>`
              : "";
          const towardRow =
            (f.kind === "ic" || f.kind === "jct") && f.toward?.length
              ? `<div class="hw-toward">${f.exit ? `<span class="hw-exit">${esc(f.exit)}</span>` : ""}${f.toward
                  .slice(0, 3)
                  .map((t) => `<span class="hw-dir" style="transform:rotate(${bearingToArrowAngle(t.bearing, hd)}deg)">⬆</span>${esc(t.name)}`)
                  .join("")}</div>`
              : "";
          const minTxt = min != null ? ` ・ ${min}<small>分</small>` : "";
          return (
            `<div class="hw-row hw-${f.kind}"><div class="hw-top"><span class="hw-badge">${BADGE[f.kind]}</span>` +
            `<span class="hw-name">${esc(f.name)}</span></div>${amenRow}${towardRow}` +
            `<div class="hw-dist">${dist}<small>km</small>${minTxt}</div></div>`
          );
        })
        .join("");
      // 設備アイコン付き(背の高い)施設が並ぶと縦に溢れて上端で見切れるため、入り切らない遠い施設から落とす（最寄り優先を維持）
      while (strip.children.length > 1 && strip.scrollHeight > strip.clientHeight + 1) {
        strip.removeChild(strip.lastElementChild!);
      }
    };
    loadHighway()
      .then((d) => {
        if (!aborted) {
          facilities = d.facilities;
          roadSet = new Set(d.facilities.map((f) => f.road).filter(Boolean) as string[]);
        }
      })
      .catch(() => {});
    loadHighwayGeom()
      .then((g) => {
        if (!aborted) {
          hwGeom = g;
          hwPathIdx = buildPathIndex(g); // 前方経路用の端点インデックスを一度だけ構築
        }
      })
      .catch(() => {});
    loadSurfaceGeom()
      .then((g) => {
        if (!aborted) sgGeom = g;
      })
      .catch(() => {});
    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
      const h = p.coords.heading;
      if (h != null && isFinite(h) && h >= 0) lastHd = h;
      else if (prevPt && haversineKm(prevPt, here) >= 0.015) lastHd = bearingDeg(prevPt, here);
      // 全国化: 関東(同梱データ範囲)の外を走行中は該当地方ブロックをオンデマンド取得。
      // 取得済み/取得中/直近失敗は ensureRegions 側が弾くので毎フィックス呼んでも実質ノーオペ。
      // 届いたら前方経路インデックスと路線集合を作り直してストリップ/路線フィルタに反映する。
      const rgKey = regionOf(here.lat, here.lng);
      if (rgKey) {
        void ensureRegions([rgKey]).then((changed) => {
          if (aborted || !changed) return;
          if (hwGeom) hwPathIdx = buildPathIndex(hwGeom);
          if (facilities) roadSet = new Set(facilities.map((f) => f.road).filter(Boolean) as string[]);
        });
      }
      // 速度: coords.speed があれば優先。無い端末は前回位置との差分から算出して自動判定に使う。
      const sp = p.coords.speed;
      let kmh: number | null = null;
      if (sp != null && isFinite(sp) && sp >= 0) kmh = sp * 3.6;
      else if (prevPt && prevT) {
        const dt = (p.timestamp - prevT) / 1000;
        if (dt > 0.5) kmh = (haversineKm(prevPt, here) / dt) * 3600;
      }
      if (kmh != null && isFinite(kmh)) {
        lastKmh = kmh;
        updateAutoHw(kmh);
      }
      if (!prevPt || haversineKm(prevPt, here) >= 0.015) {
        prevPt = here;
        prevT = p.timestamp;
      }
      // 位置スナップ判定（優先）。形状読込後、現在地と最寄り高速の距離で確定／曖昧は速度へフォールバック。
      // さらに「最寄り一般道(357等) vs 最寄り高速」を比べ、一般道が明確に近ければ高速判定を打ち消す
      // （高架の真下/真横を走る一般道の高速誤認対策）。引き分け(真下で重なる区間)は速度に委ねる→手動OFFで対応。
      let posOn: boolean | null = null;
      if (hwGeom) {
        const snap = nearestHighway(hwGeom, here.lat, here.lng);
        if (!snap) {
          posOn = false; // 近傍に高速が無い＝高速外
          curRoad = "";
          surfHits = 0;
        } else {
          const MARGIN = 14; // 一般道/高速の距離差がこの値を超えて初めて「明確に近い」と判定
          const sd = sgGeom ? nearestSurface(sgGeom, here.lat, here.lng) : null;
          const surfCloser = sd != null && sd + MARGIN < snap.distM; // 一般道が明確に近い
          const hwCloser = sd == null || snap.distM + MARGIN < sd; // 高速が明確に近い
          surfHits = surfCloser ? Math.min(surfHits + 1, 5) : 0;
          if (surfHits >= 3) posOn = false; // 一般道が連続して明確に近い＝一般道走行
          else if (snap.distM < 35 && hwCloser) posOn = true; // 高速が明確に近く高速上
          else if (snap.distM > 90) posOn = false; // 明確に高速外
          // それ以外(35〜90m / 高架の真下で引き分けの<35m)は曖昧→速度に委ねる
          // 現在路線名: 一般道判定でなく、名前付き路線が80m以内なら更新／200m超or一般道判定でクリア
          if (posOn !== false && snap.name && snap.namedDistM < 80) curRoad = snap.name;
          else if (posOn === false || snap.namedDistM > 200) curRoad = "";
        }
      }
      autoEff = posOn != null ? posOn : autoHw;
      // 高速モード(手動/自動)に合わせ勾配メーターの抑制を同期（高速はDEM標高が不正確なため）
      hwActiveRef.current = effOn();
      if (lastHd == null || !effOn()) {
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
      hwActiveRef.current = false; // 高速モード状態を解放（勾配メーターの抑制も解除）
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
    // 追従状態は followingRef から復元＝再構築(headingUp/テーマ変更)を跨いで「閲覧中(false)」を維持し、
    // 方位切替だけで追従が再開して自車へ再センター＋ズームするのを防ぐ（新規の走行モード開始時は true）。
    let following = followingRef.current;
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
      '<svg class="car-arrow" width="64" height="64" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">' +
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
    // 再構築時に閲覧中(following=false)を復元した場合は画面固定の自車を初期から隠す
    // （既定は可視。手動パンで離れて閲覧中に方位切替しても自車マークが画面中央に湧かないように）。
    if (!following) carEl.style.display = "none";
    map.getContainer().appendChild(carEl);
    // 追従解除中の自車＝地理マーカー（実位置）。手動スクロール時は消し、目的地プレビュー/ルート全体表示(suspend)時のみ
    // 開始地点の目印として残す（setFollowing の showGeoWhenOff で制御）。追従中は非表示。
    const geoEl = document.createElement("div");
    geoEl.style.position = "relative"; // 標高ラベル(absolute)の位置基準
    geoEl.innerHTML = CAR_HTML;
    geoEl.style.display = "none";
    // 追従パン時の自車(地理マーカー)。3D時の傾きは carEl と同じく updateCarTilt で「少し起こして」手動付与する。
    // pitchAlignment:"map" は地図平面へ完全に寝かせる＝pitch分だけ寝すぎるため使わず、既定(viewport)で要素は正対のまま
    // 内側の矢印に rotateX(実pitch×係数) を掛けて少しだけ傾ける。
    const geoMarker = new mapboxgl.Marker({ element: geoEl, anchor: "center" });
    const c0 = propsRef.current.userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };
    geoMarker.setLngLat([c0.lng, c0.lat]).addTo(map);

    // 「現在地」ボタン（要望で常時表示）。タップで現在地へ復帰＋表示スケールを150mに。
    const recBtn = document.createElement("button");
    recBtn.type = "button";
    recBtn.className = "recenter-btn"; // 右・中央（Leaflet版と同じ位置）。常時表示。
    recBtn.textContent = "📍 現在地";
    // showGeoWhenOff: 追従解除中に地理マーカー(実位置)を出すか。
    //   手動スクロール時は false＝自車マークを消す（見ている場所と無関係な位置に自車が残る混乱を防ぐ。復帰は「現在地」ボタン）。
    //   目的地プレビュー/ルート全体表示(suspend)時は true＝開始地点の目印として実位置を残す。
    const setFollowing = (on: boolean, showGeoWhenOff = false) => {
      following = on;
      followingRef.current = on; // 再構築を跨いで追従状態を保持（閲覧中の方位切替で追従が再開しないように）
      carEl.style.display = on ? "" : "none"; // 追従中だけ画面固定の自車
      geoEl.style.display = on || !showGeoWhenOff ? "none" : ""; // 手動パン中は消す／プレビュー等は実位置に残す
      updateCarTilt?.(); // 表示を切り替えた自車マークに現在のpitch変換(2Dはscale込み)を確実に適用
    };
    recBtn.onclick = () => {
      setFollowing(true);
      // 現在地へ戻る＋表示スケールを150mに（要望）。中心はGPS実位置、無ければ現在の地図中心。
      const center = (lastHere ?? (map.getCenter().toArray() as [number, number])) as [number, number];
      const lat = lastHere ? lastHere[1] : map.getCenter().lat;
      const targetZoom = zoomForScale150(lat);
      if (camRaf) {
        // 走行追従ループ稼働中＝center/bearingは毎フレーム上書きされるので縮尺だけ即時反映
        // （applyFollowはzoomを触らないため保持される）。
        map.setZoom(targetZoom);
      } else {
        // 追従が外れている（手動パン／停車）＝現在地へ滑らかに寄せ直し＋150m縮尺。
        map.easeTo({ center, zoom: targetZoom, bearing: headingUp ? lastBearing : 0, offset: [0, leadPx()], duration: 600 });
      }
    };
    map.getContainer().appendChild(recBtn);
    // 目的地プレビュー/ルート全体表示のために、走行モードを抜けずにカメラ追従だけ一時停止するAPIを公開。
    // 進行中の30fps補間(camRaf)も止めて、直後の flyTo/fitBounds が上書きされないようにする。復帰は「現在地」ボタン。
    followApiRef.current = {
      suspend: () => {
        setFollowing(false, true); // プレビュー/ルート全体表示中は開始地点の目印として実位置マーカーを残す
        if (camRaf) { cancelAnimationFrame(camRaf); camRaf = 0; }
      },
    };
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
    // 追従中の自車マーク(画面固定オーバーレイ)を地図のpitchに合わせて寝かせる。3D時は地面に沿って傾く。
    // 向き(rotate)と傾き(rotateX=camPitch)を合成。ノースアップは進行方位へrotate、ヘディングアップは上向き固定。
    // 自車マーク(画面固定carEl＋地理geoEl)を地図のpitchに合わせて寝かせる。ただし地図平面まで寝かせると
    // 「寝すぎ」て見づらいので、実ピッチの CAR_TILT_FACTOR 倍だけ傾ける（＝少し起こす）。pitchは map.getPitch()
    // を都度参照するので、停車中に3Dトグルしても(走行していなくても)地図のpitch変化に連動して即傾く/起きる。
    const CAR_TILT_FACTOR = 0.65;
    const CAR_SCALE_2D = 0.85; // 2D(平面)時だけ自車マークを少し小さく。3Dは傾きで小さく見えるため等倍(64px)のまま。
    const carArrowTransform = (rot: number) => {
      const p = map.getPitch();
      return p > 0.5
        ? `perspective(640px) rotateX(${(p * CAR_TILT_FACTOR).toFixed(1)}deg) rotate(${rot.toFixed(1)}deg)`
        : `rotate(${rot.toFixed(1)}deg) scale(${CAR_SCALE_2D})`; // 平面時は傾き無し＋少し縮小
    };
    const updateCarTilt = () => {
      const rot = headingUp ? 0 : carRot;
      const a = carEl.querySelector(".car-arrow") as HTMLElement | null;
      if (a) a.style.transform = carArrowTransform(rot); // 画面固定の自車
      const b = geoEl.querySelector(".car-arrow") as HTMLElement | null;
      if (b) b.style.transform = carArrowTransform(rot); // 追従パン中の地理マーカー
    };
    const applyCarRotation = () => {
      if (headingUp) return;
      const moving = targetKmh > MOVE_KMH;
      const hd = moving ? lastTravelHeading : compassHeading() ?? lastTravelHeading;
      if (hd == null) return;
      carRot += angDiff(hd, carRot);
      updateCarTilt(); // carEl・geoEl とも向き＋傾き込みで更新
    };
    // 地図のpitch変化(3Dトグルの easeTo・追従ループのpitch補間)に連動して自車マークを寝かせ直す。
    // これで走行していなくても3D切替時に即マップ連動で傾く（従来は追従ループ内でしか更新されず、
    // 走らないと切り替わらなかった）。
    map.on("pitch", updateCarTilt);
    // 生成直後に現在のpitchに応じた変換(2Dはscale込み)を即適用。これが無いと、走行モード開始/ヘディングアップ
    // 切替で自車マークを作り直した直後、停車中(camTick非稼働)かつpitch変化なしだと初期の素の64pxのまま残る
    // （＝「2Dなのに時々大きい」の原因）。
    updateCarTilt();

    // 追従カメラの補間を「自前30fpsループ」で行う（Mapbox easeTo は描画FPS上限を指定できず60fpsで回るため、
    // 省電力・発熱低減目的で半分に間引く）。各フレームは easeTo(duration:0)＝offset維持の即時移動。時間ベースなので
    // フレームを間引いても自車の動き(位置)・速度・判定は不変。停車/到達後はループを止めてGPUを起こさない。
    const CAM_DUR = 1100; // フィックス間を繋ぐ補間時間（従来の easeTo duration と同じ）
    const CAM_FRAME_MS = 33; // 約30fps（前フレームから33ms未満は描画スキップ）
    let camRaf = 0;
    let camFrom: [number, number] | null = null;
    let camTo: [number, number] | null = null;
    let camFromB = 0;
    let camToB = 0;
    let camStart = 0;
    let camLastFrame = 0;
    let camCur: [number, number] | null = null; // 直近適用した補間中心（＝自車の表示位置）
    let camCurB = 0;
    // ピッチ(3D俯瞰)も追従ループが所有する。毎フレームの easeTo(duration:0) が pitch を含まないと、
    // 3Dトグルの easeTo({pitch,600}) を33msごとにキャンセルしてしまい走行中に3Dへ切り替わらないため。
    let camPitch = propsRef.current.threeD ? PITCH_3D : 0; // 補間中の現在ピッチ
    const pitchTarget = () => (propsRef.current.threeD ? PITCH_3D : 0);
    const applyFollow = (c: [number, number], b: number) =>
      map.easeTo({ center: c, bearing: b, pitch: camPitch, offset: [0, leadPx()], duration: 0 });
    const camTick = () => {
      const now = performance.now();
      if (now - camLastFrame < CAM_FRAME_MS) {
        camRaf = requestAnimationFrame(camTick); // まだ33ms経っていない＝描画せず次フレームへ
        return;
      }
      camLastFrame = now;
      const t = Math.min(1, (now - camStart) / CAM_DUR);
      const lng = camFrom![0] + (camTo![0] - camFrom![0]) * t;
      const lat = camFrom![1] + (camTo![1] - camFrom![1]) * t;
      const b = norm360(camFromB + angDiff(camToB, camFromB) * t);
      camCur = [lng, lat];
      camCurB = b;
      // ピッチを目標へEMA補間（係数0.15＝約600msで到達@30fps）。微小差はスナップ。
      const pt = pitchTarget();
      camPitch += (pt - camPitch) * 0.15;
      if (Math.abs(pt - camPitch) < 0.4) camPitch = pt;
      applyFollow(camCur, b);
      updateCarTilt(); // 自車マークも地図のpitchに合わせて寝かせる（3D時は地面に沿って傾く）
      // 位置・方位が到達してもピッチ補間中はループ継続（3D立ち上げ/解除を滑らかに完遂させる）。
      camRaf = t < 1 || camPitch !== pitchTarget() ? requestAnimationFrame(camTick) : 0;
    };
    const followTo = (to: [number, number], b: number) => {
      camFrom = camCur || to; // 補間途中なら現在位置から（戻りジャンプ防止）
      camFromB = camCur ? camCurB : b;
      camTo = to;
      camToB = b;
      camStart = performance.now();
      if (!camRaf) {
        camLastFrame = 0;
        camPitch = map.getPitch(); // ループ再開時は実ピッチへ同期（停車中に3Dトグルで変わった分を引き継ぐ）
        camRaf = requestAnimationFrame(camTick);
      }
    };
    const followJump = (to: [number, number], b: number) => {
      if (camRaf) {
        cancelAnimationFrame(camRaf);
        camRaf = 0;
      }
      camCur = to;
      camCurB = b;
      camPitch = pitchTarget(); // ジャンプ時はピッチも即目標へ
      applyFollow(to, b); // >150mジャンプ等は即スナップ
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
        map.easeTo({ center: here, bearing, pitch: propsRef.current.threeD ? PITCH_3D : 0, zoom: startZoom, offset: [0, leadPx()], duration: 800 });
        prevCam = here;
        camCur = here; // 自前補間の起点を初期化（次フィックスからここを基準に補間）
        camCurB = bearing;
      } else {
        // GPSグリッチ/トンネル復帰で前回カメラ位置から150m超ジャンプしたら、滑らかに追わず即スナップ
        // （誤った遠方へ1.1秒かけて流れて戻る不快な動きを防ぐ。Leaflet版の>150m即スナップ移植）。
        const movedKm = prevCam ? haversineKm({ lng: prevCam[0], lat: prevCam[1] }, { lng: here[0], lat: here[1] }) : 0;
        const isJump = !!prevCam && movedKm > 0.15;
        const stationary = kmh == null || kmh <= MOVE_KMH;
        // 停車中＋ほぼ不動(20m未満)はパンを打たない（毎フィックスの微ジッタ・電力を抑制。Leaflet版同様）。
        if (!isJump && stationary && prevCam && movedKm < 0.02) {
          /* 据え置き（パンしない） */
        } else {
          // 1Hzフィックス間を自前の30fps補間で繋ぐ（画面固定の自車に地図がなめらかに流れる・easeTo60fpsより省電力）。
          if (isJump) followJump(here, bearing);
          else followTo(here, bearing);
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
      followTo(lastHere, headingUp ? lastBearing : 0); // DRも自前30fps補間で前進（省電力・追従と統一）
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
      if (camRaf) cancelAnimationFrame(camRaf); // 追従カメラの30fps補間を停止
      window.removeEventListener("deviceorientationabsolute", onOrient as EventListener, true);
      window.removeEventListener("deviceorientation", onOrient, true);
      document.removeEventListener("visibilitychange", onVis);
      try {
        wake?.release();
      } catch {
        /* 無視 */
      }
      map.off("dragstart", onUserPan);
      map.off("pitch", updateCarTilt);
      followApiRef.current = null; // 走行モード終了でカメラ一時停止APIを無効化
      carEl.remove();
      geoMarker.remove();
      recBtn.remove();
      addrBox.remove();
      destBox.remove();
      box.remove();
      window.clearInterval(speedoAnim);
      // ブラウズ表示へ戻す（北向き）。3D表示中はピッチを保持（平面時のみ水平に戻す）。
      map.easeTo({ bearing: 0, pitch: propsRef.current.threeD ? PITCH_3D : 0, duration: 600 });
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
    const MIN_MOVE_KM = 0.05; // 50m移動ごとに勾配を再計測（表示は維持）
    let lastHeading: number | null = null;
    let lastUpdatePos: Pt | null = null;
    let prevPos: Pt | null = null;
    let reqId = 0;
    let lastGrade: number | null = null;
    let prevSpeed: number | null = null; // ジャイロ融合: 加減速(速度微分)算出用
    let lastFixT = 0;
    let prevHdg: number | null = null; // ジャイロ融合: 進行方位の変化率(旋回検出)算出用

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
        // ジャイロ融合の数式検証用: _pitch を直接セットして feed(DEM%) の融合結果を確認できる
        setPitch: (o: Partial<typeof _pitch>) => {
          Object.assign(_pitch, o);
          return { ..._pitch };
        },
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
      // ジャイロ融合: トグル状態を反映。基準姿勢g0は「平坦・直進・定速巡航」時のみ学習（坂/旋回/加減速では学習しない）
      _pitch.enabled = propsRef.current.gyroGrade;
      const sp = p.coords.speed;
      const dtFix = lastFixT > 0 ? (p.timestamp - lastFixT) / 1000 : 0;
      lastFixT = p.timestamp;
      if (sp != null && sp >= 0) {
        if (prevSpeed != null && dtFix > 0.05) _pitch.accel = (sp - prevSpeed) / dtFix;
        prevSpeed = sp;
        if (
          sp > 3 &&
          Math.abs(_pitch.accel) < PITCH_ACC_GATE &&
          _pitch.headingRate < PITCH_TURN_GATE &&
          _pitch.demFlat &&
          _pitch.g
        ) {
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
      // 進行方位の変化率(°/s)＝旋回検出。融合とg0学習で「直進中だけ傾きを信用」するために使う。
      if (lastHeading != null) {
        if (prevHdg != null && dtFix > 0.05) {
          const dHdg = Math.abs(((lastHeading - prevHdg + 540) % 360) - 180); // 最短角差
          _pitch.headingRate = dHdg / dtFix;
          // 横G(向心加速度) ≒ 速度[m/s] × 角速度[rad/s]。カーブ/車線変更でのローリング(横傾き)検出に使う。
          const spd = sp != null && sp >= 0 ? sp : 0;
          _pitch.lateralAccel = spd * ((_pitch.headingRate * Math.PI) / 180);
        }
        prevHdg = lastHeading;
      }
      render(lastGrade);
      // 高速道路では勾配メーターを非表示（render 冒頭で display:none）にしているので、
      // GSI標高サンプリング（±100m/25m間隔=9点/50m移動ごと）自体もスキップして通信を節約する。
      // 高架/トンネルでDEMが道路とズレて誤るため表示しない区間＝そもそも計算不要。復帰は高速判定OFFで自動再開。
      if (hwActiveRef.current || propsRef.current.hwOverride === "on") return;
      if (lastHeading == null) return; // 方位不明(未発進)は「—」表示のみ
      if (lastUpdatePos && haversineKm(here, lastUpdatePos) < MIN_MOVE_KM) return;
      lastUpdatePos = here;
      // 現在勾配 = 現在地中心の標高プロファイル(±GRADE_REG_HALF, GRADE_REG_STEP間隔)を最小二乗回帰した傾き。
      // 2点差分よりノイズに頑健(実測で坂のstd 8.94%→1.95%)。GSI由来のサンプルのみ採用し源混在を排除。
      const offs: number[] = [];
      for (let d = -GRADE_REG_HALF; d <= GRADE_REG_HALF; d += GRADE_REG_STEP) offs.push(d);
      const samplePts = offs.map((d) => pointAhead(here, lastHeading!, d));
      const id = ++reqId;
      Promise.all(samplePts.map((pt) => fetchElev(pt.lat, pt.lng))).then((results) => {
        if (aborted || id !== reqId) return;
        const xs: number[] = []; // 沿道距離(m)
        const ys: number[] = []; // 標高(m)
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r && r.src === "gsi") {
            xs.push(offs[i]);
            ys.push(r.v);
          }
        }
        let g: number | null = null;
        if (xs.length >= GRADE_REG_MIN_PTS) {
          const slope = robustSlope(xs, ys); // m/m（外れ値除去付き回帰）
          if (slope != null) {
            const gv = slope * 100;
            if (Math.abs(gv) <= GRADE_MAX_PLAUSIBLE) g = gv;
          }
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

  /** 天気バー内の渋滞取得時刻ラベル(.wx-traffic)を更新。渋滞ON＆取得済みのときだけ表示。 */
  function paintTrafficTime() {
    const span = weatherBoxRef.current?.querySelector(".wx-traffic") as HTMLElement | null;
    if (!span) return;
    span.textContent =
      propsRef.current.traffic && lastTrafficAtRef.current
        ? `🚗 渋滞 ${fmtHM(lastTrafficAtRef.current)}時点`
        : "";
  }

  function setupLayers(map: mapboxgl.Map) {
    // リアルタイム渋滞（Mapbox Traffic v1）。道路の上・ラベルの下に挿入。混雑(moderate以上)のみ色分けし
    // 「流れている道(low)」は出さず見やすく＆軽く。表示ON/OFFは props.traffic で visibility 切替。
    if (!map.getSource("traffic")) {
      map.addSource("traffic", { type: "vector", url: "mapbox://mapbox.mapbox-traffic-v1" });
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: "traffic",
          type: "line",
          source: "traffic",
          "source-layer": "traffic",
          // Standard では基図のsymbol層が非公開で firstSymbol(before)が効かず層が隠れる。
          // slot:"middle"=道路の上・ラベルの下に明示配置（classicスタイルではslotは無視されbeforeが効く）。
          slot: "middle",
          layout: {
            "line-cap": "round",
            visibility: propsRef.current.traffic ? "visible" : "none",
          },
          filter: ["match", ["get", "congestion"], ["moderate", "heavy", "severe"], true, false],
          paint: {
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 16, 8],
            "line-offset": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 16, 4],
            "line-opacity": 0.95,
            // Standardの夜間ライティングで自前レイヤーが暗く沈むのを防ぐ＝発光を最大にして明色のまま視認。
            // classicスタイル(ライト)では照明モデルが無く無視される（無害）。
            "line-emissive-strength": 1,
            "line-color": [
              "match",
              ["get", "congestion"],
              "moderate", "#ffd21a", // 明るい黄: やや混雑
              "heavy", "#ff7a1a", // 明るい橙: 混雑
              "severe", "#ff2d2d", // 明るい赤: 渋滞
              "#ffd21a",
            ],
          },
        },
        firstSymbol
      );
    }
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
      // pitchAlignment:"map" ＝ 3D表示(pitch)時にドットを地図平面へ寝かせる（2Dのまま立たない）
      userMarkerRef.current = new mapboxgl.Marker({ element: el, pitchAlignment: "map" })
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

  /** Standardスタイル時の設定。night ライトプリセット（ダーク）＋日本語ラベル＋各種ラベル表示ON。
   *  classicスタイル（streets-v12）では config API が無く throw するため isStandard でガードし無視する。
   *  Standardのラベルは applyLabels(レイヤ単位のtext-field書換)ではなく config の language で日本語化する。 */
  function applyStandardConfig(map: mapboxgl.Map) {
    if (!isStandard(styleRef.current)) return;
    const set = (k: string, v: unknown) => {
      try {
        (map as unknown as { setConfigProperty: (i: string, k: string, v: unknown) => void })
          .setConfigProperty("basemap", k, v);
      } catch {
        /* 非Standard/旧mapbox-glでは無視 */
      }
    };
    set("lightPreset", "night"); // 夜景（ダーク）。駅/地名/POI/道路を保ったまま暗くする
    set("showPointOfInterestLabels", true);
    set("showTransitLabels", true); // 駅・鉄道などの交通ラベル
    set("showPlaceLabels", true); // 地名
    set("showRoadLabels", true); // 道路名
    // ラベルの日本語化は Standard では config('language') が効かず map.setLanguage が正API。
    // localIdeographFontFamily で漢字/かなを端末フォント生成。
    try {
      (map as unknown as { setLanguage?: (l: string) => void }).setLanguage?.("ja");
    } catch {
      /* 旧mapbox-glでは未対応＝無視 */
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
