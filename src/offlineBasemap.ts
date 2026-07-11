// オフライン(圏外)用のベクタ基図。自前 pmtiles(Protomaps/OSM由来) を am2222/mapbox-pmtiles で描く。
// ★方式: 圏外時は「重ね」ではなく専用の自己完結スタイル(setStyle)へ切替える。
//   重ね方式は setStyle(テーマ切替)との競合・標準スタイルのslot問題で不安定だったため。
//   このスタイルに切替えると、アプリ既存の style.load 再構築でルート/自車/POI が上に載る。
// 供給: Service Worker の range キャッシュ(vite.config runtimeCaching rangeRequests)から 206 で返る。
import mapboxgl from "mapbox-gl";
// dist の ESM ビルドを直接 import（package main は .ts ソースで tsc が noUnusedLocals で落ちるため）。
import PmTilesSource, { SOURCE_TYPE as PM_SOURCE_TYPE } from "mapbox-pmtiles/dist/mapbox-pmtiles.js";

const BASE = import.meta.env.BASE_URL; // 本番 /chiba-ramen-map/ ・dev /
export const OFFLINE_CACHE = "offline-basemap"; // Workbox runtimeCaching の cacheName と一致
export const OFFLINE_STYLE_KEY = "__offline__"; // styleRef 用センチネル（styleFor と区別）

// 生成した2ファイル(各<100MBで同一オリジン配信)。z0-12。bounds は pmtiles extract の bbox。
export const OFFLINE_SOURCES: { id: string; url: string; bounds: [number, number, number, number] }[] = [
  { id: "ob-south", url: `${BASE}offline-basemap/south.pmtiles`, bounds: [136.0, 34.6, 141.1, 37.4] }, // 中部+関東
  { id: "ob-north", url: `${BASE}offline-basemap/north.pmtiles`, bounds: [138.4, 37.0, 142.1, 41.6] }, // 東北
];

// ラベル用 GeoJSON(ビルド時に pmtiles から抽出・precache対象=圏外冷間起動でも即使える)。
// places=市区町村(locality) / roads=高速(motorway)+国道級(trunk) の ref。scripts/extract-offline-labels.mjs 参照。
const LABEL_PLACES_URL = `${BASE}offline-basemap/labels-places.json`;
const LABEL_ROADS_URL = `${BASE}offline-basemap/labels-roads.json`;
const LABEL_POIS_URL = `${BASE}offline-basemap/labels-pois.json`; // 駅・団地など(pois由来)
const LABEL_CHOME_URL = `${BASE}offline-basemap/labels-chome.json`; // 全町丁目(国交省 位置参照情報・約9万点)
// 準備(warm)時にまとめてキャッシュするラベル群。pmtiles と同じく圏外準備でDLし、precache には載せない(全ユーザーへの負担回避)。
export const OFFLINE_LABEL_URLS = [LABEL_PLACES_URL, LABEL_ROADS_URL, LABEL_POIS_URL, LABEL_CHOME_URL];

// ラベル用フォント: 同梱の Noto Sans Regular(Protomaps basemaps-assets・オープン)。public/fonts/ に 0-255/256-511 を
// 同梱し precache＝圏外でも確実に取得できレース無し。★以前の失敗の真因=ラベル用フォントスタックのグリフが
// オンライン時にキャッシュされず、圏外で mapbox:// グリフ取得が失敗して symbol 描画が壊れていた。同梱で解消。
// CJK(日本語の地名)は map の localIdeographFontFamily で端末フォント描画＝CJKグリフの配信は不要。道路番号はラテンで 0-255 に収まる。
const OB_FONT = ["Noto Sans Regular"];
// 幾何の主要道路(高速/幹線)強調フィルタ（pmtiles roads レイヤーの pmap:kind）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MAJOR: any = ["match", ["get", "pmap:kind"], ["highway", "major_road", "medium_road"], true, false];

let registered = false;
/** カスタムソース型 "pmtile-source" を mapbox-gl に登録（setStyle 前に必須・一度だけ）。 */
export function registerPmtiles(): void {
  if (registered) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mapboxgl as any).Style.setSourceType(PM_SOURCE_TYPE, PmTilesSource);
  registered = true;
}

