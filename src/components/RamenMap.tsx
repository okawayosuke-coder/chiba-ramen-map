import { memo, useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Tooltip,
  useMap,
} from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import type { Shop } from "../types";
import { bearingDeg, fmtDistance, haversineKm, roughMinutes, type Pt, type Dest } from "../nav";
import { reverseAddressNoBanchi } from "../geocode";
import { fetchPois, poiBrandStyle, poiIconFile, type BBox, type Poi, type PoiKind } from "../poi";
import {
  loadLocalPois,
  coverageContains,
  localPoisInView,
  LOCAL_KINDS,
  type LocalPoiData,
} from "../poiData";
import { fetchRoute, routeProvider } from "../route";
import { loadHighway, type HwKind, type HwFacility } from "../highwayData";
import type { HwOverride } from "../storage";
import {
  addTrackPoint,
  getTrackPoints,
  subscribeTrack,
  type TrackPoint,
} from "../track";

type DestRef = { lat: number; lng: number; name: string } | null;

// 速度別カラー（走行軌跡・スピードメーターで共通）。
// 不明/停車=灰, <10=赤(渋滞), <30=黄, <50=緑, それ以上=青
function kmhColor(kmh: number | null): string {
  if (kmh == null) return "#868e96";
  if (kmh < 10) return "#e03131";
  if (kmh < 30) return "#f5b800";
  if (kmh < 50) return "#2f9e44";
  return "#1c7ed6";
}

function rawTierColor(rating: number): string {
  if (rating >= 4.3) return "#d6336c";
  if (rating >= 4.1) return "#e8590c";
  return "#1c7ed6";
}

function pinIcon(rating: number): L.DivIcon {
  const color = rawTierColor(rating);
  const w = 34,
    h = 44;
  const html = `<div class="pin-marker">
    <svg width="${w}" height="${h}" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1C8.7 1 2 7.7 2 16c0 10.5 15 27 15 27s15-16.5 15-27C32 7.7 25.3 1 17 1z"
        fill="${color}" stroke="#fff" stroke-width="2"/>
      <circle cx="17" cy="16" r="11" fill="#fff"/>
      <text x="17" y="20.5" text-anchor="middle" font-size="11" font-weight="800"
        fill="${color}" font-family="Helvetica, Arial, sans-serif">${rating.toFixed(1)}</text>
    </svg>
  </div>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -h + 6],
    tooltipAnchor: [0, -h + 6], // ピン頭上にツールチップ
  });
}

const userIcon = L.divIcon({
  className: "",
  html: `<div class="userloc"><div class="userloc__dot"></div></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** デバッグ/走行シミュ時に地図インスタンスを window に露出（?debug=1 または ?sim=drive）。
 *  sim時にも出すことで、速度計を消すdebugを使わずに eval から経路へ自車を載せて検証できる。 */
function DebugExpose() {
  const map = useMap();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!(q.get("debug") === "1" || q.get("sim") === "drive")) return;
    const w = window as unknown as Record<string, unknown>;
    w.__map = map;
    if (q.get("sim") !== "drive") return;

    // 経路追従ドライブ（テスト用）。simは本来「進行方位へ直進」で道路カーブを無視するため、
    // 自車を現在の経路ポリライン（=高速本線にスナップ済み）に沿って進ませ、指定区間を
    // 「キチンと道なりに走行する状況」を再現・確認できるようにする。
    const Rm = 6371000;
    type LL = { lat: number; lng: number };
    const hav = (a: LL, b: LL) => {
      const dLat = ((b.lat - a.lat) * Math.PI) / 180,
        dLng = ((b.lng - a.lng) * Math.PI) / 180,
        la1 = (a.lat * Math.PI) / 180,
        la2 = (b.lat * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
      return 2 * Rm * Math.asin(Math.sqrt(h));
    };
    const brg = (a: LL, b: LL) => {
      const y = Math.sin(((b.lng - a.lng) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
      const x =
        Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
        Math.sin((a.lat * Math.PI) / 180) *
          Math.cos((b.lat * Math.PI) / 180) *
          Math.cos(((b.lng - a.lng) * Math.PI) / 180);
      return (Math.atan2(y, x) * 180) / Math.PI;
    };
    let path: LL[] = [],
      cum: number[] = [],
      total = 0,
      posM = 0,
      timer: number | null = null;
    const sim = () => w.__sim as { set: (a: number, b: number, c?: number) => void; speed: (k: number) => number } | undefined;
    const findLine = (): LL[] | null => {
      let pts: LL[] | null = null;
      map.eachLayer((l: unknown) => {
        const ly = l as { options?: { color?: string }; getLatLngs?: () => LL[] };
        if (ly.options && ly.options.color === "#0b57d0" && ly.getLatLngs) pts = ly.getLatLngs();
      });
      return pts;
    };
    const load = () => {
      const pts = findLine();
      if (!pts || pts.length < 2) return false;
      // 経路全体を確定保存（走行中はトリムで表示線が縮むため、満線をここで取り込む）
      path = pts.map((p) => ({ lat: p.lat, lng: p.lng }));
      cum = [0];
      total = 0;
      for (let i = 1; i < path.length; i++) {
        total += hav(path[i - 1], path[i]);
        cum.push(total);
      }
      posM = 0;
      return true;
    };
    const at = (m: number) => {
      m = Math.max(0, Math.min(total, m));
      let i = 1;
      while (i < cum.length && cum[i] < m) i++;
      const p0 = path[i - 1],
        p1 = path[i] || path[i - 1];
      const seg = cum[i] - cum[i - 1] || 1,
        t = (m - cum[i - 1]) / seg;
      return { lat: p0.lat + (p1.lat - p0.lat) * t, lng: p0.lng + (p1.lng - p0.lng) * t, hd: (brg(p0, p1) + 360) % 360 };
    };
    const apply = (m: number, speedKmh: number) => {
      const a = at(m);
      const s = sim();
      if (s) {
        s.speed(speedKmh);
        s.set(a.lat, a.lng, a.hd);
      }
      return a;
    };
    w.__driveRoute = {
      // 現在の経路を取り込む（走行開始前に1回）。区間長(km)を返す。
      load: () => (load() ? +(total / 1000).toFixed(2) : "no route line"),
      lengthKm: () => +(total / 1000).toFixed(2),
      // 区間の指定km地点へジャンプ（静止確認用）。speedKmhは速度計表示用。
      seekKm: (km: number, speedKmh = 100) => {
        if (!path.length && !load()) return "no route";
        posM = km * 1000;
        const a = apply(posM, speedKmh);
        return { km: +(posM / 1000).toFixed(2), lat: +a.lat.toFixed(5), lng: +a.lng.toFixed(5), hd: Math.round(a.hd) };
      },
      // 経路に沿って自動走行（ブラウザ前面でなめらかに動く。指定速度km/h）。
      start: (speedKmh = 100, fps = 8) => {
        if (!path.length && !load()) return "no route";
        const stepM = speedKmh / 3.6 / fps;
        if (timer) window.clearInterval(timer);
        timer = window.setInterval(() => {
          posM += stepM;
          if (posM >= total) {
            posM = total;
            if (timer) window.clearInterval(timer);
            timer = null;
          }
          apply(posM, speedKmh);
        }, 1000 / fps);
        return `driving ${speedKmh}km/h（停止: __driveRoute.stop()）`;
      },
      stop: () => {
        if (timer) {
          window.clearInterval(timer);
          timer = null;
        }
        return "stopped";
      },
    };

    // URLだけで自動走行（コンソール不要で「動いている状態」を観察）。
    // 例: ?sim=drive&simstart=35.6877,140.2410&driveto=35.7822,140.3518&speed=100&autodrive=1
    if (q.get("autodrive") === "1") {
      const dt = (q.get("driveto") || "").split(",").map(Number);
      const sp = Math.max(20, Math.min(150, Number(q.get("speed")) || 100));
      const dr = w.__driveRoute as { load: () => number | string; start: (k: number) => unknown };
      window.setTimeout(() => {
        if (dt.length === 2 && isFinite(dt[0]) && isFinite(dt[1])) {
          const sd = w.__setDest as ((a: number, b: number, c?: string) => void) | undefined;
          if (sd) sd(dt[0], dt[1], "自動走行");
        }
        const iv = window.setInterval(() => {
          if (typeof dr.load() === "number") {
            window.clearInterval(iv);
            dr.start(sp);
          }
        }, 600);
        window.setTimeout(() => window.clearInterval(iv), 20000);
      }, 3000); // アプリ初期化＋走行モード移行を待つ
    }
  }, [map]);
  return null;
}

function FocusController({ focus }: { focus: Shop | null }) {
  const map = useMap();
  useEffect(() => {
    if (focus)
      map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), 15), {
        duration: 0.6,
      });
  }, [focus, map]);
  return null;
}

// 地図の表示状態(中心+縮尺)を記憶。アプリを開いた時に前回の表示で復元する。
const VIEW_KEY = "crm_mapview";
type SavedView = { center: [number, number]; zoom: number };
function getSavedView(): SavedView | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (
      v &&
      isFinite(v.lat) &&
      isFinite(v.lng) &&
      isFinite(v.z) &&
      v.z >= 3 &&
      v.z <= 19
    )
      return { center: [v.lat, v.lng], zoom: v.z };
  } catch {
    /* 破損値は無視 */
  }
  return null;
}
function getSavedZoom(): number | null {
  return getSavedView()?.zoom ?? null;
}
function saveView(map: L.Map): void {
  try {
    const c = map.getCenter();
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), z: map.getZoom() })
    );
  } catch {
    /* 容量超過等は無視 */
  }
}

/** ユーザー操作による地図の移動/ズームを記憶（次回起動時に位置+縮尺を復元）。 */
function ViewMemory() {
  const map = useMap();
  useEffect(() => {
    const save = () => saveView(map);
    map.on("moveend zoomend", save);
    return () => {
      map.off("moveend zoomend", save);
    };
  }, [map]);
  return null;
}

/** 現在地が取得/更新されたら地図をそこへ移動。初回センタリングは前回の縮尺を復元。 */
function UserFocus({ pos }: { pos: Pt | null }) {
  const map = useMap();
  const firstRef = useRef(true);
  useEffect(() => {
    if (!pos) return;
    // 初回は記憶した縮尺を復元（無ければ最低13）。2回目以降は現在のズームを維持。
    const z = firstRef.current
      ? getSavedZoom() ?? Math.max(map.getZoom(), 13)
      : Math.max(map.getZoom(), 13);
    firstRef.current = false;
    map.flyTo([pos.lat, pos.lng], z, { duration: 0.6 });
  }, [pos, map]);
  return null;
}

