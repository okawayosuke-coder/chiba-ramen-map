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
import { bearingDeg, fmtDistance, haversineKm, roughMinutes, type Pt } from "../nav";
import { reverseAddressNoBanchi } from "../geocode";
import { fetchPois, poiBrandStyle, type BBox } from "../poi";
import { addTrackPoint, getTrackPoints, subscribeTrack } from "../track";

type DestRef = { lat: number; lng: number; name: string } | null;

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

/** デバッグ時のみ地図インスタンスを window に露出（?debug=1） */
function DebugExpose() {
  const map = useMap();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("debug") === "1") {
      (window as unknown as { __map?: unknown }).__map = map;
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

/** 現在地が取得/更新されたら地図をそこへ移動 */
function UserFocus({ pos }: { pos: Pt | null }) {
  const map = useMap();
  useEffect(() => {
    if (pos)
      map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 13), {
        duration: 0.6,
      });
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

    const onMove = (e: L.LeafletMouseEvent) => {
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

    const box = L.DomUtil.create("div", "follow-box");
    box.textContent = "🧭 走行モード（測位中…）";
    map.getContainer().appendChild(box);

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
      marker.setLatLng([latitude, longitude]);
      // 走行軌跡を記録（約20mごと。track側で間引き・永続化）
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
          if (txt)
            txt.textContent = `${dst.name}　残り ${fmtDistance(dkm)}・約${roughMinutes(dkm)}分`;
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
      if (first) {
        map.setView([latitude, longitude], 16, { animate: true });
        first = false;
      } else {
        map.panTo([latitude, longitude], { animate: true, duration: 0.5 });
      }
      if (DEBUG) {
        dbg();
        return;
      }
      const kmh = sp != null ? Math.round(sp * 3.6) : null;
      // 5km/h以上で「走行中」、それ未満（0含む）は「停車」
      const moving = kmh != null && kmh >= 5;
      box.textContent =
        (moving ? "🧭 走行中" : "🅿️ 停車") +
        (kmh != null ? ` ・ ${kmh} km/h` : "") +
        (accuracy ? ` ・ ±${Math.round(accuracy)}m` : "");
    };
    const onErr = () => {
      box.textContent = "🧭 位置情報を取得できません（許可を確認）";
    };
    const watchId = navigator.geolocation.watchPosition(onFix, onErr, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });

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
    const SPACING = 24; // 画面上の最小間隔(px)
    const iconCache = new Map<number, L.DivIcon>();
    const iconFor = (deg: number): L.DivIcon => {
      const k = (Math.round(deg / 10) * 10) % 360; // 10°刻みでキャッシュ
      let ic = iconCache.get(k);
      if (!ic) {
        ic = L.divIcon({
          className: "",
          html: `<svg width="16" height="16" viewBox="0 0 16 16" class="trk-tri" style="transform:rotate(${k}deg)"><path d="M8 1.5 L13.5 14 L8 11 L2.5 14 Z" fill="#e8590c" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        iconCache.set(k, ic);
      }
      return ic;
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
          icon: iconFor(deg),
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

/** コンビニ/ガソリンスタンドを表示範囲ぶん表示（ラーメンピンとは別レイヤー）。
 *  z14未満は非表示、bboxキャッシュ＋最小間隔でOverpassへの過剰アクセスを抑制。
 *  走行モードでも moveend ごとに呼ばれるが、キャッシュ内・間隔内は即returnで通信しない。 */
function PoiLayer({ show }: { show: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!show) return;
    const MINZOOM = 14;
    const MIN_INTERVAL = 4000; // 同一APIへの最小間隔(ms)
    const MAX = 500; // 1回の最大表示数

    const group = L.layerGroup().addTo(map);
    const hint = L.DomUtil.create("div", "poi-hint");
    hint.textContent = "🏪 ズームすると周辺のコンビニ・GSを表示";
    hint.style.display = "none";
    map.getContainer().appendChild(hint);

    // ブランド別アイコン（色＋識別文字）。同一スタイルは使い回す
    const iconCache = new Map<string, L.DivIcon>();
    const iconFor = (kind: "conv" | "fuel", label: string): L.DivIcon => {
      const st = poiBrandStyle(kind, label);
      const key = `${kind}|${st.bg}|${st.t}`;
      let ic = iconCache.get(key);
      if (!ic) {
        const shape = kind === "conv" ? "poi--conv" : "poi--fuel";
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

    let cached: BBox | null = null;
    let lastReqAt = 0;
    let aborted = false;

    const expand = (b: BBox, f: number): BBox => {
      const dy = (b.n - b.s) * f;
      const dx = (b.e - b.w) * f;
      return { s: b.s - dy, w: b.w - dx, n: b.n + dy, e: b.e + dx };
    };
    const inside = (o: BBox, i: BBox) =>
      i.s >= o.s && i.w >= o.w && i.n <= o.n && i.e <= o.e;

    const refresh = async () => {
      if (map.getZoom() < MINZOOM) {
        group.clearLayers();
        cached = null;
        hint.style.display = "";
        return;
      }
      hint.style.display = "none";
      const bd = map.getBounds();
      const view: BBox = {
        s: bd.getSouth(),
        w: bd.getWest(),
        n: bd.getNorth(),
        e: bd.getEast(),
      };
      if (cached && inside(cached, view)) return; // 既取得範囲内→通信しない
      const now = performance.now();
      if (now - lastReqAt < MIN_INTERVAL) return; // 過剰アクセス抑制
      lastReqAt = now;
      const area = expand(view, 0.4); // 余白付きで取得し再取得頻度を下げる
      try {
        const pois = await fetchPois(area);
        if (aborted) return;
        cached = area;
        if (
          new URLSearchParams(window.location.search).get("debug") === "1"
        ) {
          (window as unknown as { __poiDebug?: unknown }).__poiDebug = pois.map(
            (p) => ({ label: p.label, kind: p.kind, st: poiBrandStyle(p.kind, p.label) })
          );
        }
        group.clearLayers();
        pois.slice(0, MAX).forEach((p) => {
          L.marker([p.lat, p.lng], {
            icon: iconFor(p.kind, p.label),
            keyboard: false,
          })
            .bindTooltip(p.label, { direction: "top", offset: [0, -12] })
            .addTo(group);
        });
      } catch {
        /* レート制限等は黙ってスキップ（次のmoveendで再試行） */
      }
    };

    map.on("moveend zoomend", refresh);
    refresh();
    return () => {
      aborted = true;
      map.off("moveend zoomend", refresh);
      group.remove();
      hint.remove();
    };
  }, [show, map]);
  return null;
}

interface Props {
  shops: Shop[];
  focus: Shop | null;
  theme: "light" | "dark";
  follow: boolean;
  paneHidden: boolean;
  showPoi: boolean;
  showTrack: boolean;
  dest: Shop | null;
  onSetDest: (s: Shop) => void;
  userPos: Pt | null;
  isFav: (s: Shop) => boolean;
  onToggleFav: (s: Shop) => void;
  onNav: (s: Shop) => void;
  onShare: (s: Shop) => void;
  distanceTo: (s: Shop) => number | null;
}

function RamenMap({
  shops,
  focus,
  theme,
  follow,
  paneHidden,
  showPoi,
  showTrack,
  dest,
  onSetDest,
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

  const icons = useMemo(() => {
    const cache = new Map<string, L.DivIcon>();
    return (rating: number) => {
      const key = rating.toFixed(1);
      if (!cache.has(key)) cache.set(key, pinIcon(rating));
      return cache.get(key)!;
    };
  }, []);

  const tile =
    theme === "dark"
      ? {
          url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        }
      : {
          url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        };

  return (
    <MapContainer className="map" center={[35.55, 140.18]} zoom={10} scrollWheelZoom>
      <TileLayer key={theme} attribution={tile.attribution} url={tile.url} maxZoom={19} />
      <FocusController focus={focus} />
      <UserFocus pos={userPos} />
      <ElevationProbe />
      <FollowController active={follow} destRef={destRef} />
      <ResizeOnChange dep={paneHidden} />
      <PoiLayer show={showPoi} />
      <TrackLayer show={showTrack} />
      <DestMarker dest={dest ? { lat: dest.lat, lng: dest.lng } : null} />
      <DebugExpose />

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
                      🚗 ナビ開始
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
                    <button className="act" onClick={() => onSetDest(s)}>
                      🎯 目的地
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

/** 右下に地図スケール（メートル法）を表示 */
function ScaleBar() {
  const map = useMap();
  useEffect(() => {
    const ctrl = L.control.scale({
      position: "bottomright",
      imperial: false,
      metric: true,
      maxWidth: 130,
    });
    ctrl.addTo(map);
    return () => {
      ctrl.remove();
    };
  }, [map]);
  return null;
}
