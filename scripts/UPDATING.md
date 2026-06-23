# 店舗データ（shops.json）の更新手順（手動）

ローカルの Mac で実行する。Google マップから再収集 → 絞り込み → 差分レビュー → push。
店舗の閉店・開業が多いので、目安は **四半期に1回**程度。

> データ元は Google マップの公開情報。**評価・口コミの転載や大量再配布はしない**（個人/限定用途）。
> `placeId` 以外の保存は本来 30 日制限があるグレー領域。公開範囲を広げる場合は要検討。

---

## 0. 前提（最初の1回だけ）

```bash
cd ~/code/chiba-ramen-map
npm install                      # 依存（playwright を含む）
npx playwright install chromium  # スクレイプ用の Chromium 本体
# python3 / node があること（現状: node v24, python3 3.x で動作確認済み）
```

念のため、更新前に復旧用タグを打っておくと安全：

```bash
git tag stable-pre-data-update-$(date +%Y%m%d)
```

---

## 1. 再収集（順番厳守）

**`scrape.mjs` を必ず最初に実行**すること。`scrape.mjs` は `raw_all.json` を**上書き**し、
他の地域スクリプトはそこへ**追記マージ**するため、順番を間違えると地域データが消える。

```bash
# ① 千葉県全域（raw_all.json を新規上書き）
node scripts/scrape.mjs
#   ・Google の同意画面/ブロックで結果が +0 のときは画面を見て対応:
#       node scripts/scrape.mjs --headful
#   ・一部エリアだけ試す: node scripts/scrape.mjs --limit 3

# ② 江東区・江戸川区（raw_all.json に追記）
node scripts/scrape_wards.mjs

# ③ つくば市周辺（追記）
node scripts/scrape_tsukuba.mjs

# ④ 茨城県南（追記）
node scripts/scrape_ibaraki_south.mjs
```

- 各スクリプトは「`raw_all.json 更新: 旧 → 新 件（+N）`」と出力する。+0 が続く場合は Google 側のブロックの可能性（後述）。
- 地域スクリプト（②〜④）は headless 固定でフラグ非対応。

---

## 2. 絞り込み・整形（shops.json 再生成）

```bash
python3 scripts/refine.py
```

`refine.py` がやること：

- `raw_all.json` を読み、**評価3.5以上・口コミ50以上・ラーメン店**に絞り込み
- 行政界（点包含）で千葉県＋江東/江戸川区＋つくば/茨城県南のみ残し、`region` を付与
- **既存 shops.json の `reviewsUrl` を placeId で引き継ぐ**（消さない）
- **`meta.json` の更新日（JST）を自動で刻む** → サイトの「データ最終更新」表示に反映

> `scrape.mjs` は shops.json を書かない設計（生成元は refine.py のみ）。
> なので①〜④の間も既存 shops.json の `reviewsUrl` は保持され、ここで引き継がれる。

---

## 3. 口コミ直リンクの解決（任意・推奨）

新しく増えた店だけ「口コミタブ直開き」URL を解決して `reviewsUrl` に格納する
（未解決の店は `mapsUrl` にフォールバックするので必須ではない）。

```bash
node scripts/resolve_reviews.mjs
```

- `reviewsUrl` が無い店だけが対象（既存店は再処理しない）。1店あたり待機ありで**やや遅い**。
- ブロック多発時は自動で部分保存して中断する。

---

## 4. 差分レビュー（重要）

公開中（git HEAD）と再生成後（作業ツリー）を比較し、変更点を人間が確認する。

```bash
python3 scripts/diff.py
```

- 🆕 新規/再出現 ／ ⚠ 消滅（**閉店 or 取りこぼし疑い**・確認URL付き）／ 📈 評価変動（3.9境界またぎ強調）／ ✏ 改名・住所変更 を出力。
- **「消滅」は閉店と断定しない**。Google の feed は取りこぼしが起きるので、確認URLを開いて現存を確かめてから判断する。
- 不審に件数が減っている（消滅が大量）→ スクレイプの取りこぼし疑い。`node scripts/scrape.mjs --headful` で取り直す。

---

## 5. ローカル確認 → 公開

```bash
npm run build      # 型・ビルドが通るか（任意）
npm run dev        # ローカルで地図/件数/最終更新日を目視（任意）
```

