import { memo, useEffect, useMemo } from "react";
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
import { fmtDistance, roughMinutes, type Pt } from "../nav";

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
    let timer: number | undefined;
    let reqId = 0;

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
      if (!box.textContent) box.textContent = "⛰ 標高 計測中…";
      const { lat, lng } = e.latlng;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const id = ++reqId;
        const t = await fetchElevation(lat, lng);
        if (id === reqId)
          box.textContent = t ? `⛰ 標高 ${t}` : "⛰ 標高 取得不可";
      }, 280);
    };
    const onOut = () => {
      window.clearTimeout(timer);
      box.style.display = "none";
      box.textContent = "";
    };

    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
      window.clearTimeout(timer);
      box.remove();
    };
  }, [map]);
  return null;
}

/** 走行モード: watchPositionで自車を追従（DOM直接操作・再描画なし）。
 * 自車矢印=進行方向に回転 / 地図が追従 / 速度表示 / 画面常時点灯 */
function FollowController({ active }: { active: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    if (!("geolocation" in navigator) || !window.isSecureContext) return;

    const icon = L.divIcon({
      className: "",
      html: `<div class="car"><svg class="car-arrow" width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><circle cx="18" cy="18" r="15" fill="rgba(26,115,232,0.18)"/><path d="M18 4 L27 26 L18 21 L9 26 Z" fill="#1a73e8" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    const marker = L.marker(map.getCenter(), {
      icon,
      zIndexOffset: 1000,
      interactive: false,
      keyboard: false,
    }).addTo(map);

    const box = L.DomUtil.create("div", "follow-box");
    box.textContent = "🧭 走行モード（測位中…）";
    map.getContainer().appendChild(box);

    let first = true;
    // 自車の向き: 移動中はGPS進行方向、停車/低速時はコンパス(ジャイロ)
    let gpsHeading: number | null = null;
    let gpsMoving = false;
    let compassHeading: number | null = null;
    let currentRot = 0;

    const applyRotation = () => {
      const target =
        gpsMoving && gpsHeading != null
          ? gpsHeading
          : compassHeading ?? gpsHeading;
      if (target == null) return;
      const el = marker
        .getElement()
        ?.querySelector(".car-arrow") as HTMLElement | null;
      if (!el) return;
      // 最短回転（0/360跨ぎの逆回転を防ぐため連続角を保持）
      const delta = ((((target - currentRot) % 360) + 540) % 360) - 180;
      currentRot += delta;
      el.style.transform = `rotate(${currentRot}deg)`;
    };

    const onFix = (p: GeolocationPosition) => {
      const { latitude, longitude, heading, speed, accuracy } = p.coords;
      marker.setLatLng([latitude, longitude]);
      gpsMoving = speed != null && !Number.isNaN(speed) && speed > 1.5;
      if (gpsMoving && heading != null && !Number.isNaN(heading))
        gpsHeading = heading;
      applyRotation();
      if (first) {
        map.setView([latitude, longitude], 16, { animate: true });
        first = false;
      } else {
        map.panTo([latitude, longitude], { animate: true, duration: 0.5 });
      }
      const kmh =
        speed != null && !Number.isNaN(speed) ? Math.round(speed * 3.6) : null;
      box.textContent =
        "🧭 走行中" +
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

    // 画面の向き(縦/横)を取得。webkitCompassHeadingは端末の縦基準なので、画面回転分を補正する
    const screenAngle = () => {
      const so = window.screen && window.screen.orientation;
      if (so && typeof so.angle === "number") return so.angle;
      const wo = (window as unknown as { orientation?: number }).orientation;
      return typeof wo === "number" ? ((wo % 360) + 360) % 360 : 0;
    };
    // 端末のコンパス（ジャイロ/方位センサー）で向きを補正（許可は走行ボタンで取得済み）
    const onOrient = (e: DeviceOrientationEvent) => {
      const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      let h: number | null = null;
      if (
        ev.webkitCompassHeading != null &&
        !Number.isNaN(ev.webkitCompassHeading)
      )
        h = ev.webkitCompassHeading; // iOS: 真北基準の方位（端末の縦基準）
      else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
      if (h == null || Number.isNaN(h)) return;
      h = (((h - screenAngle()) % 360) + 360) % 360; // 縦/横の画面回転を補正
      compassHeading = h;
      applyRotation();
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

interface Props {
  shops: Shop[];
  focus: Shop | null;
  theme: "light" | "dark";
  follow: boolean;
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
  userPos,
  isFav,
  onToggleFav,
  onNav,
  onShare,
  distanceTo,
}: Props) {
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
      <FollowController active={follow} />

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

      <Legend />
    </MapContainer>
  );
}

export default memo(RamenMap);

function Legend() {
  const map = useMap();
  useEffect(() => {
    const ctrl = new L.Control({ position: "bottomright" });
    ctrl.onAdd = () => {
      const div = L.DomUtil.create("div", "legend");
      div.innerHTML = `
        <div style="font-weight:700;margin-bottom:2px">ピンの数字＝Google評価</div>
        <div><i style="background:#d6336c"></i>★4.3以上</div>
        <div><i style="background:#e8590c"></i>★4.1〜4.2</div>
        <div><i style="background:#1c7ed6"></i>★3.9〜4.0</div>`;
      return div;
    };
    ctrl.addTo(map);
    return () => {
      ctrl.remove();
    };
  }, [map]);
  return null;
}
