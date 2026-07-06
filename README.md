# TechMagic NAVI 🧭🍜

（旧称: 千葉ラーメンMAP。リポジトリ名/URL は `chiba-ramen-map` のまま）

**公開URL: https://okawayosuke-coder.github.io/chiba-ramen-map/**

**千葉県＋江東区・江戸川区＋茨城県南（つくば・土浦・牛久・守谷・取手・龍ケ崎ほか）** の **ラーメン店（Google評価3.5以上・口コミ50件以上を収録／既定の絞り込みは3.8以上の高評価）** を地図で探せる個人用Webアプリ。スライダーで最低評価を3.5まで下げられる。

## iPad / スマホで使う（ホーム画面に追加）

1. Safari で上記URLを開く
2. 共有ボタン → 「ホーム画面に追加」→ 全画面アプリとして起動（PWA）
3. 初回に位置情報を「許可」すると「現在地から近い順」が使える
4. 車載は固定ホルダー＋音声、操作は停車中のみ（道交法）

## デプロイ

`main` にpushすると GitHub Actions（`.github/workflows/deploy.yml`）が `npm run build` → GitHub Pages へ自動デプロイ。GitHub Pagesはサブパス配信のため `vite.config.ts` の `base` を `/chiba-ramen-map/` にしている（dev は `/`）。

2026/5/16にCoworkで作成した静的マップ（Leaflet + KML）をベースに、検索・絞り込み・並べ替えに対応したReact製アプリとして作り直したもの。

## 機能

### 探す
- Leaflet地図上にマーカークラスタリングで店舗を表示（評価点を表示するティアドロップ型ピン・評価帯で色分け）
- 店名・住所のテキスト検索
- エリア（江東区・江戸川区／東葛飾／葛南／千葉市・市原／北総／東総・山武／南房総）での絞り込み
- 最低評価・最低口コミ数のスライダー、評価順／口コミ件数順／現在地から近い順／店名順の並べ替え
- 一覧／ピンのクリックで地図移動。各店「口コミ」リンクはGoogleマップの口コミに着地（`?ftid=` 形式）

### カーナビ（ハンドオフ型）
案内そのものは端末のナビアプリに委譲する方式。`src/nav.ts` に集約。
- **ナビ起動**: 各店から Google マップ / Apple マップ / Yahoo!カーナビ を起動（座標 `dir` URL。Yahooは `yjcarnavi://` スキームのみ＝要アプリ）。端末OSで候補を出し分け、既定アプリを記憶して1タップ化
- **安全ゲート**: 初回ナビ時に道交法の注意モーダル＋ヘッダーに常設注意。自動起動はせず必ずタップ起点
- **現在地から近い順**: `getCurrentPosition`（単発）＋Haversineで直線距離・目安所要（平均30km/h・道路距離ではない旨を明記）。現在地マーカー表示。対象エリア外・権限拒否・非HTTPS時はフォールバック通知
- **行きたいリスト（★お気に入り）**: localStorage（安定キー＝placeId）。「お気に入りのみ」表示、設定からJSONエクスポート/インポート
- **共有**: 各店のナビリンクを Web Share / クリップボードで共有（同乗者の端末で開く動線）
- **ダーク/ナイトモード**: `prefers-color-scheme` 追従＋手動切替。地図もダークタイル（CARTO）に連動
- **運転モード**: 一覧を特大カード化（停車中の一瞥選択用）
- **はしご**: お気に入りから複数経由地ルートをGoogleマップで一括起動（経由地上限はモバイル3／PC9で出し分け）

> ⚠️ 運転中のスマホ操作・注視は道路交通法違反。固定ホルダー＋音声、または同乗者操作前提で利用すること。
> Geolocation/共有/PWAはセキュアコンテキスト必須（localhostは可、`http://192.168.x`のLANは不可）→ 実機・実車運用には**HTTPSデプロイが前提**。

## データ

`src/data/shops.json` に店舗データを格納（`scripts/` の収集パイプラインで生成）。

データ項目: `name, rating, reviews, lat, lng, genre, address, placeId, mapsUrl, region`

収集パイプライン:

1. `node scripts/scrape.mjs` … 千葉全域21エリアをGoogleマップからスクレイピング → `scripts/raw_all.json`
2. `node scripts/scrape_wards.mjs` … 江東区・江戸川区を追加スクレイピングして `raw_all.json` にマージ
3. `node scripts/fetch_boundaries.mjs` … 江東区・江戸川区・千葉県の行政界（国土数値情報N03）を `scripts/boundaries.json` に取得
4. `python3 scripts/refine.py` … 数値条件＋ラーメン店判定＋行政界の点包含判定で `src/data/shops.json` を生成（千葉県・江東区・江戸川区のいずれかに含まれる店だけ残し、隣接他区＝台東/中央/墨田/葛飾や埼玉・茨城を除外。各店に `region` を付与）

> データはGoogleマップの検索結果から収集したもの。評価・口コミ件数・閉店状況は変動するため、定期的な再収集を推奨。

## 開発

```bash
npm install
npm run dev      # http://localhost:5174
npm run build    # dist/ に静的ビルド
npm run preview
```

## スタック

React 18 + Vite + TypeScript / Leaflet + react-leaflet + react-leaflet-cluster
