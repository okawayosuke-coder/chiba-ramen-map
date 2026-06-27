import { memo, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Shop } from "../types";
import { fmtDistance, roughMinutes, type Pt, type Dest } from "../nav";
import { fetchPois, poiBrandStyle, poiIconFile, type Poi, type PoiKind, type BBox } from "../poi";
import {
  loadLocalPois,
  coverageContains,
  localPoisInView,
  LOCAL_KINDS,
  type LocalPoiData,
} from "../poiData";
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

/** トークン解決: ビルド時 env(VITE_MAPBOX_TOKEN) → なければ localStorage(mapbox_poc_token)。
 *  PoC ページ(/mapbox-poc.html)と同一オリジンなので、PoC で入力済みのトークンを流用できる。 */
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
      properties: { idx: i, rating: s.rating, ratingText: s.rating.toFixed(1) },
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

function RamenMapbox(props: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const firstFixRef = useRef(true);
  // 日本語化した name 系レイヤーの元 text-size を保持（bigLabels トグルで戻せるように）
  const labelOrigRef = useRef<Record<string, unknown>>({});
  const [tokenMissing, setTokenMissing] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [mapReady, setMapReady] = useState(false); // POIなど「地図準備後に貼る」effectのトリガ
  // POI種類の集合が変わった時だけ再取得（配列の同一性に依存しない）
  const poiKindsKey = useMemo(() => [...props.poiKinds].sort().join(","), [props.poiKinds]);

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
    // 個別ピン＝評価で色分けした円（4.3+ ピンク / 4.1+ オレンジ / それ未満 青）
    map.addLayer({
      id: "shops-pin",
      type: "circle",
      source: "shops",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["step", ["get", "rating"], "#1c7ed6", 4.1, "#e8590c", 4.3, "#d6336c"],
        "circle-radius": 13,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
    // 評価値（白文字）
    map.addLayer({
      id: "shops-rating",
      type: "symbol",
      source: "shops",
      filter: ["!", ["has", "point_count"]],
      layout: {
        "text-field": ["get", "ratingText"],
        "text-size": 11,
        "text-allow-overlap": true,
        "text-font": ["DIN Offc Pro Bold", "Arial Unicode MS Bold"],
      },
      paint: { "text-color": "#ffffff" },
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
    map.on("click", "shops-rating", openFromFeature);
    for (const ly of ["clusters", "shops-pin", "shops-rating"]) {
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
