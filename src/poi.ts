// OpenStreetMap の POI（コンビニ / ガソリンスタンド / 駐車場 / EV充電 / トイレ）を
// Overpass API から取得する。表示範囲(bbox)ぶん・選択された種類ぶんだけ取得する。
// Overpassは共有の無料APIなので、呼び出し側でズーム制限・bboxキャッシュ・最小間隔を必ず設けること。

export type PoiKind = "conv" | "fuel" | "parking" | "ev" | "toilet";

export interface Poi {
  id: number;
  lat: number;
  lng: number;
  kind: PoiKind;
  label: string; // ブランド名 or 名称
}

export interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

export interface PoiStyle {
  bg: string;
  fg: string;
  t: string; // マーカー内の短い識別文字（不明時は絵文字）
  emoji?: boolean;
}

/** 設定UI/凡例で使う種類メタ（表示順はこの配列順） */
export const POI_KINDS: PoiKind[] = ["conv", "fuel", "parking", "ev", "toilet"];
export const POI_KIND_META: Record<PoiKind, { label: string; emoji: string }> = {
  conv: { label: "コンビニ", emoji: "🏪" },
  fuel: { label: "GS", emoji: "⛽" },
  parking: { label: "駐車場", emoji: "🅿️" },
  ev: { label: "EV充電", emoji: "⚡" },
  toilet: { label: "トイレ", emoji: "🚻" },
};

// Overpass のタグ条件（種類→ nwr フィルタ）
const KIND_FILTER: Record<PoiKind, string> = {
  conv: `["shop"="convenience"]`,
  fuel: `["amenity"="fuel"]`,
  parking: `["amenity"="parking"]`,
  ev: `["amenity"="charging_station"]`,
  toilet: `["amenity"="toilets"]`,
};

/** タグから種類を判定（取得対象外のものは null） */
function kindFromTags(t: Record<string, string>): PoiKind | null {
  if (t.shop === "convenience") return "conv";
  if (t.amenity === "fuel") return "fuel";
  if (t.amenity === "parking") return "parking";
  if (t.amenity === "charging_station") return "ev";
  if (t.amenity === "toilets") return "toilet";
  return null;
}

/** ブランド名から色＋識別文字を決める。商標保護のため公式ロゴは使わず色＋頭文字で識別。
 *  brand/name のどちらでも拾えるよう label（brand||name）に対して部分一致で判定。 */
