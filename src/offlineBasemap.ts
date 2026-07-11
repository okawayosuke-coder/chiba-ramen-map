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
const LABEL_LANDMARKS_URL = `${BASE}offline-basemap/labels-landmarks.json`; // 神社/寺/城(OSM)
const LABEL_POI_URL = `${BASE}offline-basemap/labels-poi.json`; // 施設POI(給油/コンビニ/駐車場/道の駅/役所/山/ダム/温泉ほか・OSM)
// 準備(warm)時にまとめてキャッシュするラベル群。pmtiles と同じく圏外準備でDLし、precache には載せない(全ユーザーへの負担回避)。
export const OFFLINE_LABEL_URLS = [LABEL_PLACES_URL, LABEL_ROADS_URL, LABEL_POIS_URL, LABEL_CHOME_URL, LABEL_LANDMARKS_URL, LABEL_POI_URL];
// ランドマーク種別色（神社=朱/寺=紫/城=茶）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LM_COLOR: any = ["match", ["get", "cat"], "shrine", "#c65b3c", "temple", "#7a5aa0", "castle", "#6b5b3a", "#777777"];

// 施設POIの種別色。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const POI_COLOR: any = ["match", ["get", "cat"],
  "fuel", "#e8802b", "convenience", "#2aa198", "michinoeki", "#2f9e44",
  "supermarket", "#d9770b", "hospital", "#e03131", "townhall", "#3b5ba5", "post", "#d6336c",
  "police", "#4263eb", "onsen", "#e8590c", "museum", "#7048e8", "viewpoint", "#66a80f",
  "peak", "#846358", "dam", "#1c7ed6", "camp", "#37b24d", "#888888"];
// 表示ティア(minzoomで密度制御)。KEY=大きな目印を早め / MID=拡大で / DENSE=最拡大でのみ(コンビニ)。
// ★駐車場(parking)は件数25万超でiPadのメモリ枯渇クラッシュの主因だったため除外。
const POI_KEY = ["michinoeki", "townhall", "hospital", "peak", "dam", "onsen"];
const POI_MID = ["fuel", "supermarket", "post", "police", "museum", "viewpoint", "camp"];
const POI_DENSE = ["convenience"];

// ラベル用フォント: 同梱の Noto Sans Regular(Protomaps basemaps-assets・オープン)。public/fonts/ に 0-255/256-511 を
// 同梱し precache＝圏外でも確実に取得できレース無し。★以前の失敗の真因=ラベル用フォントスタックのグリフが
// オンライン時にキャッシュされず、圏外で mapbox:// グリフ取得が失敗して symbol 描画が壊れていた。同梱で解消。
// CJK(日本語の地名)は map の localIdeographFontFamily で端末フォント描画＝CJKグリフの配信は不要。道路番号はラテンで 0-255 に収まる。
const OB_FONT = ["Noto Sans Regular"];
// 幾何の主要道路(高速/幹線)強調フィルタ。現状は道路を白系のみで描画(強調オフ)＝ユーザーが慣れた見た目を維持。
// ※Protomapsのフィールドは `kind`。強調を有効化するなら ["get","kind"] に変える（medium_road込みだと黄色過多になる点に注意）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MAJOR: any = ["match", ["get", "pmap:kind"], ["highway", "major_road", "medium_road"], true, false];
// 水域のうち「線」で来る種別(河川/運河/水路)。fillで塗ると線が閉じて破片状の誤塗りになるため、fillから除外し
// 別途 line で描く。★kind は Protomaps の water レイヤーのフィールド。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WATER_LINEAR: any = ["river", "canal", "stream", "ditch", "drain"];

