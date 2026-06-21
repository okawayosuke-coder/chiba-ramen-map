import { useCallback, useEffect, useRef, useState } from "react";
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

/** 移動検知: 有効中にGPSで監視し、「停止→確かな走り出し」を検知したら onMove を呼ぶ。
 * 誤発火対策:
 *  - 起動直後（最初のフィックス＋約4秒）は判定しない（測位の安定待ち）
 *  - 判定にはGPS提供の速度(coords.speed)のみを使用。変位から速度を推定すると
 *    低精度測位の位置ジャンプで誤検知するため使わない（速度が無い時は何もしない＝安全側）
 *  - 「停止状態」から速度しきい値超えが連続2回続いて初めて発火（一過性のノイズを無視） */
export function useMovementDetector(enabled: boolean, onMove: () => void) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator) || !window.isSecureContext) return;
    const startedAt = performance.now();
    let firstFixSeen = false;
    let wasStopped = true;
    let movingStreak = 0;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        // 起動直後は測位が暴れやすい。最初の1フィックスと最初の約4秒は判定しない
        if (!firstFixSeen) {
          firstFixSeen = true;
          return;
        }
        if (performance.now() - startedAt < 4000) return;

        const sp =
          p.coords.speed != null && !Number.isNaN(p.coords.speed)
            ? p.coords.speed
            : null;
        if (sp == null) return; // 速度が取れない時は判定しない（誤検知回避）

        if (sp < 1.0) {
          wasStopped = true;
          movingStreak = 0;
        } else if (sp > 3.3) {
          // 約12km/h超。停止状態から連続2回続いたら走り出しと判定
          movingStreak += 1;
          if (wasStopped && movingStreak >= 2) {
            wasStopped = false;
            movingStreak = 0;
            onMoveRef.current();
          }
        } else {
          // 徐行・GPS揺れの中間速度ではストリークを進めない
          movingStreak = 0;
        }
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 2000, timeout: 30000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
}
