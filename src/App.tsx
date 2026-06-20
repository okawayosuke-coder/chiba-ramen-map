import { useCallback, useEffect, useMemo, useState } from "react";
import RamenMap from "./components/RamenMap";
import SafetyGate from "./components/SafetyGate";
import NavPicker from "./components/NavPicker";
import Settings from "./components/Settings";
import {
  DEFAULT_RATING,
  MIN_REVIEWS,
  RATING_FLOOR,
  REGIONS,
  type Filters,
  type Shop,
} from "./types";
import {
  fmtDistance,
  haversineKm,
  isSchemeApp,
  launchNav,
  multiStopUrl,
  NAV_APP_META,
  navAppsForPlatform,
  roughMinutes,
  shareNav,
  type NavApp,
} from "./nav";
import {
  shopKey,
  useDriving,
  useFavorites,
  useNavApp,
  useSafetyAck,
  useTheme,
} from "./storage";
import { useGeolocation } from "./hooks";
import shopsData from "./data/shops.json";

const ALL_SHOPS = shopsData as Shop[];

// スキーム起動(Yahoo等)は起動可否を検知できないため文言を中立に
const navToast = (app: NavApp, name: string) =>
  isSchemeApp(app)
    ? `${NAV_APP_META[app].label}を開きます（未インストールなら反応しません）`
    : `「${name}」を${NAV_APP_META[app].label}で起動しました`;