export function poiBrandStyle(kind: PoiKind, label: string): PoiStyle {
  const s = (label || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
  switch (kind) {
    case "conv": {
      if (has("7-eleven", "7‐eleven", "seven", "セブン")) return { bg: "#ee7a00", fg: "#fff", t: "7" };
      if (has("lawson", "ローソン")) return { bg: "#0067b1", fg: "#fff", t: "L" };
      if (has("familymart", "family mart", "ファミリーマート", "ファミマ")) return { bg: "#0aa14b", fg: "#fff", t: "F" };
      if (has("ministop", "ミニストップ")) return { bg: "#f6a800", fg: "#16357a", t: "M" };
      if (has("daily", "デイリーヤマザキ", "ヤマザキ")) return { bg: "#e60012", fg: "#fff", t: "D" };
      if (has("seicomart", "seico", "セイコーマート", "セコマ")) return { bg: "#e8731c", fg: "#fff", t: "Sk" };
      if (has("newdays", "ニューデイズ")) return { bg: "#0a8a3b", fg: "#fff", t: "ND" };
      if (has("poplar", "ポプラ")) return { bg: "#1f9d55", fg: "#fff", t: "P" };
      return { bg: "#6b7280", fg: "#fff", t: "🏪", emoji: true };
    }
    case "fuel": {
      if (has("eneos", "エネオス")) return { bg: "#e60012", fg: "#fff", t: "EN" };
      if (has("idemitsu", "出光", "apollostation", "apollo")) return { bg: "#003f8e", fg: "#ffd200", t: "出" };
      if (has("cosmo", "コスモ")) return { bg: "#e8400c", fg: "#fff", t: "コ" };
      if (has("shell", "シェル")) return { bg: "#ffd400", fg: "#d2002e", t: "S" };
      if (has("kygnus", "キグナス")) return { bg: "#16639e", fg: "#fff", t: "Ky" };
      if (has("ja-ss", "jass", "ja ss", "全農", "農協")) return { bg: "#2f9e44", fg: "#fff", t: "JA" };
      return { bg: "#e8590c", fg: "#fff", t: "⛽", emoji: true };
    }
    case "parking": {
      if (has("times", "タイムズ")) return { bg: "#f7c600", fg: "#222", t: "P" };
      if (has("repark", "リパーク", "三井", "mitsui")) return { bg: "#0a7d4b", fg: "#fff", t: "P" };
      return { bg: "#2b6fd6", fg: "#fff", t: "P" };
    }
    case "ev": {
      if (has("tesla")) return { bg: "#cc0000", fg: "#fff", t: "⚡", emoji: true };
      return { bg: "#16a34a", fg: "#fff", t: "⚡", emoji: true };
    }
    case "toilet":
      return { bg: "#0e7490", fg: "#fff", t: "🚻", emoji: true };
  }
}

/** 名称(label)からコンビニブランドのアイコンを判定（種別に依存しない）。
 *  OSMで amenity=fuel 等に誤タグされた「名称はコンビニ」を救済するため切り出し。 */
function convIconByName(label: string): string | null {
  const s = (label || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
  if (has("natural lawson", "natural-lawson", "ナチュラルローソン")) return "naturallawson.png";
  if (has("lawson store 100", "lawson-store-100", "lawsonstore100", "ローソンストア100", "ローソンストア１００", "ローソン100", "store100"))
    return "lawson100.png";
  if (has("lawson", "ローソン")) return "lawson.png";
  if (has("7-eleven", "7‐eleven", "7eleven", "seven", "セブン")) return "seven.png";
  // FamilyMart は表記揺れが多い（実データ由来）: 正規「ファミリーマート」/英字/「ファミマ(!!)」/長音欠落「ファミリマート」。
  // ※「ファミリー」単体は他業態(ファミリーストア等)を誤爆するため入れない。
  if (has("familymart", "family mart", "family-mart", "famima", "ファミリーマート", "ファミリマート", "ファミマ"))
    return "familymart.png";
  if (has("ministop", "ミニストップ")) return "ministop.png";
  if (has("daily", "デイリーヤマザキ", "ヤマザキ")) return "dailyyamazaki.png";
  if (has("poplar", "ポプラ")) return "poplar.png";
  if (has("circle k", "circlek", "サークルk")) return "circlek.png";
  if (has("sunkus", "sankus", "サンクス")) return "sunkus.png";
  if (has("am/pm", "am-pm", "ampm", "エーエムピーエム")) return "ampm.png";
  if (has("newdays", "new days", "new-days", "ニューデイズ", "ニューデイズ")) return "newdays.png";
  if (has("heart in", "heart-in", "heartin", "ハートイン")) return "heartin.png";
  if (has("community store", "community-store", "コミュニティストア", "コミュニティ・ストア"))
    return "community.png";
  if (has("coco", "ここストア", "ココストア")) return "coco.png";
  return null;
}

/** POIのブランドアイコン画像ファイル名を返す（public/poi-icons/ 配下）。
 *  コンビニ(conv)＝ブランド円形アイコン（一致しなければ汎用 generic.png）。
 *  GS(fuel)＝主要ブランドのみ角丸バッジ（gs-*.png）。一致しないGSは null＝色＋文字。
 *  名称がコンビニブランドなら種別がfuel等でもコンビニアイコンを優先（OSM誤タグ救済）。
 *  返り値が "gs-" で始まればGSバッジ形状、それ以外は円形（呼び出し側で判定）。 */
export function poiIconFile(kind: PoiKind, label: string): string | null {
  const convBrand = convIconByName(label);
  if (kind === "conv") return convBrand || "generic.png";
  // conv以外でも名称がコンビニブランドなら救済（例: amenity=fuel で name=7-Eleven）
  if (convBrand) return convBrand;
  if (kind === "fuel") {
    const s = (label || "").toLowerCase();
    const has = (...keys: string[]) => keys.some((k) => s.includes(k.toLowerCase()));
    // 現役主要ブランドのみ（旧ブランドはENEOS/出光に統合済み・OSMでも現ブランド表記が大半）
    if (has("eneos", "エネオス")) return "gs-eneos.png";
    if (has("idemitsu", "出光", "apollostation", "apollo")) return "gs-idemitsu.png";
    if (has("cosmo", "コスモ")) return "gs-cosmo.png";
    if (has("kygnus", "キグナス")) return "gs-kygnus.png";
    if (has("solato", "太陽石油", "taiyo")) return "gs-solato.png";
    if (has("mitsui", "三井")) return "gs-mitsui.png";
    if (has("shell", "シェル", "昭和シェル", "昭和shell")) return "gs-shell.png";
    if (has("esso", "エッソ")) return "gs-esso.png";
    if (has("mobil", "モービル")) return "gs-mobil.png";
    if (has("usami", "宇佐美", "ウサミ")) return "gs-usami.png";
    return null; // 未一致GS（JA-SS/ホクレン/無名）は色＋文字
  }
  return null; // 駐車場/EV/トイレ
}

// 公式＋ミラー。Overpassは時間帯で応答が極端にばらつく（同一クエリが1秒〜20秒超）。
// そのため直列フォールバックではなく「全ミラーへ同時に投げ、最速の成功を採用」する。
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// 1ミラーが沈黙した時に他へ素早く切り替えるためのクライアント側タイムアウト(ms)。
const TIMEOUT_MS = 7000;

/** Overpass応答のJSONをPoi配列へ整形（node/way/relation を中心点で拾う）。 */
function parseElements(j: { elements?: unknown[] }): Poi[] {
  const out: Poi[] = [];
  for (const el of (j.elements ?? []) as Array<Record<string, unknown>>) {
    const center = el.center as { lat?: number; lon?: number } | undefined;
    const lat = (el.lat as number) ?? center?.lat;
    const lng = (el.lon as number) ?? center?.lon;
    if (lat == null || lng == null) continue;
    const t = (el.tags ?? {}) as Record<string, string>;
    const kind = kindFromTags(t);
    if (!kind) continue;
    out.push({
      id: el.id as number,
      lat,
      lng,
      kind,
      label: t.brand || t.name || t.operator || POI_KIND_META[kind].label,
    });
  }
  return out;
}

/** 指定bbox・指定種類のPOIを Overpass から取得。kinds が空なら通信せず空配列を返す。
 *  nwr + out center で node だけでなく way/relation（駐車場のポリゴン等）も中心点で拾う。
 *  全ミラーへ並列に1リクエストずつ投げ、最初に成功した応答を採用する（Promise.any）。
 *  各リクエストは TIMEOUT_MS で自動中断。呼び出し側で最小間隔を担保しているため過剰アクセスにはならない。 */
async function fetchOverpass(b: BBox, kinds: PoiKind[]): Promise<Poi[]> {
  if (!kinds.length) return [];
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  const body = kinds.map((k) => `nwr${KIND_FILTER[k]}(${bbox});`).join("");
  const q = `[out:json][timeout:25];(${body});out center;`;
  const payload = "data=" + encodeURIComponent(q);

  const once = async (url: string): Promise<Poi[]> => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: payload,
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`overpass ${r.status} @ ${url}`);
      return parseElements(await r.json());
    } finally {
      clearTimeout(to);
    }
  };

  // 最速の成功を採用。全滅時は Promise.any が AggregateError を投げる（呼び出し側で捕捉）。
  return Promise.any(ENDPOINTS.map(once));
}