/** 標高取得: 国土地理院DEM(高精度)を主、open-meteoを予備に */
async function fetchElevation(lat: number, lng: number): Promise<string | null> {
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
    const r = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`
    );
    const j = await r.json();
    if (j && Array.isArray(j.elevation) && j.elevation[0] != null)
      return `${Number(j.elevation[0]).toFixed(0)} m（概算）`;
  } catch {
    /* 取得不可 */
  }
  return null;
}

/** 標高を数値(m)で返す。GSI高精度DEM→open-meteo概算の順。海域/取得不可は null。
 *  勾配計算で同一地点を何度も問い合わせるためセッション内キャッシュ（座標5桁丸め）を持つ。 */
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
      const r = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`
      );
      const j = await r.json();
      if (j && Array.isArray(j.elevation) && j.elevation[0] != null)
        val = Number(j.elevation[0]);
    } catch {
      /* 取得不可 */
    }
  }
  _eleNumCache.set(key, val);
  return val;
}

/** マウス位置の横に標高を表示（DOM直接操作・再描画なし。移動が止まったら取得） */
function ElevationProbe() {
  const map = useMap();
  useEffect(() => {
    const box = L.DomUtil.create("div", "elev-box");
    box.style.display = "none";
    map.getContainer().appendChild(box);
    let timer: number | undefined; // 標高取得のデバウンス
    let hideTimer: number | undefined; // 表示から一定時間で自動消去（タッチはmouseoutが無いため）
    let reqId = 0;

    const hide = () => {
      window.clearTimeout(timer);
      window.clearTimeout(hideTimer);
      box.style.display = "none";
      box.textContent = "";
    };

    const place = (px: number, py: number) => {
      const sz = map.getSize();
      if (px < sz.x - 150) {
        box.style.left = px + 14 + "px";
        box.style.right = "";
      } else {
        box.style.right = sz.x - px + 14 + "px";
        box.style.left = "";
      }
      if (py < sz.y - 44) {
        box.style.top = py + 14 + "px";
        box.style.bottom = "";
      } else {
        box.style.bottom = sz.y - py + 14 + "px";
        box.style.top = "";
      }
    };

    // 地図上のボタン/UIの上＋周囲 DEAD_MARGIN px は標高プローブを発火させない「不感エリア」。
    // ボタン操作のタップが地図に貫通してその地点の標高が誤表示されるのを防ぐ。
    const DEAD_MARGIN = 16;
    const UI_SELECTOR =
      ".leaflet-control,.recenter-btn,.clear-dest-btn,.hw-toggle,.follow-box,.addr-box,.dest-box,.route-box,.grade-box,.hw-strip,.poi-hint";
    const overUI = (cx: number, cy: number): boolean => {
      const cont = map.getContainer();
      const cr = cont.getBoundingClientRect();
      const els = cont.querySelectorAll(UI_SELECTOR);
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // 非表示要素はスキップ
        if (
          cx >= r.left - cr.left - DEAD_MARGIN &&
          cx <= r.right - cr.left + DEAD_MARGIN &&
          cy >= r.top - cr.top - DEAD_MARGIN &&
          cy <= r.bottom - cr.top + DEAD_MARGIN
        )
          return true;
      }
      return false;
    };

    const onMove = (e: L.LeafletMouseEvent) => {
      // 不感エリア（ボタン上/周囲）では標高を出さない
      if (overUI(e.containerPoint.x, e.containerPoint.y)) {
        hide();
        return;
      }
      place(e.containerPoint.x, e.containerPoint.y);
      box.style.display = "";
      if (!box.textContent) box.textContent = "標高 計測中…";
      const { lat, lng } = e.latlng;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const id = ++reqId;
        const t = await fetchElevation(lat, lng);
        if (id === reqId)
          box.textContent = t ? `標高 ${t}` : "標高 取得不可";
      }, 280);
      // 表示から5秒で自動消去（タッチではmouseoutが発火せず消せないため）。操作中は更新で延長
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, 5000);
    };

    map.on("mousemove", onMove);
    map.on("mouseout", hide);
    // タッチでのパン/ズーム開始時も消す（位置がずれた標高を残さない）
    map.on("dragstart zoomstart", hide);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", hide);
      map.off("dragstart zoomstart", hide);
      window.clearTimeout(timer);
      window.clearTimeout(hideTimer);
      box.remove();
    };
  }, [map]);
  return null;
}

/** 走行モード: watchPositionで自車を追従（DOM直接操作・再描画なし）。
 * 自車矢印=進行方向に回転 / 地図が追従 / 速度表示 / 画面常時点灯 */