問題なければコミットして push（main への push で GitHub Actions が自動デプロイ）：

```bash
git add src/data/shops.json src/data/meta.json scripts/raw_all.json
git -c user.name="okawayosuke-coder" -c user.email="okawa.yosuke@techmagic.co.jp" \
  commit -m "店舗データ更新（YYYY-MM 再収集）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
```

公開URL: https://okawayosuke-coder.github.io/chiba-ramen-map/

---

## まとめ（コピペ用・順番厳守）

```bash
cd ~/code/chiba-ramen-map
node scripts/scrape.mjs              # ① 千葉（raw_all.json 上書き）※必ず最初
node scripts/scrape_wards.mjs        # ② 江東/江戸川（追記）
node scripts/scrape_tsukuba.mjs      # ③ つくば（追記）
node scripts/scrape_ibaraki_south.mjs# ④ 茨城県南（追記）
python3 scripts/refine.py            # ⑤ shops.json 再生成＋meta更新日
node scripts/resolve_reviews.mjs     # ⑥ 新規店の口コミ直リンク（任意）
python3 scripts/diff.py              # ⑦ 差分レビュー
# 確認OK → git add / commit / push
```

---

## ファイル早見表

| ファイル | 役割 | 誰が書く |
|---|---|---|
| `scripts/raw_all.json` | 収集の生データ（pid/評価/口コミ/座標/genre/住所） | scrape*.mjs |
| `src/data/shops.json` | 公開データ（絞り込み＋region＋reviewsUrl） | **refine.py のみ** |
| `src/data/meta.json` | 更新日・件数（サイト表示用） | refine.py が自動 |

## トラブルシュート

- **収集が +0 続き / 結果が極端に少ない**：Google の同意画面・bot ブロックの可能性。
  `node scripts/scrape.mjs --headful` で画面を見て同意を通す。時間を空けて再試行。
- **`npx playwright install chromium` を忘れると** `chromium.launch` でエラー。
- **diff.py で消滅が大量**：閉店ではなく取りこぼしの可能性大。再収集し直す。
- **reviewsUrl が消える心配**：scrape.mjs が shops.json を書かなくなったので不要（refine.py が引き継ぐ）。

---

# 周辺POI（コンビニ/GS）データの更新手順

走行中に「確実な情報」として即時・オフライン表示するため、コンビニ/GS は OpenStreetMap から
**事前収集してアプリに同梱**する（`public/pois.json`）。駐車場/EV/トイレは件数が多いため同梱せず、
従来どおりライブ取得（Overpass）。同梱範囲は**関東一円（1都6県）**。範囲外は自動でライブにフォールバック。

データ元は OpenStreetMap（ODbL。© OpenStreetMap contributors）。コンビニ/GSの位置は変化が緩やかなので、
目安は **月1回**程度。下記2通りで更新できる。

## 方法A：自動（GitHub Actions・推奨）

- `.github/workflows/update-pois.yml` が **毎月1日(JST 翌2日3:00)** に自動実行。
- `public/pois.json` に変更があれば自動コミット → デプロイを自動トリガー。
- 任意のタイミングで回したい時は GitHub の Actions タブ →「Update bundled POIs」→ **Run workflow**（手動実行）。

## 方法B：手動（ローカルMac）

```bash
cd ~/code/chiba-ramen-map
node scripts/fetch-pois.mjs        # 関東一円をタイル分割してOverpassから収集 → public/pois.json
git add public/pois.json
git commit -m "chore(poi): refresh bundled POIs"
git push                            # push で Pages デプロイが走る
```

- 収集は **数分〜十数分**（Overpassが混雑する時間帯は遅い／一部タイル失敗あり。失敗タイルはログに表示）。
- **失敗タイルが多い時間帯は、時間を空けて再実行**すると埋まる（Overpassは時間帯で応答が大きくばらつく）。
- 完了時に `コンビニN / GSN, 〇秒` を表示。`public/pois.json` の `updatedAt`（収集日）は設定パネルにも表示される。

## 範囲を変えたい場合

`scripts/fetch-pois.mjs` 冒頭の `REGION`（外接bbox）と `CELL`（タイル粒度）を編集。
範囲を広げるとファイルが大きくなるが、PWAのプリキャッシュ上限は `vite.config.ts` の
`maximumFileSizeToCacheInBytes` で調整可能。