// ── Mapbox Search Box /category を主ソースにする（Overpass は不安定＝1秒〜20秒超・ズーム制限が必要）。────
// Overpass 依存を減らし、全国どこでも高速・安定に施設を出す。カテゴリの canonical id は環境で揺れる可能性が
// あるため「候補を順に試し、最初に通ったidをキャッシュ」＝実行時に自己検証する（存在しない前提を作らない）。

/** 地図と共通のトークン（env優先→PWAのlocalStorage）。route.ts/geocode.ts と同じ規則。無ければ ""。 */
function mapboxToken(): string {
  const env = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";
  if (env) return env;
  try {
    return localStorage.getItem("mapbox_poc_token") || "";
  } catch {
    return "";
  }
}

// PoiKind → Mapbox のカテゴリ canonical id 候補（先頭から試す）。表記揺れ・taxonomy変更に備えて複数持つ。
const KIND_CANDIDATES: Record<PoiKind, string[]> = {
  conv: ["convenience_store", "convenience"],
  fuel: ["gas_station", "fuel", "petrol_station"],
  parking: ["parking", "parking_lot", "parking_garage"],
  ev: ["charging_station", "ev_charging_station"], // Android docs で charging_station を確認
  toilet: ["restroom", "toilet", "public_bathroom", "public_toilet"],
};
const resolvedCatId: Partial<Record<PoiKind, string>> = {}; // 通ったidをキャッシュ（次回以降は候補探索をスキップ）
const deadCatKind = new Set<PoiKind>(); // 全候補が「存在しないid」だった種類（＝以降は常に Overpass）
const CATEGORY = "https://api.mapbox.com/search/searchbox/v1/category";
// Search Box category は1リクエスト最大25件/カテゴリ（API上限）。地図の表示bbox内なら実用上十分。