function FollowController({
  active,
  destRef,
}: {
  active: boolean;
  destRef: React.MutableRefObject<DestRef>;
}) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    if (!("geolocation" in navigator) || !window.isSecureContext) return;

    const icon = L.divIcon({
      className: "",
      html: `<div class="car"><svg class="car-arrow" width="54" height="54" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><circle cx="18" cy="18" r="15" fill="rgba(26,115,232,0.18)"/><path d="M18 4 L27 26 L18 21 L9 26 Z" fill="#1a73e8" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>`,
      iconSize: [54, 54],
      iconAnchor: [27, 27],
    });
    const marker = L.marker(map.getCenter(), {
      icon,
      zIndexOffset: 1000,
      interactive: false,
      keyboard: false,
    }).addTo(map);
    // 自車マークの横に標高を常設表示（移動に追従）
    marker.bindTooltip("標高 …", {
      permanent: true,
      direction: "right",
      offset: [26, 0],
      className: "car-elev",
    });

    // 左下: 車のスピードメーター風（円形ダイヤル＋針＋デジタル数字）
    const box = L.DomUtil.create("div", "follow-box");
    const CX = 50, CY = 52, MAXKMH = 120;
    const ang = (kmh: number) =>
      -120 + (Math.min(Math.max(kmh, 0), MAXKMH) / MAXKMH) * 240;
    // 速度に応じた色（走行軌跡と同配色 kmhColor: <10赤/<30黄/<50緑/≥50青、停車=灰）と進捗アーク
    const R_ARC = 44;
    const speedColor = (kmh: number) => (kmh < 1 ? "#868e96" : kmhColor(kmh));
    const arcPath = (kmh: number) => {
      const a0 = ((ang(0) - 90) * Math.PI) / 180;
      const a1 = ((ang(kmh) - 90) * Math.PI) / 180;
      const p0 = `${(CX + R_ARC * Math.cos(a0)).toFixed(2)} ${(CY + R_ARC * Math.sin(a0)).toFixed(2)}`;
      const p1 = `${(CX + R_ARC * Math.cos(a1)).toFixed(2)} ${(CY + R_ARC * Math.sin(a1)).toFixed(2)}`;
      const large = ang(kmh) - ang(0) > 180 ? 1 : 0;
      return `M ${p0} A ${R_ARC} ${R_ARC} 0 ${large} 1 ${p1}`;
    };
    let ticks = "";
    for (let v = 0; v <= 120; v += 20) {
      const a = ((ang(v) - 90) * Math.PI) / 180;
      const x1 = (CX + 33 * Math.cos(a)).toFixed(1);
      const y1 = (CY + 33 * Math.sin(a)).toFixed(1);
      const x2 = (CX + 40 * Math.cos(a)).toFixed(1);
      const y2 = (CY + 40 * Math.sin(a)).toFixed(1);
      ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8a929c" stroke-width="1.3"/>`;
      if (v % 40 === 0) {
        const lx = (CX + 25 * Math.cos(a)).toFixed(1);
        const ly = (CY + 25 * Math.sin(a) + 3).toFixed(1);
        ticks += `<text x="${lx}" y="${ly}" font-size="11.5" font-weight="700" fill="#cdd3da" text-anchor="middle">${v}</text>`;
      }
    }
    box.innerHTML =
      `<svg class="speedo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${CX}" cy="${CY}" r="40" fill="rgba(255,255,255,0.04)" stroke="#3a424c" stroke-width="2"/>` +
      `<path class="speedo-arc" d="" fill="none" stroke="#868e96" stroke-width="3.6" stroke-linecap="round"/>` +
      ticks +
      `<g class="speedo-needle" transform="rotate(${ang(0)} ${CX} ${CY})"><line x1="${CX}" y1="${CY}" x2="${CX}" y2="16" stroke="#ff6b35" stroke-width="2.6" stroke-linecap="round"/></g>` +
      `<circle cx="${CX}" cy="${CY}" r="3.6" fill="#ff6b35"/>` +
      `<text class="speedo-num" x="${CX}" y="80" font-size="30" font-weight="800" fill="#fff" text-anchor="middle">0</text>` +
      `<text x="${CX}" y="92" font-size="8" fill="#aeb6c0" text-anchor="middle">km/h</text>` +
      `</svg><div class="speedo-status">測位中…</div>`;
    map.getContainer().appendChild(box);
    const needleEl = box.querySelector(".speedo-needle");
    const numEl = box.querySelector(".speedo-num");
    const arcEl = box.querySelector(".speedo-arc");
    const statusEl = box.querySelector(".speedo-status");
    let targetKmh = 0;
    let dispKmh = 0;
    const speedoAnim = window.setInterval(() => {
      dispKmh += (targetKmh - dispKmh) * 0.18;
      if (Math.abs(targetKmh - dispKmh) < 0.15) dispKmh = targetKmh;
      needleEl?.setAttribute("transform", `rotate(${ang(dispKmh)} ${CX} ${CY})`);
      // 速度に応じた視覚変化: 進捗アークの伸び＋色、数値の色
      const col = speedColor(dispKmh);
      if (arcEl) {
        arcEl.setAttribute("d", dispKmh < 0.5 ? "" : arcPath(dispKmh));
        arcEl.setAttribute("stroke", col);
      }
      if (numEl) {
        numEl.textContent = String(Math.round(dispKmh));
        numEl.setAttribute("fill", dispKmh < 1 ? "#fff" : col);
      }
    }, 50);
    const updateSpeedo = (
      kmh: number | null,
      moving: boolean,
      accuracy: number | null
    ) => {
      targetKmh = kmh ?? 0;
      if (statusEl)
        statusEl.textContent =
          (moving ? "走行中" : "停車") +
          (accuracy ? ` ・ ±${Math.round(accuracy)}m` : "");
    };

    // 右上: 現在地の住所（番地を除く）をリアルタイム表示
    const addrBox = L.DomUtil.create("div", "addr-box");
    addrBox.textContent = "📍 現在地 測位中…";
    map.getContainer().appendChild(addrBox);

    // 左上(ズーム下): 目的地までの残り距離・方位（目的地セット時のみ表示）
    const destBox = L.DomUtil.create("div", "dest-box");
    destBox.style.display = "none";
    destBox.innerHTML =
      `<svg class="dest-arrow" width="20" height="20" viewBox="0 0 24 24"><path d="M12 2 L19 20 L12 15 L5 20 Z" fill="#2f9e44" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>` +
      `<span class="dest-txt"></span>`;
    map.getContainer().appendChild(destBox);

    let first = true;
    // カメラの自動追従。手動でマップをパンすると false（一時停止）、現在位置ボタンで復帰。
    let following = true;
    let lastCarLat = NaN,
      lastCarLng = NaN;
    let lastCarHd: number | null = null;
    // 自車の向き:
    //  - 走行中はGPSの進行方位(travel course)を表示（端末向き/画面回転に依存せず正確）
    //  - 走行中にGPS方位とコンパス生値の差(offset)を学習 → 停車時は (コンパス+offset)
    //  これでiOSのコンパス符号/画面向きの仕様に依存せず、走れば自動で正しい向きになる
    let gpsHeading: number | null = null;
    let gpsMoving = false;
    let rawCompass: number | null = null;
    let offset: number | null = null; // 真方位 ≒ rawCompass + offset
    let currentRot = 0;
    let lastElevPt: Pt | null = null; // 標高を取得した最後の地点
    let elevReqId = 0;
    let lastAddrPt: Pt | null = null; // 住所を取得した最後の地点
    let addrReqId = 0;

    // 自車位置の補間: GPSフィックス（約1Hz）間を毎フレーム線形補間して滑らかに動かす
    let haveFix = false;
    let dispLat = 0, dispLng = 0; // 現在の表示位置
    let fromLat = 0, fromLng = 0; // 区間始点
    let toLat = 0, toLng = 0; // 区間終点（最新フィックス）
    let segStart = 0; // 区間開始(performance.now)
    let segDur = 1000; // 区間所要(ms)＝直近フィックス間隔で適応
    let lastFixPerf = 0;
    let settled = false; // 区間到達後の毎フレーム再描画を止める（停車時の省電力）
    let rafId = 0;

    const norm = (d: number) => ((d % 360) + 360) % 360;
    const angDiff = (a: number, b: number) => (((a - b + 540) % 360) - 180); // a-b を[-180,180)

    const chooseHeading = (): number | null => {
      if (gpsMoving && gpsHeading != null) return gpsHeading;
      if (rawCompass != null)
        return offset != null ? norm(rawCompass + offset) : rawCompass;
      return gpsHeading;
    };
    const applyRotation = () => {
      const target = chooseHeading();
      if (target == null) return;
      const el = marker
        .getElement()
        ?.querySelector(".car-arrow") as HTMLElement | null;
      if (!el) return;
      currentRot += angDiff(target, currentRot); // 最短回転で連続角を更新
      el.style.transform = `rotate(${currentRot}deg)`;
    };
    // 追従カメラの中心点：進行方向へ少し先（前方を広く見せる）。方位なしなら自車位置そのもの。
    const cameraTarget = (lat: number, lng: number, hd: number | null) => {
      if (hd == null) return L.latLng(lat, lng);
      const z = map.getZoom();
      const carPt = map.project([lat, lng], z);
      const rad = (hd * Math.PI) / 180;
      const lead = map.getSize().y * 0.22;
      const aheadPt = carPt.add(
        L.point(Math.sin(rad), -Math.cos(rad)).multiplyBy(lead)
      );
      return map.unproject(aheadPt, z);
    };

    const DEBUG =
      new URLSearchParams(window.location.search).get("debug") === "1";
    const dbg = () => {
      box.textContent = `🧭 raw ${
        rawCompass == null ? "-" : Math.round(rawCompass)
      } / off ${offset == null ? "-" : Math.round(offset)} / 表示 ${Math.round(
        norm(currentRot)
      )}`;
    };

    const onFix = (p: GeolocationPosition) => {
      const { latitude, longitude, heading, speed, accuracy } = p.coords;
      // 自車位置はフィックスを「区間の終点」に設定し、rAFで補間して滑らかに動かす
      const nowPerf = performance.now();
      if (!haveFix) {
        haveFix = true;
        dispLat = fromLat = toLat = latitude;
        dispLng = fromLng = toLng = longitude;
        segStart = nowPerf;
        segDur = 1000;
        marker.setLatLng([latitude, longitude]);
      } else {
        // GPSグリッチ等の大ジャンプ(>150m)は補間せず即スナップ
        const jumpKm = haversineKm(
          { lat: dispLat, lng: dispLng },
          { lat: latitude, lng: longitude }
        );
        if (jumpKm > 0.15) {
          dispLat = fromLat = latitude;
          dispLng = fromLng = longitude;
          marker.setLatLng([latitude, longitude]); // グリッチは即スナップ（初回と挙動を揃える）
        } else {
          fromLat = dispLat;
          fromLng = dispLng;
        }
        toLat = latitude;
        toLng = longitude;
        segDur = Math.min(2500, Math.max(400, nowPerf - lastFixPerf));
        segStart = nowPerf;
      }
      lastFixPerf = nowPerf;
      settled = false;
      if (!rafId) rafId = requestAnimationFrame(animateMarker); // 停止中なら補間ループを再起動
      // 走行軌跡を記録（約50mごと。track側で間引き・永続化。実フィックス基準）
      addTrackPoint(latitude, longitude, p.timestamp);
      // 標高: 約40m以上動いたら取得し直してツールチップ更新（過剰リクエスト抑制）
      const here = { lat: latitude, lng: longitude };
      if (!lastElevPt || haversineKm(lastElevPt, here) > 0.04) {
        lastElevPt = here;
        const id = ++elevReqId;
        fetchElevation(latitude, longitude).then((t) => {
          if (id === elevReqId)
            marker.setTooltipContent(t ? `標高 ${t}` : "標高 -");
        });
      }
      // 住所(番地除く)も移動に追従して更新（約40mごと＝走行中ほぼリアルタイム）
      if (!lastAddrPt || haversineKm(lastAddrPt, here) > 0.04) {
        lastAddrPt = here;
        const aid = ++addrReqId;
        reverseAddressNoBanchi(latitude, longitude).then((a) => {
          if (aid === addrReqId)
            addrBox.textContent = a ? `📍 ${a}` : "📍 現在地 取得できません";
        });
      }
      const sp = speed != null && !Number.isNaN(speed) ? speed : null;
      gpsMoving = sp != null && sp > 1.5;
      if (gpsMoving && heading != null && !Number.isNaN(heading)) {
        gpsHeading = heading;
        // 十分な速度で進行中はGPS方位を正解とし、コンパスのoffsetを学習(低域通過)
        if (sp != null && sp > 3 && rawCompass != null) {
          const o = angDiff(heading, rawCompass);
          offset = offset == null ? o : offset + 0.3 * angDiff(o, offset);
        }
      }
      applyRotation();
      // 目的地が設定されていれば残り距離・方位（自車向きに対する相対方位）を更新
      const dst = destRef.current;
      if (dst) {
        destBox.style.display = "";
        const dkm = haversineKm(here, { lat: dst.lat, lng: dst.lng });
        const txt = destBox.querySelector(".dest-txt") as HTMLElement | null;
        const arr = destBox.querySelector(".dest-arrow") as HTMLElement | null;
        if (dkm < 0.06) {
          if (txt) txt.textContent = `まもなく到着: ${dst.name}`;
          if (arr) arr.style.visibility = "hidden";
        } else {
          // 直線距離・所要は出さない（道なりルートが正確な道路距離/時間を表示するため）。
          // 目的地名と方向矢印のみ表示。
          if (txt) txt.textContent = dst.name;
          if (arr) {
            arr.style.visibility = "";
            const rel = norm(
              bearingDeg(here, { lat: dst.lat, lng: dst.lng }) - currentRot
            );
            arr.style.transform = `rotate(${rel}deg)`;
          }
        }
      } else {
        destBox.style.display = "none";
      }
      // 復帰用に最新の自車位置・方位を保持
      lastCarLat = latitude;
      lastCarLng = longitude;
      lastCarHd = gpsMoving ? gpsHeading : null;
      if (first) {
        // 走行開始時の初回センタリング。前回使用時の縮尺を復元（無ければ16）。
        map.setView([latitude, longitude], getSavedZoom() ?? 16, { animate: true });
        first = false;
      } else if (following && (gpsMoving || haversineKm(map.getCenter(), here) > 0.02)) {
        // 追従中のみカメラを動かす。前方を広く見せる中心点（cameraTarget）へ滑らかに。
        // animate:trueなので moveend は1フィックスにつき1回＝POI/軌跡レイヤーの過剰再描画を避ける。
        // 停車中(ほぼ不動)は panTo を打たず、毎秒の moveend と微小ジッタ追従を抑える。
        map.panTo(cameraTarget(latitude, longitude, lastCarHd), {
          animate: true,
          duration: segDur / 1000,
        });
      }
      if (DEBUG) {
        dbg();
        return;
      }
      const kmh = sp != null ? Math.round(sp * 3.6) : null;
      // 5km/h以上で「走行中」、それ未満（0含む）は「停車」
      const moving = kmh != null && kmh >= 5;
      updateSpeedo(kmh, moving, accuracy);
    };
    const onErr = () => {
      box.textContent = "🧭 位置情報を取得できません（許可を確認）";
    };
    // フィックス間も自車マークを滑らかに動かす（毎フレーム線形補間）。
    // marker.setLatLng は地図イベントを発火しないので POI/軌跡レイヤーには影響しない。
    // ※ watchPosition より前に定義する（コールバックが同期的に呼ばれてもTDZにならないように）。
    const animateMarker = () => {
      if (settled) {
        rafId = 0; // 区間到達後はループ自体を停止（停車時の省電力）。次フィックスで再起動
        return;
      }
      if (haveFix) {
        const t =
          segDur > 0 ? Math.min(1, (performance.now() - segStart) / segDur) : 1;
        dispLat = fromLat + (toLat - fromLat) * t;
        dispLng = fromLng + (toLng - fromLng) * t;
        marker.setLatLng([dispLat, dispLng]);
        if (t >= 1) {
          settled = true;
          rafId = 0;
          return;
        }
      }
      rafId = requestAnimationFrame(animateMarker);
    };
    rafId = requestAnimationFrame(animateMarker);

    const watchId = navigator.geolocation.watchPosition(onFix, onErr, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });

    // 画面右の「現在位置」ボタン（手動パン中だけ表示。タップで自車へ復帰＝追従再開）
    const recBtn = L.DomUtil.create("div", "recenter-btn");
    recBtn.innerHTML = `<span aria-hidden="true">📍</span><span>現在位置</span>`;
    recBtn.style.display = "none";
    map.getContainer().appendChild(recBtn);
    L.DomEvent.disableClickPropagation(recBtn);
    L.DomEvent.on(recBtn, "click", () => {
      following = true;
      recBtn.style.display = "none";
      if (Number.isFinite(lastCarLat))
        map.panTo(cameraTarget(lastCarLat, lastCarLng, lastCarHd), {
          animate: true,
        });
    });
    // ユーザーが指でパンしたら追従を一時停止し、ボタンを出す（panTo等の自動移動では発火しない）
    const onUserPan = () => {
      if (!following) return;
      following = false;
      recBtn.style.display = "";
    };
    map.on("dragstart", onUserPan);

    // 端末のコンパス（ジャイロ/方位センサー）の生値。停車時の向きに使う（offsetで較正）
    const onOrient = (e: DeviceOrientationEvent) => {
      const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      let raw: number | null = null;
      if (
        ev.webkitCompassHeading != null &&
        !Number.isNaN(ev.webkitCompassHeading)
      )
        raw = ev.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) raw = (360 - e.alpha) % 360;
      if (raw == null || Number.isNaN(raw)) return;
      rawCompass = norm(raw);
      applyRotation();
      if (DEBUG) dbg();
    };
    window.addEventListener(
      "deviceorientationabsolute",
      onOrient as EventListener,
      true
    );
    window.addEventListener("deviceorientation", onOrient, true);

    // 画面常時点灯（iOS16.4+/Android対応。タブ復帰時に再取得）
    const nav = navigator as unknown as {
      wakeLock?: { request: (t: string) => Promise<{ release: () => void }> };
    };
    let wl: { release: () => void } | null = null;
    const reqWake = () => {
      nav.wakeLock
        ?.request("screen")
        .then((s) => {
          wl = s;
        })
        .catch(() => {});
    };
    reqWake();
    const onVis = () => {
      if (document.visibilityState === "visible") reqWake();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      cancelAnimationFrame(rafId);
      window.clearInterval(speedoAnim);
      map.off("dragstart", onUserPan);
      recBtn.remove();
      marker.remove();
      box.remove();
      addrBox.remove();
      destBox.remove();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(
        "deviceorientationabsolute",
        onOrient as EventListener,
        true
      );
      window.removeEventListener("deviceorientation", onOrient, true);
      try {
        wl?.release();
      } catch {
        /* noop */
      }
    };
  }, [active, map]);
  return null;
}

