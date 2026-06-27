import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";

// GitHub Pages はサブパス配信（/chiba-ramen-map/）。dev は / のまま。
export default defineConfig(({ command }) => ({
  // バージョン表示用。ビルド毎に更新（package.jsonのバージョン＋ビルド時刻）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  base: command === "build" ? "/chiba-ramen-map/" : "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "千葉ラーメンMAP",
        short_name: "千葉ラーメン",
        description:
          "千葉県＋江東区・江戸川区の高評価ラーメン店マップ。カーナビ起動対応。",
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
        // ベクター地図(maplibre)はテスト機能で重い(約1MB)。ON時のみ動的importで取得すれば良く、
        // 全ユーザーのPWAプリキャッシュを膨らませないよう除外する。
        globIgnores: ["**/*maplibre*"],
        // pois.json は大きめ(~1MB)なのでプリキャッシュ上限を引き上げる
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: null,
      },
    }),
  ],
  server: {
    port: 5174,
    host: true,
  },
}));
