// あいまい検索: 表記ゆれ（ひらがな/カタカナ/全半角/大小）を吸収し、
// さらにローマ字⇄かな（例「ramen」⇔「ラーメン」「らーめん」、「tokyo」⇔「とうきょう」）も橋渡しする。
//
// 各文字列を2つの正規化キーに落とす:
//   plain  … NFKC + 小文字 + カタカナ→ひらがな + 長音/記号/空白の除去（同一スクリプト内のゆれ吸収）
//   romaji … かな→ローマ字（ヘボン式）+ 長音まとめ（スクリプトをまたぐ照合）
// 店側・クエリ側を同じ規則で正規化し、部分一致で判定する。

export interface SearchKey {
  plain: string;
  romaji: string;
  hasKanji: boolean; // 元テキストに漢字を含むか（含む語はローマ字が断片化＝過剰一致するので使わない）
}

// 漢字（CJK統合漢字）。クエリ語が漢字を含むかの判定に使う。
const KANJI_RE = /[㐀-䶿一-鿿]/;

// 拗音（2文字）。先に2文字で照合する。
const YOUON: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo",
  ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho",
  じゃ: "ja", じゅ: "ju", じょ: "jo",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo",
  ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  びゃ: "bya", びゅ: "byu", びょ: "byo",
  ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo",
  りゃ: "rya", りゅ: "ryu", りょ: "ryo",
};

// 単かな（ひらがな）。カタカナは事前にひらがなへ寄せてから引く。
const ROMA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "wi", ゑ: "we", を: "o", ん: "n",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
  ゃ: "ya", ゅ: "yu", ょ: "yo", ゔ: "vu",
};

/** カタカナ→ひらがな（NFKCで半角カナも全角カナへ寄ってから呼ぶ前提） */
function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/** ひらがな列をローマ字へ。かな以外（漢字/英数字）はそのまま素通し。 */
function hiraToRomaji(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const two = s.slice(i, i + 2);
    if (YOUON[two]) {
      out += YOUON[two];
      i += 2;
      continue;
    }
    const c = s[i];
    if (c === "っ") {
      // 促音: 次の子音を重ねる（っち→tch のヘボン式も考慮）
      const nextTwo = s.slice(i + 1, i + 3);
      const next = YOUON[nextTwo] || ROMA[s[i + 1]] || "";
      if (/^[a-z]/.test(next)) out += next[0] === "c" ? "t" : next[0];
      i += 1;
      continue;
    }
    if (c === "ー") {
      // 長音: 直前の母音を繰り返す
      const m = out.match(/[aeiou]$/);
      if (m) out += m[0];
      i += 1;
      continue;
    }
    if (ROMA[c]) {
      out += ROMA[c];
      i += 1;
      continue;
    }
    out += c; // 漢字・英数字・記号など
    i += 1;
  }
  return out;
}

/** plainキー: 同一スクリプト内の表記ゆれ吸収用 */
function toPlain(s: string): string {
  return kataToHira(s.normalize("NFKC").toLowerCase()).replace(
    /[ー・･\s　,.、。･・「」『』()（）/／-]/g,
    ""
  );
}

/** romajiキー: スクリプトをまたぐ照合用。長音や連母音をまとめて緩めに一致させる */
function toRomaji(s: string): string {
  const raw = hiraToRomaji(kataToHira(s.normalize("NFKC").toLowerCase()));
  return raw
    .replace(/[^a-z0-9]/g, "") // 漢字・記号・空白を除去（ローマ字部分のみ残す）
    .replace(/ou/g, "o")
    .replace(/(.)\1+/g, "$1"); // 連続する同字（長音由来の aa/oo 等）を1つに
}

/** 文字列から検索キーを作る（店名+住所などに使用） */
export function buildSearchKey(text: string): SearchKey {
  return {
    plain: toPlain(text),
    romaji: toRomaji(text),
    hasKanji: KANJI_RE.test(text),
  };
}

/** クエリを空白区切りの語に分け、それぞれのキーを返す。空なら null（=絞り込みなし） */
export function parseQuery(q: string): SearchKey[] | null {
  const terms = q
    .trim()
    .split(/[\s　]+/)
    .filter(Boolean)
    .map(buildSearchKey)
    // plain も romaji も空になる語（記号のみ等）は無視
    .filter((k) => k.plain || k.romaji);
  return terms.length ? terms : null;
}

/** 1語が対象に一致するか。plain一致 もしくは romaji一致（2文字以上で誤爆抑制）。
 *  ※漢字を含むクエリ語はローマ字化で漢字が捨てられ断片(例「支那そば」→"soba")になり
 *    全そば店に過剰一致するため、ローマ字フォールバックは「漢字を含まない語」に限る。 */
function matchesTerm(target: SearchKey, term: SearchKey): boolean {
  if (term.plain && target.plain.includes(term.plain)) return true;
  if (
    !term.hasKanji &&
    term.romaji.length >= 2 &&
    target.romaji.includes(term.romaji)
  )
    return true;
  return false;
}

/** 全語が一致（AND）すれば対象にヒット */
export function matchesQuery(target: SearchKey, terms: SearchKey[]): boolean {
  return terms.every((t) => matchesTerm(target, t));
}

/** 店名キーに対する1語の関連度（大きいほど良い一致）。店名/読みでの一致を高く、
 *  住所/ジャンルだけの一致は弱く評価する（並べ替えで店名一致を上位に出すため）。 */
function scoreTerm(nameKey: SearchKey, term: SearchKey): number {
  if (term.plain && nameKey.plain.includes(term.plain))
    return nameKey.plain.startsWith(term.plain) ? 100 : 60;
  if (
    !term.hasKanji &&
    term.romaji.length >= 2 &&
    nameKey.romaji.includes(term.romaji)
  )
    return nameKey.romaji.startsWith(term.romaji) ? 80 : 50;
  return 5; // 店名では当たらない（住所/ジャンル等での一致。フィルタは別途通過済み前提）
}

/** クエリ全語の関連度合計（フィルタ通過済みの店を並べ替えるためのスコア） */
export function scoreQuery(nameKey: SearchKey, terms: SearchKey[]): number {
  return terms.reduce((sum, t) => sum + scoreTerm(nameKey, t), 0);
}
