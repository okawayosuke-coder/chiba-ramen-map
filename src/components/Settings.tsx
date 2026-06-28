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
  bigLabels: boolean;
  setBigLabels: (v: boolean) => void;
  gyroGrade: boolean;
  setGyroGrade: (v: boolean) => void;
  headingUp: boolean;
  setHeadingUp: (v: boolean) => void;
  traffic: boolean;
  setTraffic: (v: boolean) => void;
  threeD: boolean;
  setThreeD: (v: boolean) => void;
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
  bigLabels,
  setBigLabels,
  gyroGrade,
  setGyroGrade,
  headingUp,
  setHeadingUp,
  traffic,
  setTraffic,
  threeD,
  setThreeD,
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
          <h3>地図の向き（走行中）</h3>
          <div className="set-row">
            <button
              className={`chip${!headingUp ? " chip--on" : ""}`}
              onClick={() => setHeadingUp(false)}
            >
              ノースアップ
            </button>
            <button
              className={`chip${headingUp ? " chip--on" : ""}`}
              onClick={() => setHeadingUp(true)}
            >
              ヘディングアップ
            </button>
          </div>
          <p className="modal__small">
            ノースアップ＝北が上で固定。ヘディングアップ＝進行方向が上になるよう地図が回転（自車を下寄りにして前方を広く表示）。いずれも平面表示です。
          </p>
        </section>

        <section className="set-sec">
          <h3>地図の文字（テスト）</h3>
          <div className="set-row">
            <button
              className={`chip${bigLabels ? " chip--on" : ""}`}
              onClick={() => setBigLabels(!bigLabels)}
            >
              文字を大きく {bigLabels ? "ON" : "OFF"}
            </button>
          </div>
          <p className="modal__small">
            OSMの地図を2倍に拡大して地名を大きく表示します（テスト）。読みやすくなる反面、細かいラベルが減り、やや滲みます。OFFで通常の地図に戻ります。
          </p>
        </section>

        <section className="set-sec">
          <h3>傾斜メーターの補正（テスト）</h3>
          <div className="set-row">
            <button
              className={`chip${gyroGrade ? " chip--on" : ""}`}
              onClick={() => setGyroGrade(!gyroGrade)}
            >
              ジャイロで平坦補正 {gyroGrade ? "ON" : "OFF"}
            </button>
          </div>
          <p className="modal__small">
            端末の傾き（ジャイロ）を使い、<strong>平坦な道で勾配が誤表示される</strong>のを抑えます。端末が水平で加減速も小さい時は、地図標高が坂と判定しても平坦と表示します。勾配の数値計算は従来どおり。OFFで標高のみの判定（中央値＋ヒステリシス）に戻ります。
          </p>
        </section>

        <section className="set-sec">
          <h3>渋滞・3D表示</h3>
          <div className="set-row">
            <button
              className={`chip${traffic ? " chip--on" : ""}`}
              onClick={() => setTraffic(!traffic)}
            >
              🚗 渋滞表示 {traffic ? "ON" : "OFF"}
            </button>
            <button
              className={`chip${threeD ? " chip--on" : ""}`}
              onClick={() => setThreeD(!threeD)}
            >
              🏙 3D表示 {threeD ? "ON" : "OFF"}
            </button>
          </div>
          <p className="modal__small">
            <strong>渋滞表示</strong>＝道路を渋滞度で色分け（Mapbox Traffic・約8分毎更新）。
            <strong>3D表示</strong>＝地形の起伏と3D建物を俯瞰視点で表示（任意機能・既定は平面）。3DはGPU負荷が高め＝発熱しやすいので、必要な時だけのご利用を推奨。
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
            {stats.count > 0
              ? ` ・ 容量 約${
                  stats.bytes >= 1024 * 1024
                    ? (stats.bytes / 1024 / 1024).toFixed(1) + "MB"
                    : Math.max(1, Math.round(stats.bytes / 1024)) + "KB"
                }（上限の${Math.round(
                  (stats.count / stats.maxCount) * 100
                )}%）`
              : ""}
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