// 土地利用(landuse)の種別別カラー。★林/森を主役に、公園・農地・市街をメリハリのある色で塗り分ける。
// 淡い単色だと視認性が低いため種別で色を分け fill-opacity も上げる。earth 背景(#e9e5dc)の上に載る。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LANDUSE_COLOR: any = [
  "match", ["get", "kind"],
  ["wood", "forest", "scrub", "heath"], "#a3c986",              // 林・森(はっきりした緑=主役)
  ["park", "recreation_ground", "grass", "grassland", "meadow", "greenfield", "garden", "village_green", "playground"], "#c7e6a6", // 公園・草地
  ["pitch", "golf_course", "sports_centre", "stadium", "track"], "#b6df97", // 運動場・ゴルフ場
  ["farmland", "farmyard", "allotments", "orchard", "vineyard", "farm"], "#eae2be", // 農地(黄土)
  ["cemetery", "grave_yard"], "#c0d4b2",                        // 墓地
  ["residential"], "#ece7de",                                  // 住宅地(やや暖色グレー)
  ["commercial", "retail"], "#f0e2df",                         // 商業(暖色)
  ["industrial", "railway", "port", "quarry"], "#dedde6",       // 工業・鉄道(寒色グレー)
  ["hospital"], "#f2e0de",                                     // 病院
  ["school", "university", "college", "kindergarten", "library"], "#ece4d3", // 学校
  ["military"], "#e0d8c6",                                     // 軍用地
  "#e9e5dc",                                                   // 既定=earthと同色(=無着色扱い)
];

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
      { id: `${s.id}-landuse`, type: "fill", source: s.id, "source-layer": "landuse", paint: { "fill-color": LANDUSE_COLOR, "fill-opacity": 0.9 } },
      // 面の水域(海/湖/池)のみ塗る。河川/運河は線なので除外(fillが線を閉じて破片状に誤塗りするのを防ぐ)。
      { id: `${s.id}-water`, type: "fill", source: s.id, "source-layer": "water", filter: ["match", ["get", "kind"], WATER_LINEAR, false, true], paint: { "fill-color": "#a9cbe8" } },
      // 河川/運河は細い青線で描く(実河川)。
      { id: `${s.id}-water-line`, type: "line", source: s.id, "source-layer": "water", filter: ["match", ["get", "kind"], WATER_LINEAR, true, false], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#a9cbe8", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 2, 15, 4.5] } },
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
  // ★geojson の内部インデックス上限を maxzoom:12 に制限＝メモリ大幅削減(既定18は点データには過剰)。
  //   点は高ズームで詳細が増えないため、表示は z13+ で z12タイルをオーバーズームすれば十分。iPad の
  //   メモリ枯渇クラッシュ対策(大移動+ズームで落ちる不具合)。buffer も小さめにしてタイル毎の重複を減らす。
  const gj = (data: string): mapboxgl.AnySourceData => ({ type: "geojson", data, maxzoom: 12, buffer: 32 } as unknown as mapboxgl.AnySourceData);
  if (!map.getSource("ob-places")) map.addSource("ob-places", gj(LABEL_PLACES_URL));
  if (!map.getSource("ob-roads")) map.addSource("ob-roads", { type: "geojson", data: LABEL_ROADS_URL, maxzoom: 12 } as unknown as mapboxgl.AnySourceData);
  if (!map.getSource("ob-pois")) map.addSource("ob-pois", gj(LABEL_POIS_URL));
  if (!map.getSource("ob-chome")) map.addSource("ob-chome", gj(LABEL_CHOME_URL));
  if (!map.getSource("ob-landmarks")) map.addSource("ob-landmarks", gj(LABEL_LANDMARKS_URL));
  if (!map.getSource("ob-poi-all")) map.addSource("ob-poi-all", gj(LABEL_POI_URL));
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
    // ランドマーク(神社/寺/城)のマーカー。種別色の丸＝地図記号代わり。z11.5〜。
    {
      id: "ob-landmark-dot", type: "circle", source: "ob-landmarks", minzoom: 11.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11.5, 3, 15, 5.5],
        "circle-color": LM_COLOR, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.4,
      },
    } as unknown as mapboxgl.AnyLayer,
    // ランドマーク名。z13〜・種別色。町丁目より優先(先に配置)。
    {
      id: "ob-landmark-label", type: "symbol", source: "ob-landmarks", minzoom: 13,
      filter: ["!=", ["get", "name"], ""],
      layout: {
        "text-field": ["get", "name"], "text-font": OB_FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 16, 13],
        "text-anchor": "top", "text-offset": [0, 0.5], "text-max-width": 8, "text-padding": 4,
      },
      paint: { "text-color": LM_COLOR, "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
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
  // 施設POI(給油/コンビニ/駐車場/道の駅/役所/山/ダム/温泉ほか)。ドット=種別色マーカー(必ず表示)＋名前。
  // 密度制御: KEY(大きな目印)=早め / MID=拡大で / DENSE(コンビニ/駐車場)=最拡大でドットのみ(名前は最拡大)。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inCats = (cats: string[]): any => ["match", ["get", "cat"], cats, true, false];
  const poiDot = (id: string, cats: string[], mz: number): mapboxgl.AnyLayer => ({
    id, type: "circle", source: "ob-poi-all", minzoom: mz, filter: inCats(cats),
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], mz, 2.2, 16, 4.5], "circle-color": POI_COLOR, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2 },
  } as unknown as mapboxgl.AnyLayer);
  const poiLabel = (id: string, cats: string[], mz: number): mapboxgl.AnyLayer => ({
    id, type: "symbol", source: "ob-poi-all", minzoom: mz, filter: ["all", inCats(cats), ["has", "name"]],
    layout: { "text-field": ["get", "name"], "text-font": OB_FONT, "text-size": ["interpolate", ["linear"], ["zoom"], mz, 10, 16, 13], "text-anchor": "top", "text-offset": [0, 0.5], "text-max-width": 8, "text-padding": 4 },
    paint: { "text-color": POI_COLOR, "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
  } as unknown as mapboxgl.AnyLayer);
  // KEY/MID の「名前」は chome(町丁目) より前＝高優先で配置。ドットと DENSE は末尾(最低優先/最前面描画)。
  const chomeIdx = layers.findIndex((l) => l.id === "ob-chome");
  layers.splice(chomeIdx, 0, poiLabel("ob-poi-key-label", POI_KEY, 12), poiLabel("ob-poi-mid-label", POI_MID, 13));
  layers.push(
    poiDot("ob-poi-key-dot", POI_KEY, 11.5),
    poiDot("ob-poi-mid-dot", POI_MID, 12.5),
    poiDot("ob-poi-dense-dot", POI_DENSE, 14),
    poiLabel("ob-poi-dense-label", POI_DENSE, 15),
  );
  for (const l of layers) if (!map.getLayer(l.id)) map.addLayer(l);
}

/** オフライン基図が圏外で使える準備ができているか。★pmtiles(基図)だけでなくラベル群(地名/道路番号/
 *  駅/町丁目/ランドマーク)も全てキャッシュ済みであることを要求する。こうすることで、ラベルデータを
 *  更新した後は「準備済み」判定が自動で false に戻り、ユーザーに再準備を促せる(準備済み表示のまま
 *  ラベルだけ古い/欠ける、という分かりにくい状態を防ぐ)。 */
export async function isOfflineBasemapReady(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  for (const s of OFFLINE_SOURCES) {
    if (!(await caches.match(s.url))) return false;
  }
  for (const url of OFFLINE_LABEL_URLS) {
    if (!(await caches.match(url))) return false;
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
