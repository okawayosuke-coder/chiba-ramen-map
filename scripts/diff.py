#!/usr/bin/env python3
"""shops.json の差分レポート。再収集後に「何が変わったか」を人間がレビューするためのツール。

既定の比較対象:
  OLD = git HEAD の src/data/shops.json（＝いま公開中のデータ）
  NEW = 作業ツリーの src/data/shops.json（＝scrape→refine 再生成後のデータ）

典型ワークフロー:
  node scripts/scrape.mjs        # raw_all.json を更新
  python3 scripts/refine.py      # shops.json を再生成（作業ツリーが新データに）
  python3 scripts/diff.py        # 旧(公開中) と 新 を比較してレポート
  # 内容を確認し、問題なければ commit

placeId 基準で突き合わせ、以下を出力する:
  🆕 新規/再出現        … NEW にあって OLD に無い
  ⚠ 消滅(閉店/取りこぼし疑い) … OLD にあって NEW に無い ※断定しない・要確認
  📈 評価変動            … 同一店の rating / reviews の変化（3.9境界またぎを強調）
  ✏ 改名/住所変更        … 同一店の name / address の変化

注意: NEW に無い＝必ずしも閉店ではない。Googleマップのfeedは取りこぼしが起きるため、
      確認用URL（reviewsUrl/mapsUrl）を見て現存を確かめること。

使い方:
  python3 scripts/diff.py [--old PATH] [--new PATH] [--json] [--review-delta N]
  --old/--new を渡すと任意の2ファイルを比較（テスト用）。
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
SHOPS_REL = "src/data/shops.json"
META_REL = "src/data/meta.json"
OUT = os.path.join(REPO, SHOPS_REL)

RATING_FLOOR_UI = 3.9  # フロントの既定フィルタ（DEFAULT_RATING）。境界またぎを強調するため


def key_of(s):
    """並び順非依存の安定キー。placeId 優先、無ければ name@丸め座標。"""
    pid = s.get("placeId")
    if pid:
        return pid
    return f'{s.get("name","")}@{round(s.get("lat",0),4)},{round(s.get("lng",0),4)}'


def load_json_text(text, label):
    try:
        return json.loads(text)
    except Exception as e:
        print(f"[error] {label} のJSON解析に失敗: {e}", file=sys.stderr)
        sys.exit(1)


def git_show(rel_path):
    """git HEAD のファイル内容を返す。無ければ None。"""
    try:
        r = subprocess.run(
            ["git", "-C", REPO, "show", f"HEAD:{rel_path}"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return None
        return r.stdout
    except FileNotFoundError:
        return None  # git 未インストール


def load_old(old_path):
    if old_path:
        with open(old_path, encoding="utf-8") as f:
            return load_json_text(f.read(), old_path), f"file:{old_path}"
    text = git_show(SHOPS_REL)
    if text is None:
        print("[error] git HEAD の shops.json を取得できません。--old でファイルを指定してください。",
              file=sys.stderr)
        sys.exit(1)
    return load_json_text(text, "git HEAD:shops.json"), "git HEAD"


def load_new(new_path):
    path = new_path or OUT
    with open(path, encoding="utf-8") as f:
        return load_json_text(f.read(), path), f"file:{path}"


def updated_at_of(new_path, old_path):
    """表示用の更新日（取得できなければ None）。"""
    def parse(text):
        if not text:
            return None
        try:
            return json.loads(text).get("updatedAt")
        except Exception:
            return None
    old_date = parse(git_show(META_REL)) if not old_path else None
    new_meta = os.path.join(os.path.dirname(new_path), "meta.json") if new_path \
        else os.path.join(REPO, META_REL)
    new_date = None
    if os.path.exists(new_meta):
        with open(new_meta, encoding="utf-8") as f:
            new_date = parse(f.read())
    return old_date, new_date


def fmt_shop(s, extra=""):
    return (f'  - [★{s.get("rating")}/{s.get("reviews")}件] {s.get("name")} '
            f'({s.get("region","?")}){extra}')


def url_of(s):
    return s.get("reviewsUrl") or s.get("mapsUrl") or ""


def main():
    ap = argparse.ArgumentParser(description="shops.json 差分レポート")
    ap.add_argument("--old", help="旧ファイルのパス（省略時: git HEAD の shops.json）")
    ap.add_argument("--new", help="新ファイルのパス（省略時: 作業ツリーの shops.json）")
    ap.add_argument("--json", action="store_true", help="機械可読JSONで出力")
    ap.add_argument("--review-delta", type=int, default=30,
                    help="評価変動に載せる口コミ数増減のしきい値（既定30）")
    args = ap.parse_args()

    old_list, old_src = load_old(args.old)
    new_list, new_src = load_new(args.new)
    old_date, new_date = updated_at_of(args.new, args.old)

    old = {key_of(s): s for s in old_list}
    new = {key_of(s): s for s in new_list}

    added = [new[k] for k in new.keys() - old.keys()]
    removed = [old[k] for k in old.keys() - new.keys()]

    rating_changes, name_changes = [], []
    for k in old.keys() & new.keys():
        o, n = old[k], new[k]
        dr = round((n.get("rating") or 0) - (o.get("rating") or 0), 2)
        dc = (n.get("reviews") or 0) - (o.get("reviews") or 0)
        if dr != 0 or abs(dc) >= args.review_delta:
            crossed = (o.get("rating", 0) < RATING_FLOOR_UI) != (n.get("rating", 0) < RATING_FLOOR_UI)
            rating_changes.append({"shop": n, "old": o, "dr": dr, "dc": dc, "crossed": crossed})
        if (o.get("name") or "") != (n.get("name") or "") or \
           (o.get("address") or "") != (n.get("address") or ""):
            name_changes.append({"old": o, "new": n})

    added.sort(key=lambda s: (-(s.get("rating") or 0), -(s.get("reviews") or 0)))
    removed.sort(key=lambda s: -(s.get("reviews") or 0))  # 口コミ多い消滅ほど要注意
    rating_changes.sort(key=lambda x: -abs(x["dr"]))

    if args.json:
        print(json.dumps({
            "old": {"src": old_src, "date": old_date, "count": len(old_list)},
            "new": {"src": new_src, "date": new_date, "count": len(new_list)},
            "added": added, "removed": removed,
            "ratingChanges": rating_changes, "nameChanges": name_changes,
        }, ensure_ascii=False, indent=1))
        return

    print("=" * 64)
    print("📊 shops.json 差分レポート")
    print(f"  OLD: {old_src}  {old_date or ''}  {len(old_list)}件")
    print(f"  NEW: {new_src}  {new_date or ''}  {len(new_list)}件")
    print("=" * 64)

    print(f"\n🆕 新規/再出現 ({len(added)}件)")
    for s in added:
        print(fmt_shop(s))

    print(f"\n⚠ 消滅＝閉店 or 取りこぼし疑い ({len(removed)}件) ※断定不可・要確認")
    for s in removed:
        print(fmt_shop(s))
        u = url_of(s)
        if u:
            print(f"      確認: {u}")

    print(f"\n📈 評価変動 ({len(rating_changes)}件)")
    for c in rating_changes:
        o, n = c["old"], c["shop"]
        dr = f'{c["dr"]:+.2f}' if c["dr"] else "±0"
        dc = f'{c["dc"]:+d}' if c["dc"] else "±0"
        mark = "  ⭐3.9境界またぎ" if c["crossed"] else ""
        print(f'  - {n.get("name")}: ★{o.get("rating")}→{n.get("rating")} ({dr}), '
              f'口コミ {o.get("reviews")}→{n.get("reviews")} ({dc}){mark}')

    print(f"\n✏ 改名/住所変更 ({len(name_changes)}件)")
    for c in name_changes:
        o, n = c["old"], c["new"]
        if (o.get("name") or "") != (n.get("name") or ""):
            print(f'  - 店名: 「{o.get("name")}」→「{n.get("name")}」')
        if (o.get("address") or "") != (n.get("address") or ""):
            print(f'    住所: 「{o.get("address")}」→「{n.get("address")}」')

    print("\n" + "-" * 64)
    print(f"サマリ: 新規 {len(added)} / 消滅疑い {len(removed)} / "
          f"評価変動 {len(rating_changes)} / 改名等 {len(name_changes)}")
    if removed:
        print("※「消滅」はGoogleマップのfeed取りこぼしの可能性あり。確認URLで現存をチェックしてからcommitすること。")


if __name__ == "__main__":
    main()
