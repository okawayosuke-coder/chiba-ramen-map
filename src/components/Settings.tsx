import { useRef, useState } from "react";
import { NAV_APP_META, navAppsForPlatform, type NavApp } from "../nav";
import { exportFavorites, type ThemePref } from "../storage";
import { clearTrack, downloadTrackGPX, trackStats } from "../track";
import { useEscape } from "../hooks";

interface Props {
  navApp: NavApp | null;
  setNavApp: (a: NavApp) => void;
  themePref: ThemePref;
  setThemePref: (p: ThemePref) => void;
  showTrack: boolean;
  setShowTrack: (v: boolean) => void;
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
  showTrack,
  setShowTrack,
  favs,
  importKeys,
  onResetSafety,
  onClose,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const apps = navAppsForPlatform();
  const [stats, setStats] = useState(() => trackStats());
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
          <h3>走行軌跡</h3>
          <div className="set-row">
            <button
              className={`chip${showTrack ? " chip--on" : ""}`}
              onClick={() => setShowTrack(!showTrack)}
            >
              地図に表示 {showTrack ? "ON" : "OFF"}
            </button>
            <button
              className="chip"
              onClick={() => downloadTrackGPX()}
              disabled={stats.count === 0}
            >
              GPXで書き出し
            </button>
            <button
              className="chip"
              onClick={() => {
                if (confirm("走行軌跡を消去しますか？")) {
                  clearTrack();
                  setStats(trackStats());
                }
              }}
              disabled={stats.count === 0}
            >
              消去
            </button>
          </div>
          <p className="modal__small">
            走行モード中に自動で記録（端末内のみ保存）。
            記録 {stats.count.toLocaleString()}点 ・ 約{stats.km.toFixed(1)}km
            {stats.durMin > 0 ? ` ・ 約${stats.durMin}分` : ""}
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