const DEFAULTS: Filters = {
  query: "",
  minRating: DEFAULT_RATING,
  minReviews: MIN_REVIEWS,
  region: "all",
  sort: "rating",
};

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [focus, setFocus] = useState<Shop | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [driving, setDriving] = useDriving();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<Shop | null>(null);
  const [pickerFor, setPickerFor] = useState<Shop | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { favs, toggle, isFav, importKeys } = useFavorites();
  const [navApp, setNavApp] = useNavApp();
  const [safetyAck, setSafetyAck] = useSafetyAck();
  const theme = useTheme();
  const geo = useGeolocation();

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const view = useMemo(() => {
    const q = filters.query.trim();
    const arr = ALL_SHOPS.filter((s) => {
      if (s.rating < filters.minRating) return false;
      if (s.reviews < filters.minReviews) return false;
      if (filters.region !== "all" && s.region !== filters.region) return false;
      if (favOnly && !favs.has(shopKey(s))) return false;
      if (q && !(s.name.includes(q) || s.address.includes(q))) return false;
      return true;
    }).map((s) => ({ s, km: geo.pos ? haversineKm(geo.pos, s) : null }));

    arr.sort((a, b) => {
      if (filters.sort === "near" && a.km != null && b.km != null)
        return a.km - b.km;
      if (filters.sort === "reviews") return b.s.reviews - a.s.reviews;
      if (filters.sort === "name") return a.s.name.localeCompare(b.s.name, "ja");
      return b.s.rating - a.s.rating || b.s.reviews - a.s.reviews;
    });
    return arr;
  }, [filters, favOnly, favs, geo.pos]);

  const shops = useMemo(() => view.map((v) => v.s), [view]);

  const select = useCallback((s: Shop) => {
    setFocus(s);
    setSheetOpen(false);
  }, []);

  // ===== ナビ起動フロー（安全ゲート → アプリ選択 → 起動） =====
  const proceedNav = useCallback(
    (shop: Shop) => {
      if (!navApp) {
        setPickerFor(shop);
        return;
      }
      launchNav(navApp, shop, shop.name);
      setToast(navToast(navApp, shop.name));
    },
    [navApp]
  );

  const startNav = useCallback(
    (shop: Shop) => {
      // 未同意、または運転モード中（＝車内）は毎回「停車中ですか」を再確認
      if (!safetyAck || driving) {
        setPendingNav(shop);
        return;
      }
      proceedNav(shop);
    },
    [safetyAck, driving, proceedNav]
  );

  const doShare = useCallback(async (shop: Shop) => {
    const r = await shareNav(shop, shop.name);
    if (r === "copied") setToast("ナビリンクをコピーしました");
    else if (r === "failed") setToast("共有できませんでした");
    // "shared" / "cancelled" は通知不要
  }, []);

  const distanceTo = useCallback(
    (s: Shop) => (geo.pos ? haversineKm(geo.pos, s) : null),
    [geo.pos]
  );

  const requestNear = () => {
    geo.request();
    set("sort", "near");
  };

  const hashigo = () => {
    if (shops.length < 2) return;
    // 現在地があれば近い順に並べてからルート化（評価順のジグザグを回避）
    const ordered = geo.pos
      ? [...shops].sort(
          (a, b) => haversineKm(geo.pos!, a) - haversineKm(geo.pos!, b)
        )
      : shops;
    const { url, used, capped } = multiStopUrl(ordered);
    const dest = ordered[Math.min(used, ordered.length) - 1];
    window.open(url, "_blank", "noopener");
    setToast(
      capped
        ? `近い順に${used}件でルート作成（経由地上限／最終目的地: ${dest.name}）`
        : `${used}件のはしごルート（最終目的地: ${dest.name}）`
    );
  };

  const filtersChanged =
    filters.query ||
    filters.region !== "all" ||
    filters.minRating !== DEFAULT_RATING ||
    filters.minReviews !== MIN_REVIEWS ||
    favOnly;

  const geoNotice =
    geo.status === "loading"
      ? "現在地を取得中…"
      : geo.status === "far"
      ? "現在地が対象エリア（千葉＋江東・江戸川）から離れています。エリアを選んで探してください。"
      : geo.status === "denied"
      ? "位置情報が拒否されました。ブラウザの設定で許可してください。"
      : geo.status === "unavailable"
      ? "この環境では現在地を取得できません（HTTPS環境が必要です）。"
      : null;

  return (
    <div className={`app${driving ? " driving" : ""}`}>
      <aside className={`sidebar${sheetOpen ? " open" : ""}`}>
        <button
          className="sheet-toggle"
          onClick={() => setSheetOpen((o) => !o)}
          aria-label="一覧を開閉"
        />
        <div className="sidebar__controls">
        <div className="sidebar__header">
          <h1>🍜 千葉ラーメンMAP</h1>
          <p>千葉県＋江東区・江戸川区＋茨城県南（つくば・土浦ほか）／カーナビ起動対応</p>
          <p className="safety-line">
            ⚠️ 運転中の操作・注視は道交法違反。停車中・同乗者操作でご利用ください。
          </p>
        </div>

        <nav className="toolbar">
          <button
            className="tool-btn"
            onClick={requestNear}
            disabled={geo.status === "loading"}
          >
            <span className="ic" aria-hidden="true">
              📍
            </span>
            <span>{geo.status === "loading" ? "取得中…" : "現在地"}</span>
          </button>
          <button
            className={`tool-btn${follow ? " on" : ""}`}
            aria-pressed={follow}
            onClick={() =>
              setFollow((f) => {
                const n = !f;
                setToast(
                  n
                    ? "走行モード: 自車を追従します（操作は停車中に）"
                    : "走行モードを終了しました"
                );
                return n;
              })
            }
          >
            <span className="ic" aria-hidden="true">
              🧭
            </span>
            <span>走行</span>
          </button>
          <button
            className={`tool-btn${driving ? " on" : ""}`}
            aria-pressed={driving}
            onClick={() => setDriving(!driving)}
          >
            <span className="ic" aria-hidden="true">
              🚗
            </span>
            <span>運転</span>
          </button>
          <button
            className="tool-btn"
            aria-pressed={theme.resolved === "dark"}
            onClick={() =>
              theme.setPref(theme.resolved === "dark" ? "light" : "dark")
            }
          >
            <span className="ic" aria-hidden="true">
              {theme.resolved === "dark" ? "☀️" : "🌙"}
            </span>
            <span>{theme.resolved === "dark" ? "ライト" : "夜間"}</span>
          </button>
          <button className="tool-btn" onClick={() => setSettingsOpen(true)}>
            <span className="ic" aria-hidden="true">
              ⚙
            </span>
            <span>設定</span>
          </button>
        </nav>

        <div className="filters">
          <div className="field">
            <label>店名・住所で検索</label>
            <input
              type="text"
              placeholder="例: 家系、二郎、松戸 …"
              value={filters.query}
              onChange={(e) => set("query", e.target.value)}
            />
          </div>

          <div className="chips-row">
            <button
              className={`chip${favOnly ? " chip--on" : ""}`}
              onClick={() => setFavOnly((v) => !v)}
            >
              ★ お気に入り{favs.size > 0 ? `（${favs.size}）` : ""}
            </button>
            <button className="chip" onClick={requestNear}>
              📍 近い順
            </button>
            <button
              className={`chip${filtersOpen ? " chip--on" : ""}`}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              絞り込み {filtersOpen ? "▲" : "▼"}
            </button>
          </div>

          {filtersOpen && (
            <>
              <div className="field">
                <label>エリア</label>
                <select
                  value={filters.region}
                  onChange={(e) => set("region", e.target.value)}
                >
                  {REGIONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="filters__row">
                <div className="field">
                  <label>
                    最低評価{" "}
                    <span className="range-val">★{filters.minRating.toFixed(1)}</span>
                  </label>
                  <input
                    type="range"
                    min={RATING_FLOOR}
                    max={4.7}
                    step={0.1}
                    value={filters.minRating}
                    onChange={(e) => set("minRating", Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>
                    最低口コミ数{" "}
                    <span className="range-val">{filters.minReviews}件</span>
                  </label>
                  <input
                    type="range"
                    min={MIN_REVIEWS}
                    max={1000}
                    step={50}
                    value={filters.minReviews}
                    onChange={(e) => set("minReviews", Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="field">
                <label>並べ替え</label>
                <select
                  value={filters.sort}
                  onChange={(e) => set("sort", e.target.value as Filters["sort"])}
                >
                  <option value="rating">評価が高い順</option>
                  <option value="reviews">口コミ件数が多い順</option>
                  <option value="near">現在地から近い順</option>
                  <option value="name">店名順</option>
                </select>
              </div>
            </>
          )}
        </div>

        {geoNotice && (
          <div className="notice" role="status" aria-live="polite">
            {geoNotice}
          </div>
        )}

        <div className="stats">
          <span aria-live="polite">
            該当 <b>{shops.length}</b> 店 / 全{ALL_SHOPS.length}店
          </span>
          {filtersChanged && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setFilters(DEFAULTS);
                setFavOnly(false);
              }}
              className="link"
            >
              条件をリセット
            </a>
          )}
        </div>

        {favOnly && shops.length >= 2 && (
          <button className="hashigo-btn" onClick={hashigo}>
            🍜🚗 お気に入り{shops.length}件で「はしご」ルートを作成（Googleマップ）
          </button>
        )}
        </div>

        <div className="list">
          {view.map(({ s, km }) => (
            <div
              key={shopKey(s)}
              className={`shop${focus === s ? " active" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${s.name} 評価${s.rating.toFixed(1)} 口コミ${s.reviews.toLocaleString()}件。地図で表示`}
              onClick={() => select(s)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(s);
                }
              }}
            >
              <div className="shop__top">
                <span className="shop__name">{s.name}</span>
                <span className="shop__rating">
                  <span className="star">★</span>
                  {s.rating.toFixed(1)}
                </span>
              </div>
              <div className="shop__meta">
                <span>口コミ {s.reviews.toLocaleString()}件</span>
                {km != null && (
                  <span className="shop__dist">
                    📍直線{fmtDistance(km)}・車約{roughMinutes(km)}分
                  </span>
                )}
              </div>
              {s.address && <div className="shop__addr">{s.address}</div>}
              <div className="shop__actions" onClick={(e) => e.stopPropagation()}>
                <button className="act act--nav" onClick={() => startNav(s)}>
                  🚗 ナビ開始
                </button>
                <button
                  className={`act act--fav${isFav(s) ? " on" : ""}`}
                  onClick={() => toggle(s)}
                  aria-pressed={isFav(s)}
                  aria-label={isFav(s) ? "お気に入りから削除" : "お気に入りに追加"}
                >
                  {isFav(s) ? "★" : "☆"}
                </button>
                <button className="act" onClick={() => doShare(s)} title="共有">
                  共有
                </button>
                <a
                  className="act act--link act--icon"
                  href={s.reviewsUrl ?? s.mapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Googleマップで口コミを見る"
                  title="口コミを見る"
                >
                  💬
                </a>
              </div>
            </div>
          ))}
          {shops.length === 0 && (
            <div className="empty">
              条件に合うお店がありません。条件をゆるめるか、お気に入りを追加してください。
            </div>
          )}
        </div>
      </aside>

      <div className="map-wrap">
        <RamenMap
          shops={shops}
          focus={focus}
          follow={follow}
          theme={theme.resolved}
          userPos={geo.pos}
          isFav={isFav}
          onToggleFav={toggle}
          onNav={startNav}
          onShare={doShare}
          distanceTo={distanceTo}
        />
      </div>

      {pendingNav && (
        <SafetyGate
          shopName={pendingNav.name}
          onAccept={() => {
            setSafetyAck(true);
            const s = pendingNav;
            setPendingNav(null);
            proceedNav(s);
          }}
          onCancel={() => setPendingNav(null)}
        />
      )}

      {pickerFor && (
        <NavPicker
          shopName={pickerFor.name}
          apps={navAppsForPlatform()}
          onPick={(app) => {
            setNavApp(app);
            const s = pickerFor;
            setPickerFor(null);
            launchNav(app, s, s.name);
            setToast(navToast(app, s.name));
          }}
          onCancel={() => setPickerFor(null)}
        />
      )}

      {settingsOpen && (
        <Settings
          navApp={navApp}
          setNavApp={setNavApp}
          themePref={theme.pref}
          setThemePref={theme.setPref}
          favs={favs}
          importKeys={importKeys}
          onResetSafety={() => {
            setSafetyAck(false);
            setToast("ナビ起動時の注意を次回表示します");
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
