import { useRef } from "react";
import {
  NAV_APP_META,
  navAppsForPlatform,
  requestOrientationPermission,
  type NavApp,
} from "../nav";
import { exportFavorites, type ThemePref } from "../storage";
import { useEscape } from "../hooks";

interface Props {
  navApp: NavApp | null;
  setNavApp: (a: NavApp) => void;
  themePref: ThemePref;
  setThemePref: (p: ThemePref) => void;
  autoDrive: boolean;
  setAutoDrive: (v: boolean) => void;
  favs: Set<string>;
  importKeys: (keys: string[]) => void;
  onResetSafety: () => void;
  onClose: () => void;
}

export default function Settings({
  navApp,
  setNavApp,
  themePref,
  setThemePref,
  autoDrive,
  setAutoDrive,
  favs,
  importKeys,
  onResetSafety,
  onClose,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const apps = navAppsForPlatform();
  useEscape(onClose);

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const keys: string[] = Array.isArray(data) ? data : data.favs ?? [];
        importKeys(keys);
        alert(`${keys.length}件のお気に入りを読み込みました`);
      } catch {
        alert("ファイルを読み込めませんでした");
      }
    };
    reader.readAsText(f);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal--settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="settings-title">⚙ 設定</h2>

        <section className="set-sec">
          <h3>既定のナビアプリ</h3>
          <div className="set-row">
            {apps.map((key) => (
              <button
                key={key}
                className={`chip${navApp === key ? " chip--on" : ""}`}
                onClick={() => setNavApp(key)}
              >
                {NAV_APP_META[key].label}
              </button>
            ))}
          </div>
          <p className="modal__small">起動するナビ。未選択ならナビ時に毎回確認します。</p>
        </section>

        <section className="set-sec">
          <h3>テーマ</h3>
          <div className="set-row">
            {(["auto", "light", "dark"] as ThemePref[]).map((p) => (
              <button
                key={p}
                className={`chip${themePref === p ? " chip--on" : ""}`}
                onClick={() => setThemePref(p)}
              >
                {p === "auto" ? "自動" : p === "light" ? "ライト" : "ダーク"}
              </button>
            ))}
          </div>
        </section>

        <section className="set-sec">
          <h3>自動走行</h3>
          <div className="set-row">
            <button
              className={`chip${autoDrive ? " chip--on" : ""}`}
              onClick={() => {
                const n = !autoDrive;
                if (n) requestOrientationPermission(); // タップ内で方位許可
                setAutoDrive(n);
              }}
            >
              移動を検知して自動で走行モード {autoDrive ? "ON" : "OFF"}
            </button>
          </div>
          <p className="modal__small">
            走り出し（約12km/h超）を検知すると自動で走行モードに入ります。
            アプリを開いて画面が点いている間のみ動作（閉じている時は不可）。
            常時GPSを使うためバッテリーを消費します。
          </p>
        </section>

        <section className="set-sec">
          <h3>お気に入りのバックアップ（{favs.size}件）</h3>
          <div className="set-row">
            <button className="chip" onClick={() => exportFavorites(favs)}>
              書き出し（JSON）
            </button>
            <button className="chip" onClick={() => fileRef.current?.click()}>
              読み込み
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={onImportFile}
            />
          </div>
          <p className="modal__small">
            お気に入りはこの端末内のみに保存されます。機種変更前に書き出しておくと安心です。
          </p>
        </section>

        <section className="set-sec">
          <h3>安全確認</h3>
          <button className="chip" onClick={onResetSafety}>
            ナビ起動時の注意を再表示する
          </button>
        </section>

        <div className="modal__actions">
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