/** 左ペイン開閉などでコンテナ幅が変わった後にタイル欠けを防ぐ（アニメ後にinvalidate） */
function ResizeOnChange({ dep }: { dep: unknown }) {
  const map = useMap();
  useEffect(() => {
    // CSSトランジション(0.28s)中も数回叩いて滑らかに追従させる
    const ids = [120, 220, 320].map((ms) =>
      window.setTimeout(() => map.invalidateSize({ animate: false }), ms)
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [dep, map]);
  return null;
}

/** 走行軌跡を「進行方向を示す三角の点」で描画（imperative）。
 *  性能対策: 表示範囲内のみ・画面上で約24px間隔に間引き。ズーム/パン/軌跡更新で再構築。 */
function TrackLayer({ show }: { show: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!show) return;
    const group = L.layerGroup().addTo(map);
    const SPACING = 20; // 画面上の最小間隔(px)
    // 速度別の色: 渋滞/停止=赤, 〜30=黄, 〜50=緑, それ以上=青
    const colorForKmh = kmhColor; // 走行軌跡の速度別色（スピードメーターと共通）
    const iconCache = new Map<string, L.DivIcon>();
    const iconFor = (deg: number, color: string): L.DivIcon => {
      const k = (Math.round(deg / 10) * 10) % 360; // 10°刻みでキャッシュ
      const key = color + k;
      let ic = iconCache.get(key);
      if (!ic) {
        ic = L.divIcon({
          className: "",
          html: `<svg width="13" height="13" viewBox="0 0 16 16" class="trk-tri" style="transform:rotate(${k}deg)"><path d="M8 1.5 L13.5 14 L8 11 L2.5 14 Z" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
          iconSize: [13, 13],
          iconAnchor: [6.5, 6.5],
        });
        iconCache.set(key, ic);
      }
      return ic;
    };
    // 区間距離÷時間差から速度(km/h)を算出（GPS速度を保存していない軌跡でも色分け可能）
    const speedKmh = (i: number, pts: TrackPoint[], n: number): number | null => {
      const a = pts[i];
      const b = i + 1 < n ? pts[i + 1] : i > 0 ? pts[i - 1] : null;
      if (!b) return null;
      const dtH = Math.abs(b.t - a.t) / 3600000;
      if (dtH <= 0) return null;
      return haversineKm(a, b) / dtH;
    };
    let timer: number | undefined;
    const rebuild = () => {
      group.clearLayers();
      const pts = getTrackPoints();
      const n = pts.length;
      if (n === 0) return;
      const b = map.getBounds().pad(0.15);
      const s = b.getSouth(),
        no = b.getNorth(),
        w = b.getWest(),
        e = b.getEast();
      let lastX = 0,
        lastY = 0,
        has = false;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (p.lat < s || p.lat > no || p.lng < w || p.lng > e) continue;
        const px = map.latLngToContainerPoint([p.lat, p.lng]);
        if (has && Math.hypot(px.x - lastX, px.y - lastY) < SPACING) continue;
        lastX = px.x;
        lastY = px.y;
        has = true;
        let deg = 0;
        if (i + 1 < n) deg = bearingDeg(p, pts[i + 1]);
        else if (i > 0) deg = bearingDeg(pts[i - 1], p);
        L.marker([p.lat, p.lng], {
          icon: iconFor(deg, colorForKmh(speedKmh(i, pts, n))),
          interactive: false,
          keyboard: false,
        }).addTo(group);
      }
    };
    const onView = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(rebuild, 60); // 連続するmoveendをまとめる
    };
    map.on("moveend zoomend", onView);
    const unsub = subscribeTrack(onView);
    rebuild();
    return () => {
      map.off("moveend zoomend", onView);
      unsub();
      window.clearTimeout(timer);
      group.remove();
    };
  }, [show, map]);
  return null;
}

/** ?demo=track のとき、起動時に軌跡へ地図をフィット（動作確認用） */
function DemoFit() {
  const map = useMap();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("demo") !== "track")
      return;
    const pts = getTrackPoints();
    if (pts.length < 2) return;
    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ],
      { padding: [40, 40] }
    );
  }, [map]);
  return null;
}

/** 目的地マーカー（🎯）。imperative でクラスタ再描画を避ける */
function DestMarker({ dest }: { dest: Pt | null }) {
  const map = useMap();
  useEffect(() => {
    if (!dest) return;
    const icon = L.divIcon({
      className: "",
      html: `<div class="dest-pin">🎯</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 30],
    });
    const m = L.marker([dest.lat, dest.lng], {
      icon,
      interactive: false,
      zIndexOffset: 900,
    }).addTo(map);
    return () => {
      m.remove();
    };
  }, [dest, map]);
  return null;
}

/** 目的地までの道なりルートを描画（現在地→目的地）。現在地に追従し、走行済み区間は即トリム。
 *  経路線から一定距離(約50m)外れたら再ルートする実機ナビ同様の逸脱検知方式。
 *  OSMベースのルーティングAPI（route.ts）で経路ジオメトリ＋距離/所要を取得し、青線＋左上ボックスに表示。 */
/** 現在地 here の経路上への投影結果。 */
interface RouteProjection {
  /** 投影点から終点までの道なり残り距離(km)。 */
  remKm: number;
  /** 投影がのっているセグメント coords[segIdx]→coords[segIdx+1] の始点インデックス。 */
  segIdx: number;
  /** 経路上の最近接点（自車の道なり現在位置）。 */
  proj: Pt;
  /** 自車から経路線への垂直距離(km)。逸脱検知に使用。 */
  devKm: number;
}

/** 現在地 here を経路 coords に投影し、残り距離・最近接セグメント・投影点・逸脱距離を返す。
 *  suffix[i] = 頂点i から終点までの道路距離(km, 事前計算)。経度は cos(緯度) でスケールして平面近似。 */
function projectOnRoute(
  coords: [number, number][],
  suffix: number[],
  here: Pt
): RouteProjection {
  if (coords.length < 2) {
    const proj = coords[0] ? { lat: coords[0][0], lng: coords[0][1] } : here;
    return { remKm: 0, segIdx: 0, proj, devKm: haversineKm(here, proj) };
  }
  const cosLat = Math.cos((here.lat * Math.PI) / 180) || 1;
  const px = here.lng * cosLat;
  const py = here.lat;
  let best = Infinity;
  let bestRem = 0;
  let bestIdx = 0;
  let bestProj: Pt = here;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = coords[i][1] * cosLat;
    const ay = coords[i][0];
    const bx = coords[i + 1][1] * cosLat;
    const by = coords[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (d2 < best) {
      best = d2;
      // 投影点→頂点i+1 の道路距離 ＋ それ以降の残り
      const proj = { lat: cy, lng: cx / cosLat };
      const segEnd = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
      bestRem = haversineKm(proj, segEnd) + suffix[i + 1];
      bestIdx = i;
      bestProj = proj;
    }
  }
  return {
    remKm: bestRem,
    segIdx: bestIdx,
    proj: bestProj,
    devKm: haversineKm(here, bestProj),
  };
}

// ===== 勾配計（DEMベース）の設定 =====
const GRADE_SPACING_KM = 0.08; // 標高サンプル間隔(80m)。現在勾配の基準距離も兼ねる（短い＝瞬間性◎・カーブ◎、ノイズ±0.5%）
const GRADE_LOOK = 11; // 前方何マーク先まで見るか（80m×11＝約880m先まで予告）
const GRADE_STEEP = 8; // この先「急勾配」と警告する閾値(%)
const GRADE_FLAT = 1.5; // これ未満は「ほぼ平坦」(%)
const GRADE_MAX_PLAUSIBLE = 25; // これ超の区間勾配はDEM/経路のノイズとして無視（実道路はまず超えない）

/** 経路 coords を距離 spacingKm ごとのマーク点に分割。marks[i] は始点から i*spacingKm の地点。 */
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

function RouteLayer({
  to,
  hwOverrideRef,
}: {
  to: Pt | null;
  hwOverrideRef: React.MutableRefObject<HwOverride>;
}) {
  const map = useMap();
  const toKey = to ? `${to.lat.toFixed(5)},${to.lng.toFixed(5)}` : "";
  useEffect(() => {
    if (!to) return;
    let aborted = false;
    let watchId: number | null = null;
    let lastRouteAt = 0; // 直近に経路を取得した時刻(ms)。0=未取得
    const REROUTE_DEV_KM = 0.05; // 経路線から約50m外れたら再ルート（逸脱検知）
    const REROUTE_MIN_INTERVAL = 10000; // 連続再ルートの最小間隔(ms, API負荷抑制)
    const line = L.polyline([], {
      color: "#0b57d0", // 濃いめの青（薄くて見辛い指摘に対応。ライト/ダーク両対応）
      weight: 7,
      opacity: 0.95,
      interactive: false,
    }).addTo(map);
    const box = L.DomUtil.create("div", "route-box");
    box.textContent = "🛣 現在地を取得中…";
    map.getContainer().appendChild(box);
    const attr = `経路: ${routeProvider}`;
    map.attributionControl?.addAttribution(attr);

    // 勾配計（DEMベース）の表示ボックス（左下・速度計の上）。標高取得まで非表示。
    const gradeBox = L.DomUtil.create("div", "grade-box");
    gradeBox.style.display = "none";
    map.getContainer().appendChild(gradeBox);

    // ハイウェイモード: この先の高速施設(SA/PA/IC/JCT)を近い順に出す右ストリップ（提案書⑧）。
    // 高速走行中(onHighway)＋経路沿いに施設がある時だけ表示。
    const hwStrip = L.DomUtil.create("div", "hw-strip");
    hwStrip.style.display = "none";
    map.getContainer().appendChild(hwStrip);

    // 取得済み経路（残り距離・ETAのリアルタイム計算用）
    let rCoords: [number, number][] | null = null;
    let rSuffix: number[] = [];
    let rKm = 0;
    let rMin = 0;
    // 勾配計の状態: 経路を150m間隔に分割したマークと、その標高キャッシュ
    let marks: Pt[] = [];
    let eleAtMark: (number | null | undefined)[] = []; // undefined=未取得, null=海域/取得不可
    let lastGradePos: Pt | null = null; // 前回勾配を更新した地点（移動量スロットル用）
    let gradeReqId = 0; // 標高取得の競合排除

    // 高速道路の自動判定（速度ベース・フォールバック用）。ルート時は下記 waycategory を優先。
    // 軽自動車の低速巡航に合わせ ON≥65km/h、渋滞で誤OFFしないよう OFF は <50km/h が長く続いた時だけ。
    let onHighway = false;
    let fastCount = 0; // 連続で65km/h以上のフィックス数
    let slowCount = 0; // 連続で50km/h未満のフィックス数
    const HW_ENTER_KMH = 65;
    const HW_EXIT_KMH = 50;
    const HW_ENTER_FIXES = 8; // 約8秒
    const HW_EXIT_FIXES = 60; // 約60秒（渋滞・低速でも維持＝stickyに解除）
    const updateHighwayState = (speedKmh: number | null) => {
      if (speedKmh == null || !isFinite(speedKmh)) return; // 速度不明(トンネル等)=現状維持
      if (speedKmh >= HW_ENTER_KMH) {
        fastCount++;
        slowCount = 0;
        if (fastCount >= HW_ENTER_FIXES) onHighway = true;
      } else if (speedKmh < HW_EXIT_KMH) {
        slowCount++;
        fastCount = 0;
        if (slowCount >= HW_EXIT_FIXES) onHighway = false;
      } else {
        fastCount = 0; // 50〜65km/hの中間帯は現状維持（ヒステリシス）
        slowCount = 0;
      }
    };

    // ルートの高速/有料区間（ORS waycategory由来）。経路ベース判定で渋滞・低速でも確実。
    let hwRanges: [number, number][] = [];
    const isHwSeg = (segIdx: number) =>
      hwRanges.some(([a, b]) => segIdx >= a && segIdx < b);
    // 実効的な高速判定: 手動切替＞経路waycategory＞速度の優先順。renderGrade/updateHwStripが参照。
    let effHighway = false;
    const computeEffHighway = (segIdx: number) => {
      const ov = hwOverrideRef.current;
      if (ov === "on") return true;
      if (ov === "off") return false;
      if (hwRanges.length > 0) return isHwSeg(segIdx); // 経路に高速情報あり=速度無関係
      return onHighway; // フォールバック（GET/OSRM等で waycategory 無し）
    };

    // ===== ハイウェイモード: この先の高速施設を近い順に表示 =====
    const HW_SNAP_KM = 0.3; // 経路から300m以内の施設を「経路上」とみなす（SA/PAは施設中心が道から後退しがち）
    const HW_LOOK = 6; // 先の施設を最大6件表示
    const HW_BADGE: Record<HwKind, string> = { sa: "SA", pa: "PA", ic: "IC", jct: "JCT" };
    // SA/PA内の設備アイコン（提案書⑧「SA/PAは設備アイコン P/⛽/🍴/☕」）。OSM由来の種別→絵文字。
    const AMEN_EMOJI: Record<string, string> = {
      conv: "🏪",
      fuel: "⛽",
      food: "🍴",
      cafe: "☕",
      shop: "🛍️",
      toilet: "🚻",
      ev: "⚡",
    };
    // コンビニ/GSは地図POIと同じブランド画像で見た目判別（poiIconFileを再利用）。他は絵文字。
    const HW_ICON_BASE = `${import.meta.env.BASE_URL}poi-icons/`;
    const amenIconHtml = (a: string, f: HwFacility): string => {
      if (a === "conv") {
        const file = poiIconFile("conv", f.convBrand || ""); // 円形ブランド or generic.png
        return `<img class="hw-amen-ic hw-amen-conv" src="${HW_ICON_BASE}${file}" alt="コンビニ">`;
      }
      if (a === "fuel") {
        const file = poiIconFile("fuel", f.fuelBrand || ""); // gs-*.png（主要のみ）/ 未一致はnull
        if (file) return `<img class="hw-amen-ic hw-amen-gs" src="${HW_ICON_BASE}${file}" alt="GS">`;
      }
      return `<span class="hw-amen-em">${AMEN_EMOJI[a] || ""}</span>`;
    };
    let hwFacilities: HwFacility[] | null = null;
    // 経路にスナップした施設（始点からの道なり距離つき・昇順）
    let routeFacilities: { f: HwFacility; distKm: number }[] = [];
    const esc = (s: string) =>
      s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

    // 同梱の高速施設を経路に投影し、経路沿い(200m以内)のものを始点距離つきで昇順に整列。
    const computeRouteFacilities = () => {
      routeFacilities = [];
      if (!rCoords || !hwFacilities || rKm <= 0) return;
      let s = 90, w = 180, n = -90, e = -180;
      for (const c of rCoords) {
        if (c[0] < s) s = c[0];
        if (c[0] > n) n = c[0];
        if (c[1] < w) w = c[1];
        if (c[1] > e) e = c[1];
      }
      const M = 0.01; // bbox余白
      for (const f of hwFacilities) {
        if (f.lat < s - M || f.lat > n + M || f.lng < w - M || f.lng > e + M) continue;
        const pr = projectOnRoute(rCoords, rSuffix, { lat: f.lat, lng: f.lng });
        if (pr.devKm > HW_SNAP_KM) continue; // 経路から離れすぎ＝この経路の施設でない
        routeFacilities.push({ f, distKm: rKm - pr.remKm });
      }
      routeFacilities.sort((a, b) => a.distKm - b.distKm);
      // 同名施設は最寄り1件に集約。全角/半角・括弧・空白・方向(上り/下り)の表記ゆれを吸収して同一視。
      const baseName = (n: string) =>
        n
          .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xfee0)
          ) // 全角英数→半角
          .replace(/[\s（）()]/g, "") // 空白・全半角括弧を除去
          .replace(/(上り|下り|内回り|外回り)$/, ""); // 末尾の方向表記を除去
      const nameSeen = new Set<string>();
      routeFacilities = routeFacilities.filter((rf) => {
        const k = `${rf.f.kind}:${baseName(rf.f.name)}`;
        if (nameSeen.has(k)) return false;
        nameSeen.add(k);
        return true;
      });
    };

    // 自車の始点距離(carDistKm)を基に、前方の施設を近い順にストリップ表示。高速走行中のみ。
    const updateHwStrip = (carDistKm: number) => {
      if (!effHighway || routeFacilities.length === 0) {
        hwStrip.style.display = "none";
        return;
      }
      const ahead = routeFacilities
        .filter((rf) => rf.distKm >= carDistKm - 0.1)
        .slice(0, HW_LOOK);
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
          // SA/PAは中の設備をアイコン列で（OSMにデータがある施設のみ）。IC/JCTは無し。
          const am = rf.f.amenities;
          const amenRow =
            (rf.f.kind === "sa" || rf.f.kind === "pa") && am && am.length
              ? `<div class="hw-amen">${am
                  .map((a) => amenIconHtml(a, rf.f))
                  .join("")}</div>`
              : "";
          return (
            `<div class="hw-row hw-${rf.f.kind}">` +
            `<div class="hw-top"><span class="hw-badge">${HW_BADGE[rf.f.kind]}</span>` +
            `<span class="hw-name">${esc(rf.f.name)}</span></div>` +
            amenRow +
            `<div class="hw-dist">${dist}<small>km</small> ・ ${remMin}<small>分</small></div>` +
            `</div>`
          );
        })
        .join("");
    };

    // 同梱データを読み込み（一度だけ）。経路が既にあれば施設を再計算。
    loadHighway()
      .then((d) => {
        hwFacilities = d.facilities;
        if (rCoords) computeRouteFacilities();
      })
      .catch(() => {
        /* highway.json 無し/失敗時はストリップ非表示のまま（機能オフ） */
      });

    // 既知の標高から現在勾配＋この先の急勾配を算出して gradeBox を更新。
    const renderGrade = (cur: number, end: number, distFromStartKm: number) => {
      if (effHighway) {
        // 高速道路走行中は勾配を表示しない（トンネル=山の地表/高架=谷底でDEMが道路と乖離するため）
        gradeBox.style.display = "none";
        return;
      }
      let curGrade: number | null = null;
      for (let i = cur; i < end; i++) {
        const a = eleAtMark[i];
        const b = eleAtMark[i + 1];
        if (typeof a === "number" && typeof b === "number") {
          const gv = ((b - a) / (GRADE_SPACING_KM * 1000)) * 100;
          if (Math.abs(gv) <= GRADE_MAX_PLAUSIBLE) {
            curGrade = gv;
            break;
          }
        }
      }
      if (curGrade === null) {
        gradeBox.style.display = "none";
        return;
      }
      // この先(cur〜end)で最も急なペアを探す
      let steepGrade = 0;
      let steepDistM = -1;
      for (let i = cur; i < end; i++) {
        const a = eleAtMark[i];
        const b = eleAtMark[i + 1];
        if (typeof a === "number" && typeof b === "number") {
          const g = ((b - a) / (GRADE_SPACING_KM * 1000)) * 100;
          if (
            Math.abs(g) >= GRADE_STEEP &&
            Math.abs(g) <= GRADE_MAX_PLAUSIBLE &&
            Math.abs(g) > Math.abs(steepGrade)
          ) {
            steepGrade = g;
            steepDistM = Math.max(0, Math.round((i * GRADE_SPACING_KM - distFromStartKm) * 1000));
          }
        }
      }
      gradeBox.style.display = "";
      updateGradeMeter(
        gradeBox,
        curGrade,
        steepDistM >= 0 ? { grade: steepGrade, distM: steepDistM } : null
      );
    };

    // 自車の道なり進行距離(distFromStartKm)を基に、前方マークの標高を取得して勾配表示を更新。
    const updateGrade = (distFromStartKm: number) => {
      if (marks.length < 2) return;
      const cur = Math.min(
        Math.max(Math.round(distFromStartKm / GRADE_SPACING_KM), 0),
        marks.length - 1
      );
      const end = Math.min(cur + GRADE_LOOK, marks.length - 1);
      const need: number[] = [];
      for (let i = cur; i <= end; i++) if (eleAtMark[i] === undefined) need.push(i);
      renderGrade(cur, end, distFromStartKm); // 既知分で即描画（チラつき防止）
      if (!need.length) return;
      const reqId = ++gradeReqId;
      Promise.allSettled(
        need.map(async (i) => {
          eleAtMark[i] = await fetchElevationNum(marks[i].lat, marks[i].lng);
        })
      ).then(() => {
        if (aborted || reqId !== gradeReqId) return;
        renderGrade(cur, end, distFromStartKm);
      });
    };
    const fmtEta = (minFromNow: number): string =>
      new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(Date.now() + Math.max(0, minFromNow) * 60000));

    // 現在地を経路に投影し、残り距離・ETA表示＋走行済み区間のトリムを実施。投影結果を返す。
    const refresh = (here: Pt): RouteProjection | null => {
      if (!rCoords || rKm <= 0) return null;
      const pr = projectOnRoute(rCoords, rSuffix, here);
      if (pr.remKm < 0.08) {
        box.textContent = "🛣 まもなく到着";
      } else {
        const remMin = rMin * (pr.remKm / rKm);
        const dist =
          pr.remKm < 10 ? pr.remKm.toFixed(1) : Math.round(pr.remKm).toString();
        box.textContent = `🛣 残り ${dist}km ・ ${fmtEta(remMin)}着`;
      }
      // 走行済み区間を消す: 残り経路 = 投影点（自車の道なり現在位置）→ 以降の頂点
      line.setLatLngs([
        [pr.proj.lat, pr.proj.lng],
        ...rCoords.slice(pr.segIdx + 1),
      ]);
      // 実効的な高速判定を更新（手動＞経路waycategory＞速度）。勾配抑制・施設ストリップが参照。
      const newEff = computeEffHighway(pr.segIdx);
      if (newEff !== effHighway) lastGradePos = null; // 高速状態の変化は勾配へ即反映（throttle無視）
      effHighway = newEff;
      // 勾配計の更新（50m以上移動 or 高速状態変化時）
      if (!lastGradePos || haversineKm(here, lastGradePos) > 0.05) {
        lastGradePos = here;
        updateGrade(rKm - pr.remKm);
      }
      // ハイウェイモード: この先の高速施設を近い順に更新
      updateHwStrip(rKm - pr.remKm);
      return pr;
    };

    let lastHeading: number | null = null; // 自車の進行方位（リルートを走行方向優先にする）
    let headingPrevPos: Pt | null = null; // GPS heading非対応端末向け: 移動方向から方位を算出するフォールバック用
    const route = (from: Pt) => {
      lastRouteAt = Date.now(); // 取得開始時刻でガード（再入防止＋throttle基準）
      if (!rCoords) box.textContent = "🛣 経路を計算中…";
      fetchRoute(from, to, lastHeading).then((r) => {
        if (aborted) return;
        if (!r) {
          if (!rCoords) box.textContent = "🛣 経路を取得できませんでした";
          return;
        }
        line.setLatLngs(r.coords);
        rCoords = r.coords;
        rKm = r.km;
        rMin = r.min;
        hwRanges = r.hwRanges ?? []; // 経路の高速/有料区間（waycategory）
        // 各頂点→終点の道路距離（残り距離の高速算出用に後方累積）
        rSuffix = new Array(r.coords.length).fill(0);
        for (let i = r.coords.length - 2; i >= 0; i--) {
          rSuffix[i] =
            rSuffix[i + 1] +
            haversineKm(
              { lat: r.coords[i][0], lng: r.coords[i][1] },
              { lat: r.coords[i + 1][0], lng: r.coords[i + 1][1] }
            );
        }
        // 勾配計: 経路を150m間隔のマークに分割し標高キャッシュをリセット
        marks = buildMarks(r.coords, GRADE_SPACING_KM);
        eleAtMark = new Array(marks.length);
        lastGradePos = null;
        // ハイウェイモード: 新しい経路に沿った高速施設を再計算
        computeRouteFacilities();
        refresh(from);
      });
    };
    const onPos = (p: GeolocationPosition) => {
      const here = { lat: p.coords.latitude, lng: p.coords.longitude };
      const sp = p.coords.speed;
      const hd = p.coords.heading;
      const gpsHeadingOk = hd != null && isFinite(hd) && hd >= 0;
      if (gpsHeadingOk) lastHeading = hd; // GPS提供の進行方位（優先）
      // フォールバック: heading非対応端末は20m移動ごとに移動方向から方位を算出
      if (!headingPrevPos) {
        headingPrevPos = here;
      } else if (haversineKm(headingPrevPos, here) >= 0.02) {
        if (!gpsHeadingOk) lastHeading = bearingDeg(headingPrevPos, here);
        headingPrevPos = here;
      }
      updateHighwayState(sp != null && sp >= 0 ? sp * 3.6 : null);
      if (!rCoords) {
        // まだ経路がない: 間隔を空けて初回取得（失敗時はこの間隔で自動リトライ）
        if (Date.now() - lastRouteAt > REROUTE_MIN_INTERVAL) route(here);
        return;
      }
      const pr = refresh(here); // 毎フィックスで残り距離・ETA更新＋走行済み区間を即トリム
      // 経路線から約50m以上外れ、かつ前回取得から一定間隔が空いていれば再ルート
      if (
        pr &&
        pr.devKm > REROUTE_DEV_KM &&
        Date.now() - lastRouteAt > REROUTE_MIN_INTERVAL
      ) {
        route(here);
      }
    };
    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(
        onPos,
        () => {
          if (!aborted && !rCoords)
            box.textContent = "🛣 現在地を取得できませんでした";
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } else {
      box.textContent = "🛣 現在地が使えません";
    }
    return () => {
      aborted = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      map.attributionControl?.removeAttribution(attr);
      line.remove();
      box.remove();
      gradeBox.remove();
      hwStrip.remove();
    };
  }, [toKey, map]);
  return null;
}

