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

/** 移動検知: 有効中に高精度GPSで監視し、「停止→確かな走り出し」を検知したら onMove を呼ぶ。
 *  速度判定: GPS提供の coords.speed を優先。iOSは測位が低精度だと speed=null を返すため
 *  高精度(enableHighAccuracy)で取得し、それでも null の時だけ高精度フィックスの変位から推定
 *  （dt>=2秒＋精度<=30mに限定して位置ジャンプ由来の誤検知を抑制）。
 *  誤発火対策: 最初の1フィックス＋約4秒は判定しない／停止状態から>3.3m/s(約12km/h)が連続2回で発火。
 *  `?debug=1` で速度・状態を画面に表示（実機での原因切り分け用）。 */
export function useMovementDetector(enabled: boolean, onMove: () => void) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator) || !window.isSecureContext) return;

    const DEBUG =
      new URLSearchParams(window.location.search).get("debug") === "1";
    let dbg: HTMLDivElement | null = null;
    if (DEBUG) {
      dbg = document.createElement("div");
      dbg.style.cssText =
        "position:fixed;left:8px;top:8px;z-index:99999;background:rgba(0,0,0,.78);color:#fff;font:700 12px/1.4 monospace;padding:6px 10px;border-radius:8px;pointer-events:none;white-space:pre";
      dbg.textContent = "🔎 移動検知: 測位待ち…";
      document.body.appendChild(dbg);
    }

    const startedAt = performance.now();
    let firstFixSeen = false;
    let wasStopped = true;
    let movingStreak = 0;
    let prev: { lat: number; lng: number; t: number } | null = null;

    const id = navigator.geolocation.watchPosition(
      (p) => {
        const cur = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          t: p.timestamp,
        };
        const acc = p.coords.accuracy;
        // 速度: GPS提供値を優先、無ければ高精度時のみ変位から推定（dt>=2秒・精度<=30m）
        let sp =
          p.coords.speed != null && !Number.isNaN(p.coords.speed)
            ? p.coords.speed
            : null;
        let src = sp == null ? "-" : "gps";
        if (sp == null && prev) {
          const dt = (cur.t - prev.t) / 1000;
          if (dt >= 2 && (acc == null || acc <= 30)) {
            sp = (haversineKm(prev, cur) * 1000) / dt;
            src = "calc";
          }
        }
        prev = cur;

        const grace = performance.now() - startedAt < 4000;
        if (dbg) {
          const kmh = sp == null ? "—" : (sp * 3.6).toFixed(0);
          dbg.textContent = `🔎 検知中 ${kmh}km/h (${src})\n精度±${
            acc == null ? "?" : Math.round(acc)
          }m / 連続${movingStreak} / 停止${wasStopped ? "✓" : "×"}${
            grace ? "\n起動安定待ち…" : ""
          }`;
        }

        if (!firstFixSeen) {
          firstFixSeen = true;
          return;
        }
        if (grace) return;
        if (sp == null) return;

        if (sp < 1.0) {
          wasStopped = true;
          movingStreak = 0;
        } else if (sp > 3.3) {
          // 約12km/h超。停止状態から連続2回続いたら走り出しと判定
          movingStreak += 1;
          if (wasStopped && movingStreak >= 2) {
            wasStopped = false;
            movingStreak = 0;
            if (dbg) dbg.textContent = "🔎 走り出し検知 → 走行モードへ";
            onMoveRef.current();
          }
        } else {
          // 徐行・GPS揺れの中間速度ではストリークを進めない
          movingStreak = 0;
        }
      },
      () => {
        if (dbg) dbg.textContent = "🔎 位置情報を取得できません（許可を確認）";
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
    );
    return () => {
      navigator.geolocation.clearWatch(id);
      dbg?.remove();
    };
  }, [enabled]);
}
