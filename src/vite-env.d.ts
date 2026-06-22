/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />

// vite.config.ts の define で注入（バージョン表示用）
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
