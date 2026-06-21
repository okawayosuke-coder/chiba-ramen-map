import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/** 新バージョン検知時に「更新」を促すバー。registerType:'prompt' と併用。
 *  更新ボタンは skipWaiting を試みつつ、待機SWが無い等で自動リロードが起きない場合の
 *  保険として明示的にリロードする（autoUpdate→prompt 移行時の取りこぼし対策）。 */
export default function UpdatePrompt() {
  const [updating, setUpdating] = useState(false);
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

  const onUpdate = () => {
    setUpdating(true);
    // skipWaiting → controllerchange で自動リロード（プラグイン側）
    Promise.resolve(updateServiceWorker(true)).catch(() => {});
    // 待機SWが無く自動リロードが来ない場合の保険（移行時など）
    window.setTimeout(() => window.location.reload(), 1500);
  };

  return (
    <div className="update-bar" role="alert">
      <span className="update-bar__msg">🍜 新しいバージョンがあります</span>
      <div className="update-bar__btns">
        <button
          type="button"
          className="update-bar__go"
          onClick={onUpdate}
          disabled={updating}
        >
          {updating ? "更新中…" : "更新"}
        </button>
        <button
          type="button"
          className="update-bar__later"
          onClick={() => setNeedRefresh(false)}
        >
          あとで
        </button>
      </div>
    </div>
  );
}
