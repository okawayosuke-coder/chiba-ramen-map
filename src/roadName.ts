// 高速道路の路線名を正規化する（OSMの表記ゆれ吸収）。
// 施設側の road（scripts/assign-facility-roads.mjs が付与）と、走行中に把握する curRoad
// （src/highwayGeom.ts）を同じ土俵で文字列一致させるために、両者でこの規則を通す。
//
// ※ scripts/road-name.mjs に同一実装を複製している。片方を直したら必ずもう片方も同期すること
//   （Nodeの.mjsからTSを直接importできないための重複。ロジックは小さく保つ）。
//
// 吸収する表記ゆれ:
//  1) 複合名「本線;支線」 … OSMは "首都圏中央連絡自動車道;さがみ縦貫道路" のように主路線+別名を
//     セミコロンで連結する。先頭(主路線)を採用して同一路線に束ねる。
//  2) 別名/略称 … 同じ物理路線が別文字列で混在（圏央道 ⇔ 首都圏中央連絡自動車道）。ALIASESで統合。
//  3) ランプ/出入口/通称 … "箱崎ロータリー" "渋谷出口" "ETC専用" や裸の数字(ref)は本線の路線名でない。
//     これらは路線名候補から外す（""を返す）＝curRoad/施設roadに採用しない。

const ALIASES: [string, RegExp][] = [
  // 圏央道: 正式名「首都圏中央連絡自動車道」と略称「圏央道」がgeom上に併存する
  ["首都圏中央連絡自動車道", /^(首都圏中央連絡自動車道|圏央道)$/],
];

/** ランプ・出入口・ロータリー・ETC専用・バス停・裸の数字(ref) は本線の路線名ではない */
function isRampName(s: string): boolean {
  return (
    /(出口|入口|ランプ|ロータリー|バス停)$/.test(s) ||
    s === "ETC専用" ||
    /^[0-9]+$/.test(s)
  );
}

/** 路線名を正規化。本線として扱えない名前（ランプ/通称/空）は "" を返す。 */
export function canonicalRoad(raw: string | undefined | null): string {
  let s = (raw || "").trim();
  if (!s) return "";
  s = s.split(";")[0].trim(); // 複合名「本線;支線」→ 本線(先頭)
  if (!s || isRampName(s)) return "";
  for (const [canon, re] of ALIASES) if (re.test(s)) return canon;
  return s;
}
