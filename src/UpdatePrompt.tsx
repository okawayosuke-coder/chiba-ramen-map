import { useRegisterSW } from "virtual:pwa-register/react";

/** 新バージョン検知時に「更新」を促すバー。registerType:'prompt' と併用。
 *  更新ボタンで skipWaiting → リロードして最新版に切り替わる。 */
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      // 長時間開きっぱなしでも更新に気づけるよう定期チェック（60分毎）
      if (r) setInterval(() => r.update(), 60 * 60 * 1000);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="update-bar" role="alert">
      <span className="update-bar__msg">🍜 新しいバージョンがあります</span>
      <div className="update-bar__btns">
        <button className="update-bar__go" onClick={() => updateServiceWorker(true)}>
          更新
        </button>
        <button className="update-bar__later" onClick={() => setNeedRefresh(false)}>
          あとで
        </button>
      </div>
    </div>
  );
}