/** 圏外用の最小の正規スタイル。★ここに pmtile-source は入れない（setStyleのスタイル検証が
 *  カスタムソース型を拒否するため）。背景＋glyphsだけの空スタイルにし、pmtiles は style.load 後に
 *  addOfflinePmtilesLayers() で addSource 追加する（addSource は setSourceType 済カスタム型を受け付ける）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOfflineStyle(): any {
  return {
    version: 8,
    // ★glyphs は同梱(public/fonts/・precache)。圏外冷間起動でも確実。CJKは localIdeographFontFamily で端末描画。
    glyphs: `${BASE}fonts/{fontstack}/{range}.pbf`,
    sources: {},
    layers: [{ id: "ob-earth", type: "background", paint: { "background-color": "#e9e5dc" } }],
  };
}

/** pmtiles のソース＋幾何/ラベル層を map に追加（style.load 後・圏外時に呼ぶ）。
 *  am2222 は getHeader(url) を await してから addSource するのが実績パターン。
 *  layers はアプリ層(shops/track/route等)の下に入れる＝beforeId に最初のアプリ層を使う。 */
export async function addOfflinePmtilesLayers(map: mapboxgl.Map): Promise<void> {
  registerPmtiles();
  if (map.getSource("ob-south") || map.getSource("ob-north")) return; // 二重追加防止
  // アプリ層(ob-earth以外)の最下層。これより下に基図を敷く。
  const beforeId = map.getStyle().layers.find((l) => l.id !== "ob-earth")?.id;
  const add = (l: mapboxgl.AnyLayer) => (beforeId && map.getLayer(beforeId) ? map.addLayer(l, beforeId) : map.addLayer(l));
  for (const s of OFFLINE_SOURCES) {
    const h = await PmTilesSource.getHeader(s.url);
    map.addSource(s.id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: PM_SOURCE_TYPE as any,
      url: s.url,
      minzoom: h.minZoom,
      maxzoom: h.maxZoom,
      bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const L: mapboxgl.AnyLayer[] = [
      { id: `${s.id}-landuse`, type: "fill", source: s.id, "source-layer": "landuse", paint: { "fill-color": "#dfe7d3", "fill-opacity": 0.55 } },
      { id: `${s.id}-water`, type: "fill", source: s.id, "source-layer": "water", paint: { "fill-color": "#a9cbe8" } },
      // 道路: ケーシング(濃いめ・太)→本体(白・細) でベージュ地に視認性を出す
      { id: `${s.id}-roads-case`, type: "line", source: s.id, "source-layer": "roads", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#8a8578", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.4, 14, 5] } },
      { id: `${s.id}-roads`, type: "line", source: s.id, "source-layer": "roads", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 3] } },
      { id: `${s.id}-roads-major-case`, type: "line", source: s.id, "source-layer": "roads", filter: MAJOR, paint: { "line-color": "#d99a1f", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.8, 14, 6] } },
      { id: `${s.id}-roads-major`, type: "line", source: s.id, "source-layer": "roads", filter: MAJOR, paint: { "line-color": "#ffd873", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 4] } },
    ];
    for (const l of L) add(l);
  }
  // ★ラベルは pmtiles(am2222カスタムソース)ではなく、ネイティブ geojson ソース＋symbol で描く。
  //   カスタムソース上の symbol はタイル描画をブロックする不具合があるが、geojson の symbol は素の
  //   mapbox-gl 機能で確実に動く。データはビルド時に pmtiles から抽出した同梱 geojson(precache)。
  addOfflineLabelLayers(map);
}