/** from から進行方位 headingDeg(0=北) 方向へ distM メートル進んだ地点。 */
function pointAhead(from: Pt, headingDeg: number, distM: number): Pt {
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / 111320;
  const dLng = (distM * Math.sin(rad)) / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

// ===== 勾配メーター（傾斜計＝車が坂に乗って傾く）。文言表示の代わりに使う共通描画。 =====
type GradeMeter = { tilt: SVGElement; road: SVGElement; label: SVGElement; warn: HTMLElement };
const _gradeMeters = new WeakMap<HTMLElement, GradeMeter>();

/** box 内に傾斜計SVGを一度だけ構築して各パーツの参照を返す（以後は属性更新でなめらかにアニメ）。 */
function ensureGradeMeter(box: HTMLElement): GradeMeter {
  const cached = _gradeMeters.get(box);
  if (cached) return cached;
  box.innerHTML =
    '<svg class="grade-meter" viewBox="0 0 170 96" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="20" y1="56" x2="150" y2="56" stroke="#3a3f47" stroke-width="2" stroke-dasharray="2 5"/>' +
    '<g class="gm-tilt">' +
    '<line class="gm-road" x1="27" y1="56" x2="143" y2="56" stroke="#9aa0a6" stroke-width="6" stroke-linecap="round"/>' +
    // 軽バンの側面シルエット(右向き=前)。背の高い箱型・短い前面で軽バンらしさを出し、
    // 前=黄ヘッドライト/後=赤テールランプで前後を明示。小サイズでも判別しやすい。
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
  };
  _gradeMeters.set(box, m);
  return m;
}

