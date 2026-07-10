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

// ラベル用フォント: 同梱の Noto Sans(Protomaps・オープン)。public/fonts/ に 0-255/256-511/8192-8447 を同梱し
// precache＝圏外でも即取得できレース無し。★Mapbox配信フォントは非同期取得が不安定でタイル描画をブロックしたため同梱に切替。
// CJK(日本語)は map の localIdeographFontFamily で端末フォント描画＝CJKグリフの配信は不要。
const OB_FONT = ["DIN Pro Medium", "Arial Unicode MS Bold"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NAME: any = ["coalesce", ["get", "name:ja"], ["get", "name"]];
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
    // glyphs は Mapbox 配信(SWRキャッシュ)。CJKは localIdeographFontFamily で端末描画。
    glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
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
    // ラベル層（地名/道路番号/道路名）。glyphは同梱(precache)なので確実に配置される。
    const LABELS: mapboxgl.AnyLayer[] = [
      // 道路番号(ref)。ヘディングアップでも読めるよう常に正立(viewport)。線に沿って配置。z10〜
      { id: `${s.id}-road-ref`, type: "symbol", source: s.id, "source-layer": "roads", minzoom: 10, filter: ["all", ["has", "ref"], ["!=", ["get", "ref"], ""]], layout: { "symbol-placement": "line", "text-rotation-alignment": "viewport", "text-field": ["get", "ref"], "text-font": OB_FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 13], "symbol-spacing": 240 }, paint: { "text-color": "#1a56c4", "text-halo-color": "#ffffff", "text-halo-width": 1.6 } } as unknown as mapboxgl.AnyLayer,
      // 道路名(通り名)。道なり(map揃え=既定)。z13〜
      { id: `${s.id}-road-name`, type: "symbol", source: s.id, "source-layer": "roads", minzoom: 13, filter: ["all", ["has", "name"], ["!", ["has", "ref"]]], layout: { "symbol-placement": "line", "text-field": NAME, "text-font": OB_FONT, "text-size": 11, "symbol-spacing": 280 }, paint: { "text-color": "#4a4a4a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } } as unknown as mapboxgl.AnyLayer,
      // 地名(places)。点ラベル=既定で正立(viewport)＝ヘディングアップでも水平で読める。
      { id: `${s.id}-place`, type: "symbol", source: s.id, "source-layer": "places", layout: { "text-field": NAME, "text-font": OB_FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 8, 12, 12, 14, 15, 17], "text-anchor": "center", "text-max-width": 7 }, paint: { "text-color": "#2a2a2a", "text-halo-color": "#ffffff", "text-halo-width": 1.8 } } as unknown as mapboxgl.AnyLayer,
    ];
    // ★ラベル(symbol)層はam2222カスタムソースと相性が悪く、タイル描画をブロックするため現状は外す(幾何のみ)。
    //   安定してラベルまで出すには MapLibre 移行が必要（symbol/pmtiles描画が本流）。LABELSは将来用に保持。
    void LABELS;
    for (const l of L) add(l);
  }
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
  return { warmed, skipped };
}
