import { useCallback, useEffect, useState } from "react";
import { isFarFromArea, type Pt } from "./nav";

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
