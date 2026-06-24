import type { Shop } from "./types";

export type NavApp = "google" | "apple" | "yahoo";
export interface Pt {
  lat: number;
  lng: number;
}
/** 目的地の最小形（緯度経度＋名称）。Shop も周辺POIもこれを満たすので目的地にできる。 */
export interface Dest extends Pt {
  name: string;
}

export const NAV_APP_META: Record<NavApp, { label: string; note: string }> = {
  google: { label: "Google マップ", note: "全機種で確実。徒歩・車対応" },
  apple: { label: "Apple マップ", note: "iPhone/iPad標準" },
  yahoo: { label: "Yahoo!カーナビ", note: "要アプリ（未インストール時は反応しません）" },
};

/** スキーム起動（インストール必須・起動可否を検知できない）か */
export function isSchemeApp(app: NavApp): boolean {
  return app === "yahoo";
}

export type Platform = "ios" | "android" | "pc";

export function platform(): Platform {
  const ua = navigator.userAgent;
  const iOS =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (iOS) return "ios";
  if (/Android/.test(ua)) return "android";
  return "pc";
}

/** その端末で出すナビ候補（並び順＝おすすめ順） */
export function navAppsForPlatform(): NavApp[] {
  switch (platform()) {
    case "ios":
      return ["google", "apple", "yahoo"];
    case "android":
      return ["google", "yahoo"];
    default:
      return ["google"];
  }
}

/** 単一目的地のナビURL（出発地は省略＝ナビ側の現在地に委譲） */
export function navUrl(app: NavApp, dest: Pt, name: string): string {
  const d = `${dest.lat},${dest.lng}`;
  switch (app) {
    case "apple":
      return `https://maps.apple.com/?daddr=${d}&dirflg=d`;
    case "yahoo":
      // Yahoo!カーナビは公開httpsリンクが無くカスタムスキームのみ（要アプリ）
      return `yjcarnavi://navi/select?lat=${dest.lat}&lon=${dest.lng}&name=${encodeURIComponent(
        name
      )}`;
    case "google":
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${d}&travelmode=driving`;
  }
}

/** はしご（複数経由地）URL。Googleのみ。経由地上限: モバイル3 / PC9（公式仕様） */
export function multiStopUrl(stops: Shop[]): {
  url: string;
  used: number;
  capped: boolean;
} {
  const max = platform() === "pc" ? 9 : 3; // waypoints上限（最終目的地は別枠）
  // 最終要素を destination、それ以外を waypoints に。
  const all = stops.slice(0, max + 1);
  const capped = stops.length > all.length;
  const dest = all[all.length - 1];
  const waypoints = all.slice(0, -1);
  const wp = waypoints.map((s) => `${s.lat},${s.lng}`).join("|");
  let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
  if (wp) url += `&waypoints=${encodeURIComponent(wp)}`;
  return { url, used: all.length, capped };
}

/** ナビ起動（必ずユーザータップ起点で呼ぶこと）。https=新規タブ / スキーム=遷移 */
export function launchNav(app: NavApp, dest: Pt, name: string): void {
  const url = navUrl(app, dest, name);
  if (url.startsWith("http")) window.open(url, "_blank", "noopener");
  else window.location.href = url; // カスタムスキーム
}

/** 共有（Web Share 優先、無ければクリップボード）。ユーザーが共有シートを閉じた場合は cancelled */
export async function shareNav(
  dest: Pt,
  name: string
): Promise<"shared" | "copied" | "cancelled" | "failed"> {
  const url = navUrl("google", dest, name);
  const text = `${name} へのカーナビ（千葉ラーメンMAP）`;
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text, url });
      return "shared";
    } catch (e) {
      // ユーザーがキャンセルした場合はクリップボードへ進めず終了
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // それ以外（共有非対応・失敗）はクリップボードにフォールバック
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

// iOSは方位センサー利用に許可が必要。必ずユーザー操作(タップ)内で呼ぶこと
export function requestOrientationPermission() {
  const DOE = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  if (DOE && typeof DOE.requestPermission === "function") {
    DOE.requestPermission().catch(() => {});
  }
}

/** a から b への方位（真北0°・時計回り、0〜360） */
export function bearingDeg(a: Pt, b: Pt): number {
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) -
    Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function haversineKm(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 直線距離からの目安所要（平均30km/h・道路距離ではない） */
export function roughMinutes(km: number): number {
  return Math.max(1, Math.round((km / 30) * 60));
}

export function fmtDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

/** データ対象範囲（千葉＋江東・江戸川）。現在地がここから大きく外れたら近い順は無意味 */
export const DATA_BBOX = { minLat: 34.8, maxLat: 36.15, minLng: 139.7, maxLng: 141.0 };

export function isFarFromArea(p: Pt): boolean {
  const m = 0.35; // 余白（約35km）
  return (
    p.lat < DATA_BBOX.minLat - m ||
    p.lat > DATA_BBOX.maxLat + m ||
    p.lng < DATA_BBOX.minLng - m ||
    p.lng > DATA_BBOX.maxLng + m
  );
}
