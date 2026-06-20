import { useCallback, useEffect, useState } from "react";
import type { Shop } from "./types";
import type { NavApp } from "./nav";

const K = {
  favs: "crm_favs",
  navApp: "crm_navapp",
  safety: "crm_safety_ack",
  theme: "crm_theme", // "light" | "dark" | "auto"
  driving: "crm_driving",
  autoDrive: "crm_autodrive",
};

/** 並び順が変わっても壊れない安定キー（placeId優先、無ければ座標丸め） */
export function shopKey(s: Shop): string {
  return s.placeId ?? `${s.name}@${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過等は無視 */
  }
}

/** お気に入り（安定キーの集合） */
export function useFavorites() {
  const [favs, setFavs] = useState<Set<string>>(
    () => new Set(read<string[]>(K.favs, []))
  );
  useEffect(() => {
    write(K.favs, [...favs]);
  }, [favs]);

  const toggle = useCallback((s: Shop) => {
    const key = shopKey(s);
    setFavs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const isFav = useCallback((s: Shop) => favs.has(shopKey(s)), [favs]);

  const importKeys = useCallback((keys: unknown[]) => {
    const valid = (Array.isArray(keys) ? keys : [])
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .slice(0, 5000);
    setFavs((prev) => new Set([...prev, ...valid]));
  }, []);

  return { favs, toggle, isFav, importKeys };
}

/** 運転モードの永続化（PWA再起動でも維持） */
export function useDriving(): [boolean, (v: boolean) => void] {
  const [driving, setDrivingState] = useState<boolean>(() =>
    read<boolean>(K.driving, false)
  );
  const set = useCallback((v: boolean) => {
    setDrivingState(v);
    write(K.driving, v);
  }, []);
  return [driving, set];
}

/** 「移動検知で自動走行モード」設定の永続化 */
export function useAutoDrive(): [boolean, (v: boolean) => void] {
  const [auto, setAuto] = useState<boolean>(() =>
    read<boolean>(K.autoDrive, false)
  );
  const set = useCallback((v: boolean) => {
    setAuto(v);
    write(K.autoDrive, v);
  }, []);
  return [auto, set];
}

export function useNavApp(): [NavApp | null, (a: NavApp) => void] {
  const [app, setApp] = useState<NavApp | null>(() =>
    read<NavApp | null>(K.navApp, null)
  );
  const set = useCallback((a: NavApp) => {
    setApp(a);
    write(K.navApp, a);
  }, []);
  return [app, set];
}

export function useSafetyAck(): [boolean, (v: boolean) => void] {
  const [ack, setAck] = useState<boolean>(() => read<boolean>(K.safety, false));
  const set = useCallback((v: boolean) => {
    setAck(v);
    write(K.safety, v);
  }, []);
  return [ack, set];
}

export type ThemePref = "light" | "dark" | "auto";

/** テーマ。autoはprefers-color-schemeに追従（自前日照計算はしない） */
export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (p: ThemePref) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(() =>
    read<ThemePref>(K.theme, "auto")
  );
  const [sysDark, setSysDark] = useState<boolean>(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const resolved: "light" | "dark" =
    pref === "auto" ? (sysDark ? "dark" : "light") : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    write(K.theme, p);
  }, []);
  return { pref, resolved, setPref };
}

/** お気に入りのJSONバックアップ（書き出し） */
export function exportFavorites(favs: Set<string>): void {
  const blob = new Blob([JSON.stringify({ version: 1, favs: [...favs] }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chiba-ramen-favorites.json";
  a.click();
  URL.revokeObjectURL(url);
}
