import { useCallback, useEffect, useState } from "react";
import type { Shop } from "./types";
import type { NavApp, Pt } from "./nav";
import { sunTheme } from "./sun";
import { POI_KINDS, type PoiKind } from "./poi";

const K = {
  favs: "crm_favs",
  navApp: "crm_navapp",
  safety: "crm_safety_ack",
  theme: "crm_theme", // "light" | "dark" | "auto"
  showTrack: "crm_showtrack",
  poiKinds: "crm_poikinds", // 表示する周辺POIの種類
  hwOverride: "crm_hwoverride", // 高速道路切り替え: auto | on | off
  bigLabels: "crm_biglabels", // 地図の文字を大きく（テスト・2倍拡大）
};

export type HwOverride = "auto" | "on" | "off";

/** 高速道路切り替え（手動）。auto=自動判定／on=高速固定／off=一般道固定。タップで自動→高速→一般道を循環。 */
export function useHwOverride(): [HwOverride, () => void] {
  const [mode, setMode] = useState<HwOverride>(() => {
    const v = read<HwOverride>(K.hwOverride, "auto");
    return v === "on" || v === "off" || v === "auto" ? v : "auto";
  });
  const cycle = useCallback(() => {
    setMode((prev) => {
      const next: HwOverride = prev === "auto" ? "on" : prev === "on" ? "off" : "auto";
      write(K.hwOverride, next);
      return next;
    });
  }, []);
  return [mode, cycle];
}

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

/** 地図の文字を大きく（テスト・OSMタイルを2倍拡大表示）。粗くなるが地名が読みやすい。
 *  既定ON＝テスト中。設定でOFFにすれば即、通常の精細な地図に戻る。 */
export function useBigLabels(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => read<boolean>(K.bigLabels, true));
  const set = useCallback((v: boolean) => {
    setOn(v);
    write(K.bigLabels, v);
  }, []);
  return [on, set];
}

export type PoiKindsUpdater = PoiKind[] | ((prev: PoiKind[]) => PoiKind[]);

/** 表示する周辺POIの種類（既定: コンビニ・GSのみ。駐車場/EV/トイレは任意でON）。
 *  不正値や未知の種類は除去し、表示順を POI_KINDS に揃える。
 *  setter は更新関数も受け付ける（連続トグルでの取りこぼし防止）。 */
export function usePoiKinds(): [PoiKind[], (k: PoiKindsUpdater) => void] {
  const [kinds, setKinds] = useState<PoiKind[]>(() => {
    const raw = read<unknown[]>(K.poiKinds, ["conv", "fuel"]);
    const valid = (Array.isArray(raw) ? raw : []).filter(
      (k): k is PoiKind => typeof k === "string" && (POI_KINDS as string[]).includes(k)
    );
    return POI_KINDS.filter((k) => valid.includes(k));
  });
  useEffect(() => {
    write(K.poiKinds, kinds);
  }, [kinds]);
  const set = useCallback((next: PoiKindsUpdater) => {
    setKinds((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      return POI_KINDS.filter((k) => resolved.includes(k));
    });
  }, []);
  return [kinds, set];
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
