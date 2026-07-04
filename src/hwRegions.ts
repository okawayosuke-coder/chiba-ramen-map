// 全国化: 高速データの地方ブロック オンデマンド読込。
// 同梱データ(public/直下)は従来どおり関東のみ(=base bbox)。現在地やルートが関東の外に出たとき、
// 該当する地方ブロック(public/regions/<key>/ の highways-geom / highway / surface-geom)を取得して
// 各モジュールへ追記マージする。プリキャッシュはせず(vite.config globIgnores)、SWのランタイム
// キャッシュ(CacheFirst)で一度取れた地方はオフライン再訪可。地域定義はデータ生成側
// (scripts/build-region.mjs)と同じ src/data/hw-regions.json ＝単一の正。
import regionsCfg from "./data/hw-regions.json";
import { mergeHighwayGeom } from "./highwayGeom";
import { mergeHighway } from "./highwayData";
import { mergeSurfaceGeom } from "./surfaceGeom";

type BBox = [number, number, number, number]; // s,w,n,e
const BASE = regionsCfg.base as BBox;
const REGIONS = regionsCfg.regions as Record<string, { bbox: number[]; label?: string }>;

const inBox = (b: BBox | number[], lat: number, lng: number) =>
  lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3];

/** 点が同梱(関東)範囲外なら、その点を含む地方ブロックのキー。関東内・どのブロックにも無ければ null。 */
export function regionOf(lat: number, lng: number): string | null {
  if (inBox(BASE, lat, lng)) return null;
  for (const [k, r] of Object.entries(REGIONS)) if (inBox(r.bbox, lat, lng)) return k;
  return null;
}

/** 経路座標列([lat,lng])が必要とする地方ブロック（関東外のみ・重複なし）。長経路は約200点に間引いて判定。 */
export function regionsForCoords(coords: [number, number][]): string[] {
  const out = new Set<string>();
  if (!coords.length) return [];
  const step = Math.max(1, Math.floor(coords.length / 200));
  for (let i = 0; i < coords.length; i += step) {
    const k = regionOf(coords[i][0], coords[i][1]);
    if (k) out.add(k);
  }
  const last = coords[coords.length - 1];
  const lk = regionOf(last[0], last[1]);
  if (lk) out.add(lk);
  return [...out];
}

const loaded = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>();
const RETRY_MS = 60_000; // 取得失敗(圏外/未生成404等)のクールダウン。走行中に毎フィックス連打しない

async function fetchRegion(key: string): Promise<boolean> {
  const base = `${import.meta.env.BASE_URL}regions/${key}/`;
  const get = async (f: string) => {
    const r = await fetch(base + f);
    if (!r.ok) throw new Error(`${f} ${r.status}`);
    return r.json();
  };
  // 3ファイル揃ってからマージ（片方だけ届いて判定が偏るのを避ける）
  const [geom, fac, surf] = await Promise.all([
    get("highways-geom.json"),
    get("highway.json"),
    get("surface-geom.json"),
  ]);
  const ch = await Promise.all([mergeHighwayGeom(geom), mergeHighway(fac), mergeSurfaceGeom(surf)]);
  return ch.some(Boolean);
}

/** 指定ブロックを（未取得なら）取得してマージ。データが増えたら true＝呼び出し側は再判定/再構築する。 */
export async function ensureRegions(keys: string[]): Promise<boolean> {
  let changed = false;
  for (const key of keys) {
    if (!REGIONS[key] || loaded.has(key)) continue;
    const f = failedAt.get(key);
    if (f && Date.now() - f < RETRY_MS) continue;
    let p = inflight.get(key);
    if (!p) {
      p = fetchRegion(key)
        .then((ch) => {
          loaded.add(key);
          failedAt.delete(key);
          return ch;
        })
        .catch(() => {
          failedAt.set(key, Date.now());
          return false;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
    }
    if (await p) changed = true;
  }
  return changed;
}