/** 文字列→符号なし32bit風の数値ID（Poi.id は number 型。mapbox_id や座標から安定生成）。 */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 2点間の概算距離(m)。近接POIの重複統合の判定用（緯度補正した等距円筒近似）。 */
function distM(a: Poi, b: Poi): number {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}
// 同一物理店舗がブランド名/運営会社名/表記違いで複数返るため、同種でこの距離以内は1件に統合する。
// 例:「アポロステーションセルフ大日SS」と「千葉石油 セルフ大日SS」(~15m)、「セブンイレブン」と「セブン-イレブン」。
const DEDUPE_M = 35;
/** ブランド専用アイコンが付く（＝ブランド判定できた）Poi か。統合時の代表選択で優先する。 */
function hasBrandIcon(p: Poi): boolean {
  const f = poiIconFile(p.kind, p.label);
  return !!f && f !== "generic.png";
}
/** 近接重複を統合（同種・DEDUPE_M以内）。ブランドアイコンが付く方を代表に残す。 */
function dedupeByProximity(pois: Poi[]): Poi[] {
  // ブランド判定できる方を先に見て代表に採るためソート（安定・branded優先）。
  const sorted = [...pois].sort((a, b) => (hasBrandIcon(b) ? 1 : 0) - (hasBrandIcon(a) ? 1 : 0));
  const kept: Poi[] = [];
  for (const p of sorted) {
    if (kept.some((q) => q.kind === p.kind && distM(q, p) < DEDUPE_M)) continue;
    kept.push(p);
  }
  return kept;
}

/** /category レスポンス(GeoJSON FeatureCollection)を Poi[] へ整形（重複統合は呼び出し側で全セル結合後に実施）。 */
function parseCategoryRaw(j: unknown, kind: PoiKind): Poi[] {
  const feats = (j as { features?: unknown[] })?.features;
  if (!Array.isArray(feats)) return [];
  const out: Poi[] = [];
  for (const f of feats as Array<Record<string, unknown>>) {
    const geom = f.geometry as { coordinates?: [number, number] } | undefined;
    const c = geom?.coordinates;
    if (!c || c.length < 2) continue;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const brand = Array.isArray(p.brand) ? String((p.brand as unknown[])[0] ?? "") : (p.brand as string) || "";
    const label = brand || (p.name as string) || POI_KIND_META[kind].label;
    const idKey = (p.mapbox_id as string) || `${c[0]},${c[1]}`;
    out.push({ id: hashStr(idKey), lat: c[1], lng: c[0], kind, label });
  }
  return out;
}

/** bbox を最大 maxDim×maxDim のセル（約 cellKm 四方）に等分割し、各セルの {bbox文字列, proximity文字列} を返す。
 *  /category は proximity 最寄り25件/カテゴリしか返さないため、広い範囲を1回で取ると薄くなる。セル毎に25件取れば
 *  「ある程度広い範囲」を「密に」カバーできる（＝知らない土地でも自車周辺～少し先のコンビニ等が漏れず出る）。 */
function tileCells(b: BBox, cellKm: number, maxDim: number): { bbox: string; prox: string }[] {
  const midLat = (b.s + b.n) / 2;
  const wKm = (b.e - b.w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const hKm = (b.n - b.s) * 111.32;
  const nx = Math.min(maxDim, Math.max(1, Math.round(wKm / cellKm)));
  const ny = Math.min(maxDim, Math.max(1, Math.round(hKm / cellKm)));
  const cells: { bbox: string; prox: string }[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const w = b.w + ((b.e - b.w) * ix) / nx;
      const e = b.w + ((b.e - b.w) * (ix + 1)) / nx;
      const s = b.s + ((b.n - b.s) * iy) / ny;
      const n = b.s + ((b.n - b.s) * (iy + 1)) / ny;
      cells.push({ bbox: `${w},${s},${e},${n}`, prox: `${(w + e) / 2},${(s + n) / 2}` });
    }
  }
  return cells;
}