/** 勾配メーターを更新。grade=現在勾配(%)、warn=この先の急勾配(任意・ルート時のみ)。 */
function updateGradeMeter(
  box: HTMLElement,
  grade: number,
  warn: { grade: number; distM: number } | null
) {
  const m = ensureGradeMeter(box);
  const flat = Math.abs(grade) < GRADE_FLAT;
  const col = flat ? "#9aa0a6" : grade > 0 ? "#EF9F27" : "#378ADD"; // 平坦灰/上り琥珀/下り青
  const labelCol = flat ? "#cdd3da" : grade > 0 ? "#FAC775" : "#85B7EB";
  const ang = flat ? 0 : Math.max(-34, Math.min(34, grade * 2.2)); // 平坦は0°、それ以外は視認性のため誇張（数値は実値）
  m.tilt.setAttribute("transform", `rotate(${(-ang).toFixed(1)} 85 56)`);
  m.road.setAttribute("stroke", col);
  const g = Math.abs(Math.round(grade));
  m.label.textContent = flat ? "0%" : grade > 0 ? `↗ ${g}%` : `↘ ${g}%`;
  m.label.setAttribute("fill", labelCol);
  if (warn) {
    m.warn.style.display = "";
    m.warn.textContent = `⚠ この先 ${warn.grade > 0 ? "↑" : "↓"}${Math.abs(
      Math.round(warn.grade)
    )}%・${warn.distM}m`;
  } else {
    m.warn.style.display = "none";
  }
}

/** ルート未設定でも「現在の道の勾配」を左下に表示する（追従走行向け）。
 *  進行方位の前方80mのDEM標高差から勾配を先読み算出（現在地→前方）＝予測的・反応が速い。
 *  ※急カーブ/つづら折れでは直線前方が道から外れ過大評価することがある（直線〜緩カーブは正確）。
 *  高速道路走行中は表示しない（DEMが道路と乖離するため。RouteLayerと同じヒステリシス判定）。
 *  ルート設定中は RouteLayer が経路に沿った先読み＋この先予告を出すので、こちらは無効（active=false）。 */
