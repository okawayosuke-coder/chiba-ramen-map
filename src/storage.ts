import { useCallback, useEffect, useState } from "react";
import type { Shop } from "./types";
import type { NavApp, Pt } from "./nav";
import { sunTheme } from "./sun";

const K = {
  favs: "crm_favs",
  navApp: "crm_navapp",
  safety: "crm_safety_ack",
  theme: "crm_theme", // "light" | "dark" | "auto"
  showTrack: "crm_showtrack",
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

/** 走行軌跡を地図に表示するか（既定ON） */
export function useShowTrack(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => read<boolean>(K.showTrack, true));
  const set = useCallback((v: boolean) => {
    setOn(v);
    write(K.showTrack, v);
  }, []);
  return [on, set];
}

export type ThemePref = "light" | "dark" | "auto" | "sun";

/** テーマ。auto=OS設定追従, sun=現在地の日の出/日の入り連動（pos必須・無ければOS設定にフォールバック） */
export function useTheme(pos?: Pt | null): {
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
  const [, setTick] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  // sunモードは日の出/日の入りをまたぐため数分ごとに再判定
  useEffect(() => {
    if (pref !== "sun") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 3 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [pref]);

  let resolved: "light" | "dark";
  if (pref === "light" || pref === "dark") resolved = pref;
  else if (pref === "sun")
    resolved = pos ? sunTheme(pos, new Date()) : sysDark ? "dark" : "light";
  else resolved = sysDark ? "dark" : "light"; // auto

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
