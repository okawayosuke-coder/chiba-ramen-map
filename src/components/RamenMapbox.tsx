import { memo, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Shop } from "../types";
import { bearingDeg, fmtDistance, haversineKm, roughMinutes, type Pt, type Dest } from "../nav";
import { fetchRoute, projectOnRoute } from "../route";
import { fetchPois, poiBrandStyle, poiIconFile, type Poi, type PoiKind, type BBox } from "../poi";
import {
  loadLocalPois,
  coverageContains,
  localPoisInView,
  LOCAL_KINDS,
  type LocalPoiData,
} from "../poiData";
import { fetchWeather, wmo, type Weather } from "../weather";
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

const STYLE_URL = "mapbox://styles/mapbox/streets-v12";
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

/** from から進行方位 headingDeg(0=北) 方向へ distM メートル進んだ地点。 */
function pointAhead(from: Pt, headingDeg: number, distM: number): Pt {
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111320;
  const dLng = (distM * Math.sin(rad)) / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
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
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [v.lng, v.lat],
      zoom: v.zoom,
      bearing: v.bearing,
      pitch: v.pitch,
      maxZoom: 19,
      attributionControl: true,
    });
    mapRef.current = map;
    (window as unknown as Record<string, unknown>).__mbmap = map; // 検証/デバッグ用（試験エンジン時のみ）
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.touchZoomRotate.enableRotation(); // 2本指回転（ヘディングアップの素地）

    // コンテナのサイズ変化（左ペイン開閉・画面回転・ウィンドウリサイズ）で地図を再計測。
    // Mapboxはコンテナのサイズ変化を自動検知しないため、これが無いとペインを閉じた時に
    // 右側が空白のまま（旧サイズで描画され続ける）になる。
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    map.on("style.load", () => {
      // style.load は full 'load' より早く確実に発火する（ヘッドレス検証でも動く・実機でも堅牢）。
      // 再 setStyle 時の二重登録を防ぐため source 有無で初期化をガード。
      if (!map.getSource("shops")) {
        setupLayers(map);
        wireInteractions(map);
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
      map.addSource("route", { type: "geojson", data: lineData([]) });
      const before = map.getLayer("clusters") ? "clusters" : undefined;
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#0b57d0", "line-width": 7, "line-opacity": 0.95 },
        },
        before
      );
    }
    const setLine = (coords: [number, number][]) => {
      (map.getSource("route") as mapboxgl.GeoJSONSource | undefined)?.setData(lineData(coords));
    };

    // 残距離/ETA ボックス（左上・既存CSS .route-box）
    const box = document.createElement("div");
    box.className = "route-box";
    box.textContent = "🛣 現在地を取得中…";
    map.getContainer().appendChild(box);

    // ルート解除ボタン
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "✕ ルート解除";
    clearBtn.setAttribute(
      "style",
      "position:absolute;top:64px;left:12px;z-index:600;padding:8px 12px;border-radius:8px;border:0;background:rgba(20,20,20,.82);color:#fff;font-size:14px;font-weight:700;"
    );
    clearBtn.onclick = () => propsRef.current.onClearDest();
    map.getContainer().appendChild(clearBtn);

    let rCoords: [number, number][] | null = null;
    let rSuffix: number[] = [];
    let rKm = 0;
    let rMin = 0;
    let lastHeading: number | null = null;
    let headingPrevPos: Pt | null = null;

    const fmtEta = (min: number) =>
      new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })
        .format(new Date(Date.now() + Math.max(0, min) * 60000));

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
      // 走行済み区間を消す（投影点→以降の頂点）
      setLine([[pr.proj.lat, pr.proj.lng], ...rCoords.slice(pr.segIdx + 1)]);
      // 経路スナップ用に投影点＋道路セグメント方位を共有（followが自車位置/向きに使う）
      let segBearing = routeSnapRef.current?.bearing ?? 0;
      if (pr.segIdx + 1 < rCoords.length) {
        const a = rCoords[pr.segIdx];
        const b = rCoords[pr.segIdx + 1];
        segBearing = bearingDeg({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
      }
      routeSnapRef.current = { proj: pr.proj, bearing: segBearing, at: Date.now() };
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
        refresh(from);
      });
    };

    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
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
      destMarker.remove();
      box.remove();
      clearBtn.remove();
      routeSnapRef.current = null;
      if (map.getLayer("route-line")) map.removeLayer("route-line");
      if (map.getSource("route")) map.removeSource("route");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, destKey]);

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
    let following = true;

    const CAR_SVG =
      '<svg class="car-arrow" width="54" height="54" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="18" cy="18" r="15" fill="rgba(26,115,232,0.18)"/>' +
      '<path d="M18 4 L27 26 L18 21 L9 26 Z" fill="#1a73e8" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
    // 追従中の自車＝画面固定オーバーレイ（カメラが自車を中央追従するので地図がなめらかに流れる）。
    // ヘディングアップは下寄り(72%・前方ワイド)、ノースアップは中央(50%)。
    const carEl = document.createElement("div");
    carEl.setAttribute(
      "style",
      `position:absolute;left:50%;top:${headingUp ? "72%" : "50%"};transform:translate(-50%,-50%);z-index:600;pointer-events:none;`
    );
    carEl.innerHTML = CAR_SVG;
    map.getContainer().appendChild(carEl);
    // 手動パンで追従を外した時の自車＝地理マーカー（実位置に残す）。追従中は非表示。
    const geoEl = document.createElement("div");
    geoEl.innerHTML = CAR_SVG;
    geoEl.style.display = "none";
    const geoMarker = new mapboxgl.Marker({ element: geoEl, anchor: "center" });
    const c0 = propsRef.current.userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };
    geoMarker.setLngLat([c0.lng, c0.lat]).addTo(map);

    // 「現在地」ボタン（手動パンで追従が外れた時だけ表示→タップで自車へ復帰）
    const recBtn = document.createElement("button");
    recBtn.type = "button";
    recBtn.textContent = "📍 現在地";
    recBtn.setAttribute(
      "style",
      "position:absolute;right:12px;bottom:120px;z-index:620;display:none;padding:10px 14px;border-radius:10px;border:0;background:#1a73e8;color:#fff;font-weight:700;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.4);"
    );
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

    const onFix = (p: GeolocationPosition) => {
      if (aborted) return;
      const sp = p.coords.speed; // m/s
      const kmh = sp != null && sp >= 0 ? sp * 3.6 : null;
      updateSpeedo(kmh, kmh != null && kmh > MOVE_KMH, p.coords.accuracy ?? null);
      // 経路案内中はGPSを経路へスナップ（無料のmap matching）し、向きも道路セグメント方位に。
      // 経路が無い/古い時は生GPS＋GPS進行方位にフォールバック。rAFが tgt へ補間して描画する。
      const snap = routeSnapRef.current;
      const useSnap = !!snap && Date.now() - snap.at < 3000;
      const here: [number, number] = useSnap
        ? [snap!.proj.lng, snap!.proj.lat]
        : [p.coords.longitude, p.coords.latitude];
      lastHere = here;
      geoMarker.setLngLat(here); // 地理マーカーは常に実位置（パン中の自車表示用）
      const hd = p.coords.heading;
      // ヘディングアップ時のみ進行方位を採用（ノースアップは常に北＝bearing 0）
      if (headingUp && kmh != null && kmh > MOVE_KMH) {
        if (useSnap) lastBearing = snap!.bearing;
        else if (hd != null && isFinite(hd) && hd >= 0) lastBearing = hd;
      }
      if (!following) return; // 手動パン中はカメラを動かさない（自車は地理マーカーで実位置に表示）
      const bearing = headingUp ? lastBearing : 0;
      if (first) {
        first = false;
        map.easeTo({ center: here, bearing, pitch: 0, zoom: DRIVE_ZOOM, offset: [0, leadPx()], duration: 800 });
      } else {
        // 1Hzフィックス間を線形イージング(間隔より少し長い1100ms)で繋ぎ、画面固定の自車に地図がなめらかに流れる。
        map.easeTo({ center: here, bearing, offset: [0, leadPx()], duration: 1100, easing: (t) => t });
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

    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
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

    const box = document.createElement("div");
    box.className = "grade-box";
    map.getContainer().appendChild(box);
    const render = (g: number | null) => {
      box.style.display = "";
      updateGradeMeter(box, g, null);
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
      };
    }

    const onPos = (p: GeolocationPosition) => {
      const here: Pt = { lat: p.coords.latitude, lng: p.coords.longitude };
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