// 1リクエストの上限。/category は最大25/カテゴリ。
const CAT_LIMIT = 25;
const catUrl = (id: string, cell: { bbox: string; prox: string }, tok: string) =>
  `${CATEGORY}/${id}?bbox=${cell.bbox}&proximity=${cell.prox}&limit=${CAT_LIMIT}&language=ja&country=jp&access_token=${tok}`;

/** 1種類ぶんを Mapbox /category からタイル分割で取得（各セル25件→結合→近接重複統合）。候補idは cell[0] で解決しキャッシュ。
 *  返り値 null = 「Mapboxで取得不可（通信失敗/全候補が無効id）」＝この種類は Overpass に回す合図。 */
async function fetchCategoryForKind(
  kind: PoiKind,
  cells: { bbox: string; prox: string }[],
  tok: string
): Promise<Poi[] | null> {
  if (deadCatKind.has(kind) || !cells.length) return deadCatKind.has(kind) ? null : [];
  // ① canonical id を解決（cell[0] で候補を順に試す）。その応答は第1セルのデータとして再利用。
  const cached = resolvedCatId[kind];
  const candidates = cached ? [cached] : KIND_CANDIDATES[kind];
  let id: string | null = null;
  let firstPois: Poi[] = [];
  let allInvalid = true;
  for (const cand of candidates) {
    let r: Response;
    try {
      r = await fetch(catUrl(cand, cells[0], tok));
    } catch {
      return null; // 通信失敗は一時的 → 今回だけ Overpass
    }
    if (r.ok) {
      id = cand;
      resolvedCatId[kind] = cand;
      try {
        firstPois = parseCategoryRaw(await r.json(), kind);
      } catch {
        return null;
      }
      break;
    }
    if (r.status !== 404 && r.status !== 400 && r.status !== 422) allInvalid = false;
  }
  if (!id) {
    if (allInvalid) deadCatKind.add(kind); // 全候補が存在しないid → 以降この種類は Overpass 固定
    return null;
  }
  // ② 残りセルを並列取得（各セル25件）。1セルでも失敗は空扱いで継続。
  const rest = await Promise.all(
    cells.slice(1).map(async (c) => {
      try {
        const r = await fetch(catUrl(id!, c, tok));
        if (!r.ok) return [] as Poi[];
        return parseCategoryRaw(await r.json(), kind);
      } catch {
        return [] as Poi[];
      }
    })
  );
  return dedupeByProximity([...firstPois, ...rest.flat()]);
}

/** 指定bbox・指定種類のPOIを取得。Mapbox /category を主ソースにし、取得できない種類だけ Overpass へフォールバック。
 *  ★1取得=1種類につき1リクエスト（範囲全体を1セルで）。理由: /category は Search Box のレート制限が厳しく、
 *  タイル分割(旧v0.8.95で最大18req)は連続取得で大量に HTTP 429 を返し「全然取れない」を招いた（実測: 18req中8〜18が429）。
 *  1種類1req(既定conv+fuelで計2req)なら連続取得でも429ゼロを実測。範囲は呼び出し側 coverage() のbboxに25件上限で収める。
 *  返却の Poi 形状・呼び出し規約は従来どおり（マーカー描画・キャッシュ・ズーム制限は呼び出し側で不変）。 */
export async function fetchPois(b: BBox, kinds: PoiKind[]): Promise<Poi[]> {
  if (!kinds.length) return [];
  const tok = mapboxToken();
  if (!tok) return fetchOverpass(b, kinds); // トークン未設定は従来どおり Overpass
  const cells = tileCells(b, 0.7, 1); // 1セル=範囲全体（1リクエスト/カテゴリ・レート制限回避）
  const results = await Promise.all(kinds.map((k) => fetchCategoryForKind(k, cells, tok)));
  const out: Poi[] = [];
  const overpassKinds: PoiKind[] = [];
  kinds.forEach((k, i) => {
    const r = results[i];
    if (r === null) overpassKinds.push(k);
    else out.push(...r);
  });
  if (overpassKinds.length) {
    const extra = await fetchOverpass(b, overpassKinds).catch(() => [] as Poi[]);
    out.push(...extra);
  }
  return out;
}