/** 地名(市区町村)・道路番号(高速/国道)のラベルを geojson ソースから追加。addOfflinePmtilesLayers から呼ぶ。 */
function addOfflineLabelLayers(map: mapboxgl.Map): void {
  if (!map.getSource("ob-places")) map.addSource("ob-places", { type: "geojson", data: LABEL_PLACES_URL });
  if (!map.getSource("ob-roads")) map.addSource("ob-roads", { type: "geojson", data: LABEL_ROADS_URL });
  if (!map.getSource("ob-pois")) map.addSource("ob-pois", { type: "geojson", data: LABEL_POIS_URL });
  if (!map.getSource("ob-chome")) map.addSource("ob-chome", { type: "geojson", data: LABEL_CHOME_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const REF_COLOR: any = ["match", ["get", "kd"], "motorway", "#0a7d32", "#1a56c4"]; // 高速=緑 / 国道級=青
  const layers: mapboxgl.AnyLayer[] = [
    // 道路番号(ref)。線に沿って配置＋常に正立(viewport)＝ヘディングアップでも読める。高速/国道で色分け。
    {
      id: "ob-road-ref", type: "symbol", source: "ob-roads", minzoom: 8,
      layout: {
        "symbol-placement": "line", "text-rotation-alignment": "viewport", "text-pitch-alignment": "viewport",
        "text-field": ["get", "ref"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 14, 14],
        "symbol-spacing": 260, "text-padding": 4, "text-max-angle": 40,
      },
      paint: { "text-color": REF_COLOR, "text-halo-color": "#ffffff", "text-halo-width": 2.2 },
    } as unknown as mapboxgl.AnyLayer,
    // 地名(市区町村 locality)。点ラベル=既定で正立。z7〜・大きめ・優先(先に配置＝地区より勝つ)。
    {
      id: "ob-place", type: "symbol", source: "ob-places", minzoom: 7,
      filter: ["==", ["get", "kind"], "locality"],
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 12, 11, 15, 15, 19],
        "text-max-width": 7, "text-anchor": "center", "symbol-sort-key": ["-", 0, ["get", "pop"]],
      },
      paint: { "text-color": "#2a2824", "text-halo-color": "#ffffff", "text-halo-width": 1.9 },
    } as unknown as mapboxgl.AnyLayer,
    // 駅ドット(station)。z11〜・鉄道色の小円＝一目で駅と分かる。
    {
      id: "ob-poi-station-dot", type: "circle", source: "ob-pois", minzoom: 11,
      filter: ["==", ["get", "cat"], "station"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 4.5],
        "circle-color": "#c0392b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
      },
    } as unknown as mapboxgl.AnyLayer,
    // 駅名(station)。z11.5〜・鉄道色・ドットの上。市区町村の次に優先。
    {
      id: "ob-poi-station", type: "symbol", source: "ob-pois", minzoom: 11.5,
      filter: ["==", ["get", "cat"], "station"],
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 11, 15, 14],
        "text-anchor": "top", "text-offset": [0, 0.5], "text-max-width": 7, "text-padding": 4,
      },
      paint: { "text-color": "#a3281b", "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
    } as unknown as mapboxgl.AnyLayer,
    // 地区(macrohood)。z11.5〜・中くらい・控えめ色。
    {
      id: "ob-place-hood", type: "symbol", source: "ob-places", minzoom: 11.5,
      filter: ["!=", ["get", "kind"], "locality"],
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 11, 15, 14],
        "text-max-width": 6, "text-anchor": "center", "text-padding": 6,
      },
      paint: { "text-color": "#5a5648", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
    } as unknown as mapboxgl.AnyLayer,
    // 団地・施設名など(pois town)。z12.5〜・chomeに無い名称の補完。
    {
      id: "ob-poi-town", type: "symbol", source: "ob-pois", minzoom: 12.5,
      filter: ["==", ["get", "cat"], "town"],
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 10.5, 15, 13],
        "text-max-width": 6, "text-anchor": "center", "text-padding": 5,
      },
      paint: { "text-color": "#6b6656", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    } as unknown as mapboxgl.AnyLayer,
    // 全町丁目(国交省 位置参照情報・約9万点)。z13〜・最も密＝最後(最低優先)に配置しcollisionで自動間引き。
    {
      id: "ob-chome", type: "symbol", source: "ob-chome", minzoom: 13,
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 16, 13.5],
        "text-max-width": 6, "text-anchor": "center", "text-padding": 4,
      },
      paint: { "text-color": "#6b6656", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    } as unknown as mapboxgl.AnyLayer,
  ];
  for (const l of layers) if (!map.getLayer(l.id)) map.addLayer(l);
}

/** オフライン基図の pmtiles が両方キャッシュ済み（＝圏外で使える準備ができている）か。 */
export async function isOfflineBasemapReady(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  for (const s of OFFLINE_SOURCES) {
    if (!(await caches.match(s.url))) return false;
  }
  return true;
}

/** オンライン中に pmtiles を「全体(200)」でキャッシュに温める（圏外で 206 スライス配信できるように）。
 *  既にキャッシュ済みなら何もしない（ダウンロードは一度きり）。 */
export async function warmOfflineBasemapCache(): Promise<{ warmed: string[]; skipped: string[] }> {
  const warmed: string[] = [];
  const skipped: string[] = [];
  if (typeof caches === "undefined") return { warmed, skipped };
  for (const s of OFFLINE_SOURCES) {
    try {
      const hit = await caches.match(s.url);
      if (hit) { skipped.push(s.id); continue; }
      if (!navigator.onLine) { skipped.push(s.id); continue; }
      const r = await fetch(s.url); // Range無し=200全体 → SWのCacheFirstが保存
      if (r.ok) { await r.arrayBuffer(); warmed.push(s.id); }
    } catch { /* 無視（次回オンライン時に再試行） */ }
  }
  // ラベル群(地名/道路番号/駅/町丁目)も同時に温める。precache に載せず準備時DL＝全ユーザーへの負担を避ける。
  for (const url of OFFLINE_LABEL_URLS) {
    try {
      const hit = await caches.match(url);
      if (hit) { skipped.push(url); continue; }
      if (!navigator.onLine) { skipped.push(url); continue; }
      const r = await fetch(url);
      if (r.ok) { await r.arrayBuffer(); warmed.push(url); }
    } catch { /* 無視 */ }
  }
  return { warmed, skipped };
}
