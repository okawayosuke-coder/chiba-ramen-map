// OpenStreetMap の POI（コンビニ / ガソリンスタンド）を Overpass API から取得する。
// shop=convenience / amenity=fuel を対象。表示範囲(bbox)ぶんだけ取得する想定。
// Overpassは共有の無料APIなので、呼び出し側でズーム制限・bboxキャッシュ・最小間隔を必ず設けること。

export interface Poi {
  id: number;
  lat: number;
  lng: number;
  kind: "conv" | "fuel";
  label: string; // ブランド名 or 名称
}

export interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

// 主＝公式、副＝ミラー（公式が406/429等で失敗した時のフォールバック）
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export async function fetchPois(b: BBox): Promise<Poi[]> {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  const q =
    `[out:json][timeout:25];(` +
    `node["shop"="convenience"](${bbox});` +
    `node["amenity"="fuel"](${bbox});` +
    `);out body;`;
  let lastErr: unknown = null;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(q),
      });
      if (!r.ok) {
        lastErr = new Error(`overpass ${r.status}`);
        continue;
      }
      const j = await r.json();
      const out: Poi[] = [];
      for (const el of j.elements ?? []) {
        if (el.type !== "node" || el.lat == null || el.lon == null) continue;
        const t = el.tags ?? {};
        const kind: Poi["kind"] | null =
          t.shop === "convenience"
            ? "conv"
            : t.amenity === "fuel"
            ? "fuel"
            : null;
        if (!kind) continue;
        out.push({
          id: el.id,
          lat: el.lat,
          lng: el.lon,
          kind,
          label: t.brand || t.name || (kind === "conv" ? "コンビニ" : "GS"),
        });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("overpass failed");
}
