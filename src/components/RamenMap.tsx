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
import { fetchPois, poiBrandStyle, type BBox, type Poi, type PoiKind } from "../poi";
import {
  loadLocalPois,
  coverageContains,
  localPoisInView,
  LOCAL_KINDS,
  type LocalPoiData,
} from "../poiData";
import { fetchRoute, routeProvider } from "../route";
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
      // 復帰用に最新の自車位置・方位を保持
      lastCarLat = latitude;
      lastCarLng = longitude;
      lastCarHd = gpsMoving ? gpsHeading : null;
      if (first) {
        map.setView([latitude, longitude], 16, { animate: true });
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

/** 目的地までの道なりルートを描画（現在地→目的地）。出発点は現在地に追従し、約0.6km以上動いたら再ルート。
 *  OSMベースのルーティングAPI（route.ts）で経路ジオメトリ＋距離/所要を取得し、青線＋左上ボックスに表示。 */
function RouteLayer({ to }: { to: Pt | null }) {
  const map = useMap();
  const toKey = to ? `${to.lat.toFixed(5)},${to.lng.toFixed(5)}` : "";
  useEffect(() => {
    if (!to) return;
    let aborted = false;
    let watchId: number | null = null;
    let lastOrigin: Pt | null = null;
    const line = L.polyline([], {
      color: "#1a73e8",
      weight: 6,
      opacity: 0.7,
      interactive: false,
    }).addTo(map);
    const box = L.DomUtil.create("div", "route-box");
    box.textContent = "🛣 現在地を取得中…";
    map.getContainer().appendChild(box);
    const attr = `経路: ${routeProvider}`;
    map.attributionControl?.addAttribution(attr);

    const route = (from: Pt) => {
      box.textContent = "🛣 経路を計算中…";
      fetchRoute(from, to).then((r) => {
        if (aborted) return;
        if (!r) {
          box.textContent = "🛣 経路を取得できませんでした";
          return;
        }
        line.setLatLngs(r.coords);
        box.textContent = `🛣 ${r.km.toFixed(1)}km ・ 約${r.min}分（道なり）`;
      });
    };
    const onPos = (p: GeolocationPosition) => {
      const here = { lat: p.coords.latitude, lng: p.coords.longitude };
      // 初回、または前回ルート起点から約0.6km以上動いたら再ルート（API負荷を抑制）
      if (!lastOrigin || haversineKm(lastOrigin, here) > 0.6) {
        lastOrigin = here;
        route(here);
      }
    };
    if ("geolocation" in navigator && window.isSecureContext) {
      watchId = navigator.geolocation.watchPosition(
        onPos,
        () => {
          if (!aborted && !lastOrigin)
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
    };
  }, [toKey, map]);
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
function PoiLayer({ kinds }: { kinds: PoiKind[] }) {
  const map = useMap();
  // 配列の同一性に依存せず、種類の集合が変わった時だけ effect を貼り直す
  const kindsKey = useMemo(() => [...kinds].sort().join(","), [kinds]);
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

    // ブランド別アイコン（色＋識別文字）。同一スタイルは使い回す
    const iconCache = new Map<string, L.DivIcon>();
    const iconFor = (kind: PoiKind, label: string): L.DivIcon => {
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
    let lastLocal: Poi[] = []; // 直近の表示範囲内の同梱POI（コンビニ/GS）
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

    const draw = () => {
      const picked = capPick([...lastLocal, ...lastLive]);
      group.clearLayers();
      picked.forEach((p) => {
        L.marker([p.lat, p.lng], {
          icon: iconFor(p.kind, p.label),
          keyboard: false,
        })
          .bindTooltip(p.label, { direction: "top", offset: [0, -12] })
          .addTo(group);
      });
      shown = true;
      if (DEBUG) {
        (window as unknown as { __poiDebug?: unknown }).__poiDebug = picked.map(
          (p) => ({ label: p.label, kind: p.kind })
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

      // 1) コンビニ/GS は同梱データから即時表示（Overpass非依存）。
      //    カバレッジ外、または同梱データ読込失敗時はライブ取得にフォールバック。
      let liveNeeded = liveOnly.slice();
      if (localActive.length) {
        if (local && coverageContains(local, view)) {
          lastLocal = localPoisInView(local, view, localActive);
        } else if (local || localLoadFailed) {
          lastLocal = [];
          liveNeeded = liveNeeded.concat(localActive);
        }
        // それ以外（読込中）は一時的に何も出さない（読込後に再描画）
      }

      // 2) ライブ取得対象の種類が変わったらキャッシュ破棄
      const liveKey = [...liveNeeded].sort().join(",");
      if (liveKey !== lastLiveKey) {
        cachedLive = null;
        lastLive = [];
        lastLiveKey = liveKey;
      }

      draw(); // 同梱POIを即描画（ライブは到着後に再描画）

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
  dest: Shop | null;
  onSetDest: (s: Shop) => void;
  onClearDest: () => void;
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
  follow,
  paneHidden,
  poiKinds,
  showTrack,
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

  return (
    <MapContainer className="map" center={[35.55, 140.18]} zoom={10} scrollWheelZoom>
      <TileLayer attribution={tile.attribution} url={tile.url} maxZoom={19} />
      <FocusController focus={focus} />
      <UserFocus pos={userPos} />
      <ElevationProbe />
      <FollowController active={follow} destRef={destRef} />
      <ResizeOnChange dep={paneHidden} />
      <PoiLayer kinds={poiKinds} />
      <TrackLayer show={showTrack} />
      <DemoFit />
      <DestMarker dest={dest ? { lat: dest.lat, lng: dest.lng } : null} />
      <RouteLayer to={dest ? { lat: dest.lat, lng: dest.lng } : null} />
      <ClearDestControl active={!!dest} onClear={onClearDest} />
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