function FreeGradeLayer({
  active,
  hwOverrideRef,
}: {
  active: boolean;
  hwOverrideRef: React.MutableRefObject<HwOverride>;
}) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    let aborted = false;
    let watchId: number | null = null;
    const box = L.DomUtil.create("div", "grade-box");
    box.style.display = "none";
    map.getContainer().appendChild(box);

    // 高速道路の自動判定（速度ベース）。軽の低速巡航に合わせ ON≥65km/h、渋滞で誤OFFしないよう
    // OFF は <50km/h が約60秒続いた時だけ（sticky）。ルート無しなので waycategory は使えず速度＋手動切替。
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
    // 実効的な高速判定: 手動切替＞速度。高速なら勾配を非表示。
    const effHighway = () => {
      const ov = hwOverrideRef.current;
      return ov === "on" ? true : ov === "off" ? false : onHighway;
    };

    // 先読み設定: 進行方位の前方この距離(m)のDEMで勾配を算出。50m移動ごとに更新。
    const AHEAD_M = 80;
    const MIN_MOVE_KM = 0.05;
    let lastHeading: number | null = null;
    let lastUpdatePos: Pt | null = null;
    let prevPos: Pt | null = null; // 移動方向から方位を出すフォールバック用（GPS heading非対応端末向け）
    let reqId = 0;

    const render = (grade: number | null) => {
      if (effHighway() || grade === null) {
        box.style.display = "none";
        return;
      }
      box.style.display = "";
      updateGradeMeter(box, grade, null);
    };

    const onPos = (p: GeolocationPosition) => {
      const here = { lat: p.coords.latitude, lng: p.coords.longitude };
      const sp = p.coords.speed;
      const hd = p.coords.heading;
      const gpsHeadingOk = hd != null && isFinite(hd) && hd >= 0;
      if (gpsHeadingOk) lastHeading = hd; // GPS提供の進行方位（優先）
      // フォールバック: heading非対応/取得不可の端末は、20m移動するごとに移動方向から方位を算出
      if (!prevPos) {
        prevPos = here;
      } else if (haversineKm(prevPos, here) >= 0.02) {
        if (!gpsHeadingOk) lastHeading = bearingDeg(prevPos, here);
        prevPos = here;
      }
      updateHighwayState(sp != null && sp >= 0 ? sp * 3.6 : null);
      if (effHighway()) {
        render(null);
        return;
      }
      if (lastHeading == null) return; // 方位不明(停止中)は更新せず前回表示を維持
      if (lastUpdatePos && haversineKm(here, lastUpdatePos) < MIN_MOVE_KM) return; // 50mスロットル
      lastUpdatePos = here;
      const ahead = pointAhead(here, lastHeading, AHEAD_M);
      const id = ++reqId;
      Promise.all([
        fetchElevationNum(here.lat, here.lng),
        fetchElevationNum(ahead.lat, ahead.lng),
      ]).then(([e0, e1]) => {
        if (aborted || id !== reqId || e0 == null || e1 == null) return;
        const grade = ((e1 - e0) / AHEAD_M) * 100; // 前方80m先との標高差＝先読み勾配
        render(Math.abs(grade) <= GRADE_MAX_PLAUSIBLE ? grade : null);
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
  }, [active, map]);
  return null;
}

/** 目的地が設定されている間、地図右下（現在位置ボタンの少し下）に「✕ 目的地解除」ボタンを表示。
 *  走行中でサイドバーが隠れていても目的地を解除/変更できるようにする。 */
function ClearDestControl({
  active,
  onClear,
}: {
  active: boolean;
  onClear: () => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    const btn = L.DomUtil.create("div", "clear-dest-btn");
    btn.innerHTML = `<span aria-hidden="true">✕</span><span>目的地解除</span>`;
    map.getContainer().appendChild(btn);
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", onClear);
    return () => {
      btn.remove();
    };
  }, [active, map, onClear]);
  return null;
}

/** 高速道路切り替え（手動）ボタン。走行中に表示。タップで 自動→高速→一般道 を循環。
 *  自動が外す場面（軽の低速巡航・並走一般道・渋滞）で確実に高速判定を上書きするための手段。 */
function HighwayToggle({
  active,
  mode,
  onCycle,
}: {
  active: boolean;
  mode: HwOverride;
  onCycle: () => void;
}) {
  const map = useMap();
  const cycleRef = useRef(onCycle);
  cycleRef.current = onCycle;
  useEffect(() => {
    if (!active) return;
    const btn = L.DomUtil.create("div", "hw-toggle");
    map.getContainer().appendChild(btn);
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", () => cycleRef.current());
    return () => {
      btn.remove();
    };
  }, [active, map]);
  useEffect(() => {
    const btn = map.getContainer().querySelector(".hw-toggle") as HTMLElement | null;
    if (!btn) return;
    const label = mode === "on" ? "高速" : mode === "off" ? "一般道" : "自動";
    btn.className = `hw-toggle hw-toggle--${mode}`;
    btn.innerHTML =
      `<span class="hw-toggle__t">🛣 HW切替</span>` +
      `<span class="hw-toggle__v">${label}</span>`;
  }, [map, mode, active]);
  return null;
}

// 種類→マーカー形状クラス（色は poiBrandStyle のインライン指定）
const POI_SHAPE: Record<PoiKind, string> = {
  conv: "poi--conv",
  fuel: "poi--fuel",
  parking: "poi--parking",
  ev: "poi--ev",
  toilet: "poi--toilet",
};

/** 周辺POI（コンビニ/GS/駐車場/EV充電/トイレ）を表示範囲ぶん表示（ラーメンピンとは別レイヤー）。
 *  kinds で表示種類を切替え（空なら何も取得・表示しない）。
 *  z14未満は非表示、bboxキャッシュ＋最小間隔でOverpassへの過剰アクセスを抑制。
 *  走行モードでも moveend ごとに呼ばれるが、キャッシュ内・間隔内は即returnで通信しない。 */
