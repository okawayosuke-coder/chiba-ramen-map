import { useCallback, useEffect, useRef, useState } from "react";
import { haversineKm, isFarFromArea, type Pt } from "./nav";

/** Escキーで閉じる（モーダル用） */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);
}

export type GeoStatus =
  | "idle"
  | "loading"
  | "ok"
  | "far" // 取得できたが対象エリアから遠い
  | "denied"
  | "unavailable";

/** 現在地（単発取得・省電力）。watchPositionは使わない */
export function useGeolocation() {
  const [pos, setPos] = useState<Pt | null>(null);
  const [status, setStatus] = useState<GeoStatus>("idle");

  const request = useCallback(() => {
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      // http(LAN)やGeolocation非対応はここで弾く
      setStatus("unavailable");
      return;
    }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pt = { lat: p.coords.latitude, lng: p.coords.longitude };
        setPos(pt);
        setStatus(isFarFromArea(pt) ? "far" : "ok");
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  return { pos, status, request };
}

/** 移動検知: 有効中に低精度GPSで監視し、「停止→走り出し(約12km/h超)」を検知したら onMove を呼ぶ */
export function useMovementDetector(enabled: boolean, onMove: () => void) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator) || !window.isSecureContext) return;
    let wasStopped = true;
    let prev: { lat: number; lng: number; t: number } | null = null;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        let sp =
          p.coords.speed != null && !Number.isNaN(p.coords.speed)
            ? p.coords.speed
            : null;
        const cur = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          t: p.timestamp,
        };
        if (sp == null && prev) {
          const dt = (cur.t - prev.t) / 1000;
          if (dt > 0)
            sp =
              (haversineKm(
                { lat: prev.lat, lng: prev.lng },
                { lat: cur.lat, lng: cur.lng }
              ) *
                1000) /
              dt;
        }
        prev = cur;
        if (sp == null) return;
        if (sp < 0.8) wasStopped = true;
        else if (sp > 3.3 && wasStopped) {
          wasStopped = false;
          onMoveRef.current();
        }
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 5000, timeout: 30000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
}
