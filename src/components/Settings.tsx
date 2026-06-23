import { useEffect, useRef, useState } from "react";
import { NAV_APP_META, navAppsForPlatform, type NavApp } from "../nav";
import { exportFavorites, type PoiKindsUpdater, type ThemePref } from "../storage";
import { POI_KINDS, POI_KIND_META, type PoiKind } from "../poi";
import { loadLocalPois } from "../poiData";
import { clearTrack, downloadTrackGPX, trackStats } from "../track";
import { useEscape } from "../hooks";

// バージョン表示（vite.config.ts の define で注入。ビルド毎に更新）
const BUILD_JST = (() => {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(__BUILD_TIME__));
  } catch {
    return __BUILD_TIME__;
  }
})();

interface Props {
  navApp: NavApp | null;
  setNavApp: (a: NavApp) => void;
  themePref: ThemePref;
  setThemePref: (p: ThemePref) => void;
  showTrack: boolean;
  setShowTrack: (v: boolean) => void;
  showPoi: boolean;
  setShowPoi: (v: boolean) => void;
  poiKinds: PoiKind[];
  setPoiKinds: (k: PoiKindsUpdater) => void;
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
  showPoi,
  setShowPoi,
  poiKinds,
  setPoiKinds,
  favs,
  importKeys,
  onResetSafety,
  onClose,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const apps = navAppsForPlatform();
  const [stats, setStats] = useState(() => trackStats());
  const [poiDate, setPoiDate] = useState("");
  useEscape(onClose);

  // 同梱POI（コンビニ/GS）データの収集日を表示（鮮度の明示）
  useEffect(() => {
    let on = true;
    loadLocalPois()
      .then((d) => {
        if (on) setPoiDate(d.updatedAt);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

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

  // 種類のON/OFF。新たにONにした時、全体表示がOFFなら自動でONにする（種類だけ選んでも出ないのを防ぐ）
  const togglePoiKind = (k: PoiKind) => {
    const turningOn = !poiKinds.includes(k);
    setPoiKinds((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]
    );
    if (turningOn && !showPoi) setShowPoi(true);
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
            {(["auto", "light", "dark", "sun"] as ThemePref[]).map((p) => (
              <button
                key={p}
                className={`chip${themePref === p ? " chip--on" : ""}`}
                onClick={() => setThemePref(p)}
              >
                {p === "auto"
                  ? "自動"
                  : p === "light"
                  ? "ライト"
                  : p === "dark"
                  ? "ダーク"
                  : "🌅 日の入り"}
              </button>
            ))}
          </div>
        </section>

        <section className="set-sec">
          <h3>周辺POIの表示</h3>
          <div className="set-row">
            {POI_KINDS.map((k) => (
              <button
                key={k}
                className={`chip${poiKinds.includes(k) ? " chip--on" : ""}`}
                onClick={() => togglePoiKind(k)}
              >
                {POI_KIND_META[k].emoji} {POI_KIND_META[k].label}
              </button>
            ))}
          </div>
          <p className="modal__small">
            地図を拡大（ズーム14以上）すると表示範囲の施設を表示します。
            ツールバーの🏪でまとめてON/OFF{showPoi ? "" : "（現在OFF）"}。
            <br />
            <strong>コンビニ/GS</strong>は端末内データで表示（関東一円・
            {poiDate || "—"}時点・オフライン可）。
            駐車場/EV/トイレはネット取得（件数が多いため必要な時だけONを推奨）。
          </p>
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

        <p className="app-version">
          バージョン v{__APP_VERSION__} ・ ビルド {BUILD_JST} JST
        </p>

        <div className="modal__actions">
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