function PoiLayer({
  kinds,
  onPoiDest,
  onPoiNav,
}: {
  kinds: PoiKind[];
  onPoiDest: (d: Dest) => void;
  onPoiNav: (d: Dest) => void;
}) {
  const map = useMap();
  // 配列の同一性に依存せず、種類の集合が変わった時だけ effect を貼り直す
  const kindsKey = useMemo(() => [...kinds].sort().join(","), [kinds]);
  // コールバックは ref 経由で読む（effectを貼り直さない＝POI再取得を誘発しない）
  const cbRef = useRef({ onPoiDest, onPoiNav });
  cbRef.current = { onPoiDest, onPoiNav };
  useEffect(() => {
    const active = (kindsKey ? kindsKey.split(",") : []) as PoiKind[];
    if (active.length === 0) return;
    const MINZOOM = 14;
    const MIN_INTERVAL = 4000; // 同一APIへの最小間隔(ms)
    const MAX = 600; // 1回の最大表示数

    const group = L.layerGroup().addTo(map);
    const hint = L.DomUtil.create("div", "poi-hint");
    hint.textContent = "🏪 ズームすると周辺の施設を表示";
    hint.style.display = "none";
    map.getContainer().appendChild(hint);

    // アイコン生成。コンビニ＝ブランドアイコン画像、それ以外＝色＋識別文字。同一は使い回す。
    const iconCache = new Map<string, L.DivIcon>();
    const ICON_BASE = `${import.meta.env.BASE_URL}poi-icons/`;
    const iconFor = (kind: PoiKind, label: string): L.DivIcon => {
      const file = poiIconFile(kind, label); // コンビニ＝円形画像 / GS主要＝角丸バッジ / 他＝null
      if (file) {
        const key = `img|${file}`;
        let ic = iconCache.get(key);
        if (!ic) {
          // 形状はアイコン種別で決定（gs-*=白角丸バッジ / それ以外=コンビニ円形）。
          // kindではなくファイル名で判定＝OSM誤タグ救済時もコンビニは円形で表示。
          const gs = file.startsWith("gs-");
          const sz = gs ? 32 : 30;
          const cls = gs ? "poi-img-gs" : "poi-img";
          ic = L.divIcon({
            className: "",
            html: `<div class="${cls}"><img src="${ICON_BASE}${file}" alt="" /></div>`,
            iconSize: [sz, sz],
            iconAnchor: [sz / 2, sz / 2],
          });
          iconCache.set(key, ic);
        }
        return ic;
      }
      const st = poiBrandStyle(kind, label);
      const key = `${kind}|${st.bg}|${st.t}`;
      let ic = iconCache.get(key);
      if (!ic) {
        const shape = POI_SHAPE[kind];
        const fs = st.emoji ? "14px" : st.t.length >= 2 ? "9.5px" : "12.5px";
        ic = L.divIcon({
          className: "",
          html: `<div class="poi ${shape}" style="background:${st.bg};color:${st.fg};font-size:${fs}">${st.t}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        iconCache.set(key, ic);
      }
      return ic;
    };

    let cachedLive: BBox | null = null; // ライブ取得（駐車場/EV/トイレ・県外のコンビニ/GS）のキャッシュ範囲
    let lastReqAt = 0;
    let aborted = false;
    let inFlight = false; // ライブ取得の多重リクエスト防止
    let failStreak = 0; // ライブ取得の連続失敗回数（可視化用）
    let lastLiveKey = ""; // ライブ取得対象の種類セット（変わったらキャッシュ破棄）
    let lastLocal: Poi[] = []; // 直近の表示範囲(+余白)内の同梱POI（コンビニ/GS）
    let localArea: BBox | null = null; // lastLocal を算出した範囲（抜けるまで再フィルタしない）
    let lastLive: Poi[] = []; // 直近のライブ取得POI
    let shown = false; // 現在マーカーを描画中か
    let local: LocalPoiData | null = null; // 同梱POIデータ（読込後にセット）
    let localLoadFailed = false; // 同梱データ読込失敗（=ライブにフォールバック）
    const ZOOM_HINT = "🏪 ズームすると周辺の施設を表示";
    const BUFFER = 0.7; // ライブ取得bboxの余白。大きいほど走行中に範囲を抜けにくい

    // 同梱の種類（コンビニ/GS）と、ライブのみの種類（駐車場/EV/トイレ）に分ける
    const localActive = active.filter((k) => LOCAL_KINDS.includes(k));
    const liveOnly = active.filter((k) => !LOCAL_KINDS.includes(k));
    const DEBUG =
      new URLSearchParams(window.location.search).get("debug") === "1";

    const expand = (b: BBox, f: number): BBox => {
      const dy = (b.n - b.s) * f;
      const dx = (b.e - b.w) * f;
      return { s: b.s - dy, w: b.w - dx, n: b.n + dy, e: b.e + dx };
    };
    const inside = (o: BBox, i: BBox) =>
      i.s >= o.s && i.w >= o.w && i.n <= o.n && i.e <= o.e;

    // 種類が偏っても各種類が出るよう、種類別バケットからラウンドロビンで上限まで選ぶ
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
        if (!added) break; // 全バケット出し切った
      }
      return picked;
    };

    // タップ時のポップアップ：店名＋「目的地に設定」「Googleマップ」（ラーメン店と同様）
    const popupFor = (p: Poi): HTMLElement => {
      const el = L.DomUtil.create("div", "poi-popup");
      const nm = L.DomUtil.create("div", "poi-popup__name", el);
      nm.textContent = p.label;
      const d: Dest = { lat: p.lat, lng: p.lng, name: p.label };
      const bDest = L.DomUtil.create("button", "poi-popup__btn poi-popup__btn--dest", el);
      bDest.textContent = "🎯 目的地に設定";
      const bNav = L.DomUtil.create("button", "poi-popup__btn", el);
      bNav.textContent = "🚗 Googleマップ";
      L.DomEvent.on(bDest, "click", (e) => {
        L.DomEvent.stop(e);
        map.closePopup();
        cbRef.current.onPoiDest(d);
      });
      L.DomEvent.on(bNav, "click", (e) => {
        L.DomEvent.stop(e);
        map.closePopup();
        cbRef.current.onPoiNav(d);
      });
      return el;
    };

    const draw = () => {
      const picked = capPick([...lastLocal, ...lastLive]);
      group.clearLayers();
      picked.forEach((p) => {
        L.marker([p.lat, p.lng], {
          icon: iconFor(p.kind, p.label),
          keyboard: false,
        })
          .bindTooltip(p.label, { direction: "top", offset: [0, -12] })
          .bindPopup(() => popupFor(p), { closeButton: true, autoPan: true })
          .addTo(group);
      });
      shown = true;
      if (DEBUG) {
        (window as unknown as { __poiDebug?: unknown }).__poiDebug = picked.map(
          (p) => ({ label: p.label, kind: p.kind, lat: p.lat, lng: p.lng })
        );
      }
    };

    const refresh = async () => {
      if (aborted) return;
      if (map.getZoom() < MINZOOM) {
        // 広域表示中は非表示。データ・キャッシュは保持し、ズーム復帰時に即再描画する。
        if (shown) {
          group.clearLayers();
          shown = false;
        }
        hint.textContent = ZOOM_HINT;
        hint.style.display = "";
        return;
      }
      if (hint.textContent === ZOOM_HINT) hint.style.display = "none";
      const bd = map.getBounds();
      const view: BBox = {
        s: bd.getSouth(),
        w: bd.getWest(),
        n: bd.getNorth(),
        e: bd.getEast(),
      };

      // 1) コンビニ/GS は同梱データから表示（Overpass非依存）。表示範囲を BUFFER 拡張した
      //    範囲ぶん描画し、その範囲を抜けるまで再フィルタ・再描画しない。これで走行中も
      //    画面の少し先のコンビニが先に描画され、毎フレームの全消去によるちらつきも防ぐ。
      //    カバレッジ外、または同梱データ読込失敗時はライブ取得にフォールバック。
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
        // それ以外（読込中）は一時的に何も出さない（読込後に再描画）
      }

      // 2) ライブ取得対象の種類が変わったらキャッシュ破棄
      const liveKey = [...liveNeeded].sort().join(",");
      if (liveKey !== lastLiveKey) {
        cachedLive = null;
        if (lastLive.length) {
          lastLive = [];
          changed = true;
        }
        lastLiveKey = liveKey;
      }

      // 変化があった時、またはズーム復帰で未描画の時だけ描画（不要な再描画＝ちらつきを避ける）
      if (changed || !shown) draw();

      // 3) ライブ取得（駐車場/EV/トイレ・県外のコンビニ/GS）
      if (!liveNeeded.length) return;
      if (inFlight) return;
      if (cachedLive && inside(cachedLive, view)) return; // 既取得範囲内→通信しない
      const now = performance.now();
      if (now - lastReqAt < MIN_INTERVAL) return; // 過剰アクセス抑制
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
        // ライブ取得失敗（Overpass混雑/タイムアウト）。cachedLive は更新せず自動再試行。
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

    // 同梱POIデータを読み込む（PWAでprecache＝オフライン可）。読込後/失敗後に再描画。
    if (localActive.length) {
      loadLocalPois()
        .then((d) => {
          if (aborted) return;
          local = d;
          refresh();
        })
        .catch(() => {
          if (aborted) return;
          localLoadFailed = true; // 読込失敗→以後ライブにフォールバック
          refresh();
        });
    }

    map.on("moveend zoomend", refresh);
    // 停止中やOverpassからのライブPOI復帰時にも再取得・再描画する
    const timer = window.setInterval(refresh, 5000);
    refresh();
    return () => {
      aborted = true;
      map.off("moveend zoomend", refresh);
      window.clearInterval(timer);
      group.remove();
      hint.remove();
    };
  }, [kindsKey, map]);
  return null;
}

interface Props {
  shops: Shop[];
  focus: Shop | null;
  follow: boolean;
  paneHidden: boolean;
  poiKinds: PoiKind[];
  showTrack: boolean;
  bigLabels: boolean;
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

function RamenMap({
  shops,
  focus,
  follow,
  paneHidden,
  poiKinds,
  showTrack,
  bigLabels,
  hwOverride,
  onCycleHwOverride,
  dest,
  onSetDest,
  onClearDest,
  userPos,
  isFav,
  onToggleFav,
  onNav,
  onShare,
  distanceTo,
}: Props) {
  // 目的地は走行中の高頻度更新で読むため ref で渡す（FollowControllerを再subscribeさせない）
  const destRef = useRef<DestRef>(null);
  useEffect(() => {
    destRef.current = dest
      ? { lat: dest.lat, lng: dest.lng, name: dest.name }
      : null;
  }, [dest]);

  // 高速道路切り替え（手動）も走行中の高頻度判定で読むため ref で渡す。
  const hwOverrideRef = useRef<HwOverride>(hwOverride);
  useEffect(() => {
    hwOverrideRef.current = hwOverride;
  }, [hwOverride]);

  const icons = useMemo(() => {
    const cache = new Map<string, L.DivIcon>();
    return (rating: number) => {
      const key = rating.toFixed(1);
      if (!cache.has(key)) cache.set(key, pinIcon(rating));
      return cache.get(key)!;
    };
  }, []);

  // 夜間も詳細なOSMタイルを使い、ダークはCSSフィルタ(タイルのみ)で表現。
  // → 道路・地名などの情報量を保ったまま暗くでき、暗さも調整できる（黒すぎ防止）。
  const tile = {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  };

  // 前回使用時の表示(中心+縮尺)を起動時に復元（無ければ千葉県全域 zoom10）
  const initView = useMemo(() => getSavedView(), []);

  return (
    <MapContainer
      className="map"
      center={initView ? initView.center : [35.55, 140.18]}
      zoom={initView ? initView.zoom : 10}
      scrollWheelZoom
      zoomSnap={0.5}
      zoomDelta={0.5}
    >
      {/* 文字を大きく(テスト)＝同じOSMタイルを2倍拡大(tileSize512/zoomOffset-1)。
          key切替でトグル時にレイヤーを作り直す。OFFで通常(256/0)に即戻る。 */}
      <TileLayer
        key={bigLabels ? "lbl2x" : "lbl1x"}
        attribution={tile.attribution}
        url={tile.url}
        maxZoom={19}
        tileSize={bigLabels ? 512 : 256}
        zoomOffset={bigLabels ? -1 : 0}
      />
      <FocusController focus={focus} />
      <UserFocus pos={userPos} />
      <ElevationProbe />
      <FollowController active={follow} destRef={destRef} />
      <ResizeOnChange dep={paneHidden} />
      <PoiLayer kinds={poiKinds} onPoiDest={onSetDest} onPoiNav={onNav} />
      <TrackLayer show={showTrack} />
      <DemoFit />
      <DestMarker dest={dest ? { lat: dest.lat, lng: dest.lng } : null} />
      <RouteLayer
        to={dest ? { lat: dest.lat, lng: dest.lng } : null}
        hwOverrideRef={hwOverrideRef}
      />
      <FreeGradeLayer active={!dest} hwOverrideRef={hwOverrideRef} />
      <HighwayToggle active={follow} mode={hwOverride} onCycle={onCycleHwOverride} />
      <ClearDestControl active={!!dest} onClear={onClearDest} />
      <DebugExpose />
      <ViewMemory />

      {userPos && !follow && (
        <Marker position={[userPos.lat, userPos.lng]} icon={userIcon} />
      )}

      <MarkerClusterGroup
        chunkedLoading
        maxClusterRadius={22}
        showCoverageOnHover={false}
        spiderfyOnMaxZoom
      >
        {shops.map((s, i) => {
          const km = distanceTo(s);
          return (
            <Marker
              key={s.placeId ?? `${s.lat},${s.lng},${i}`}
              position={[s.lat, s.lng]}
              icon={icons(s.rating)}
            >
              <Tooltip direction="top" offset={[0, -2]} className="pin-tip">
                {s.name}（★{s.rating.toFixed(1)}）
              </Tooltip>
              <Popup>
                <div className="popup">
                  <div className="name">{s.name}</div>
                  <div>
                    <span className="r">★ {s.rating.toFixed(1)}</span> ／ 口コミ{" "}
                    {s.reviews.toLocaleString()}件
                  </div>
                  {km != null && (
                    <div className="popup__dist">
                      📍 直線{fmtDistance(km)}・車で約{roughMinutes(km)}分（目安）
                    </div>
                  )}
                  {s.address && <div>{s.address}</div>}
                  <div className="popup__actions">
                    <button className="act act--nav" onClick={() => onNav(s)}>
                      🚗 Googleマップ
                    </button>
                    <button
                      className="act act--route"
                      onClick={() => onSetDest(s)}
                    >
                      🧭 ルート
                    </button>
                    <button
                      className={`act act--fav${isFav(s) ? " on" : ""}`}
                      onClick={() => onToggleFav(s)}
                      aria-pressed={isFav(s)}
                      aria-label={isFav(s) ? "お気に入りから削除" : "お気に入りに追加"}
                    >
                      {isFav(s) ? "★" : "☆"}
                    </button>
                    <button className="act" onClick={() => onShare(s)}>
                      共有
                    </button>
                  </div>
                  <a
                    href={s.reviewsUrl ?? s.mapsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    💬 口コミを見る →
                  </a>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>

      <ScaleBar />
    </MapContainer>
  );
}

export default memo(RamenMap);

/** 右下に地図スケール（メートル法）を表示。
 *  半段ズーム(zoomDelta=0.5)で 200m と 100m の間に 150m が出るよう、
 *  Leaflet標準の 1/2/3/5 倍に加えて 1.5・7 倍も「キリの良い数」として許可する
 *  （結果: …300m / 200m / 150m / 100m / 70m / 50m …）。 */
function ScaleBar() {
  const map = useMap();
  useEffect(() => {
    const ScaleWith150 = L.Control.Scale.extend({
      _getRoundNum(num: number) {
        const pow10 = Math.pow(10, (Math.floor(num) + "").length - 1);
        let d = num / pow10;
        d =
          d >= 10 ? 10 : d >= 7 ? 7 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : d >= 1.5 ? 1.5 : 1;
        return pow10 * d;
      },
    });
    const ctrl = new ScaleWith150({
      position: "bottomright",
      imperial: false,
      metric: true,
      maxWidth: 130,
    } as L.Control.ScaleOptions);
    ctrl.addTo(map);
    return () => {
      ctrl.remove();
    };
  }, [map]);
  return null;
}
