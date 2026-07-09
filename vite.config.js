import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";
// GitHub Pages はサブパス配信（/chiba-ramen-map/）。dev は / のまま。
export default defineConfig(function (_a) {
    var command = _a.command;
    return ({
        // バージョン表示用。ビルド毎に更新（package.jsonのバージョン＋ビルド時刻）
        define: {
            __APP_VERSION__: JSON.stringify(pkg.version),
            __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
        base: command === "build" ? "/chiba-ramen-map/" : "/",
        build: {
            rollupOptions: {
                // mapbox-gl(約1MB)を独立チャンク化＝lazy import 時のみ取得。チャンク名固定で PWA 除外も効かせる。
                output: { manualChunks: { "mapbox-gl": ["mapbox-gl"] } },
            },
        },
        plugins: [
            react(),
            VitePWA({
                registerType: "prompt",
                includeAssets: ["icon.svg", "apple-touch-icon.png"],
                manifest: {
                    name: "TechMagic NAVI",
                    short_name: "TechMagic NAVI",
                    description: "TechMagic NAVI — カーナビ＋千葉県＋江東区・江戸川区の高評価ラーメン店マップ。",
                    lang: "ja",
                    theme_color: "#c92a2a",
                    background_color: "#15171a",
                    display: "standalone",
                    orientation: "any",
                    icons: [
                        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
                        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
                        {
                            src: "icon-512.png",
                            sizes: "512x512",
                            type: "image/png",
                            purpose: "maskable",
                        },
                    ],
                },
                workbox: {
                    // アプリシェル＋データをプリキャッシュ。pois.json(同梱POI)も含めオフライン表示可。
                    // 地図タイルは外部のためオフライン不可。
                    globPatterns: ["**/*.{js,css,html,png,svg,woff2,json}"],
                    // mapbox-gl は試験機能・大容量・要ネットワークのためプリキャッシュしない（既定Leafletの負荷を増やさない）。
                    // regions/(全国の地方ブロック高速データ)は関東外に出た時だけ使うオンデマンド設計＝プリキャッシュせず
                    // 下の runtimeCaching(CacheFirst) で「一度取れた地方はオフライン再訪可」にする。
                    globIgnores: ["**/mapbox-gl-*.js", "**/regions/**"],
                    // pois.json は大きめ(~1MB)なのでプリキャッシュ上限を引き上げる
                    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
                    navigateFallback: null,
                    runtimeCaching: [
                        {
                            urlPattern: /\/regions\/[^/]+\/[^/]+\.json$/,
                            handler: "CacheFirst",
                            options: {
                                cacheName: "hw-regions",
                                expiration: { maxEntries: 32, maxAgeSeconds: 45 * 24 * 60 * 60 },
                            },
                        },
                    ],
                },
            }),
        ],
        server: {
            port: 5174,
            host: true,
        },
    });
});
