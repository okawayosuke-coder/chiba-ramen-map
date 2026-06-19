import { useEffect, useMemo, useState } from "react";
import RamenMap from "./components/RamenMap";
import SafetyGate from "./components/SafetyGate";
import NavPicker from "./components/NavPicker";
import Settings from "./components/Settings";
import { REGIONS, type Filters, type Shop } from "./types";
import {
  fmtDistance,
  haversineKm,
  launchNav,
  multiStopUrl,
  NAV_APPS,
  navAppsForPlatform,
  roughMinutes,
  shareNav,
  type NavApp,
} from "./nav";
import {
  shopKey,
  useFavorites,
  useNavApp,
  useSafetyAck,
  useTheme,
} from "./storage";
import { useGeolocation } from "./hooks";
import shopsData from "./data/shops.json";

const ALL_SHOPS = shopsData as Shop[];

const DEFAULTS: Filters = {
  query: "",
  minRating: 3.9,
  minReviews: 50,
  region: "all",
  sort: "rating",
};

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [focus, setFocus] = useState<Shop | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [driving, setDriving] = useState(false);
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

  const select = (s: Shop) => {
    setFocus(s);
    setSheetOpen(false);
  };

  // ===== ナビ起動フロー（安全ゲート → アプリ選択 → 起動） =====
  const navLabel = (a: NavApp) => NAV_APPS.find((x) => x.key === a)!.label;

  const proceedNav = (shop: Shop) => {
    if (!navApp) {
      setPickerFor(shop);
      return;
    }
    launchNav(navApp, shop, shop.name);
    setToast(`「${shop.name}」を${navLabel(navApp)}で起動しました`);
  };

  const startNav = (shop: Shop) => {
    if (!safetyAck) {
      setPendingNav(shop);
      return;
    }
    proceedNav(shop);
  };

  const doShare = async (shop: Shop) => {
    const r = await shareNav(shop, shop.name);
    if (r === "copied") setToast("ナビリンクをコピーしました");
    else if (r === "failed") setToast("共有できませんでした");
  };

  const requestNear = () => {
    geo.request();
    set("sort", "near");
  };

  const hashigo = () => {
    if (shops.length < 2) return;
    const { url, used, capped } = multiStopUrl(shops);
    window.open(url, "_blank", "noopener");
    setToast(
      capped
        ? `先頭${used}件でルート作成（経由地の上限）`
        : `${used}件のはしごルートを作成`
    );
  };

  const filtersChanged =
    filters.query ||
    filters.region !== "all" ||
    filters.minRating !== 3.9 ||
    filters.minReviews !== 50 ||
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
        <div className="sidebar__header">
          <div className="sidebar__titlebar">
            <h1>🍜 千葉ラーメンMAP</h1>
            <div className="toolbar">
              <button
                className="icon-btn"
                title="現在地から近い順"
                onClick={requestNear}
              >
                📍
              </button>
              <button
                className={`icon-btn${driving ? " on" : ""}`}
                title="運転モード（特大表示）"
                onClick={() => setDriving((d) => !d)}
              >
                🚗
              </button>
              <button
                className="icon-btn"
                title="テーマ"
                onClick={() =>
                  theme.setPref(theme.resolved === "dark" ? "light" : "dark")
                }
              >
                {theme.resolved === "dark" ? "☀️" : "🌙"}
              </button>
              <button
                className="icon-btn"
                title="設定"
                onClick={() => setSettingsOpen(true)}
              >
                ⚙
              </button>
            </div>
          </div>
          <p>千葉県＋江東区・江戸川区／カーナビ起動対応</p>
          <p className="safety-line">
            ⚠️ 運転中の操作・注視は道交法違反。停車中・同乗者操作でご利用ください。
          </p>
        </div>

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

          <div className="chips-row">
            <button
              className={`chip${favOnly ? " chip--on" : ""}`}
              onClick={() => setFavOnly((v) => !v)}
            >
              ★ お気に入りのみ{favs.size > 0 ? `（${favs.size}）` : ""}
            </button>
            <button className="chip" onClick={requestNear}>
              📍 現在地から近い順
            </button>
          </div>

          <div className="filters__row">
            <div className="field">
              <label>
                最低評価 <span className="range-val">★{filters.minRating.toFixed(1)}</span>
              </label>
              <input
                type="range"
                min={3.9}
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
                min={50}
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
        </div>

        {geoNotice && <div className="notice">{geoNotice}</div>}

        <div className="stats">
          <span>
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

        <div className="list">
          {view.map(({ s, km }) => (
            <div
              key={shopKey(s)}
              className={`shop${focus === s ? " active" : ""}`}
              onClick={() => select(s)}
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
                  title="お気に入り"
                >
                  {isFav(s) ? "★" : "☆"}
                </button>
                <button className="act" onClick={() => doShare(s)} title="共有">
                  共有
                </button>
                <a
                  className="act act--link"
                  href={s.mapsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  口コミ
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
          onSelect={select}
          theme={theme.resolved}
          userPos={geo.pos}
          isFav={isFav}
          onToggleFav={toggle}
          onNav={startNav}
          onShare={doShare}
          distanceTo={(s) => (geo.pos ? haversineKm(geo.pos, s) : null)}
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
            setToast(`「${s.name}」を${navLabel(app)}で起動しました`);
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
