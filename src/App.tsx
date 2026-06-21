import { useCallback, useEffect, useMemo, useState } from "react";
import RamenMap from "./components/RamenMap";
import SafetyGate from "./components/SafetyGate";
import NavPicker from "./components/NavPicker";
import Settings from "./components/Settings";
import {
  DEFAULT_RATING,
  GENRE_DEFS,
  genreTags,
  MIN_REVIEWS,
  RATING_FLOOR,
  REGIONS,
  type Filters,
  type Shop,
} from "./types";
import UpdatePrompt from "./UpdatePrompt";
import {
  fmtDistance,
  haversineKm,
  isSchemeApp,
  launchNav,
  multiStopUrl,
  NAV_APP_META,
  navAppsForPlatform,
  requestOrientationPermission,
  roughMinutes,
  shareNav,
  type NavApp,
} from "./nav";
import {
  shopKey,
  useFavorites,
  useNavApp,
  useSafetyAck,
  useShowTrack,
  useTheme,
} from "./storage";
import { useGeolocation, useMovementDetector } from "./hooks";
import shopsData from "./data/shops.json";
import genreOverridesData from "./data/genre-overrides.json";

const ALL_SHOPS = shopsData as Shop[];
// Web調査でジャンルを判定した店（placeId→ジャンルキー）。店名判定とマージする
const GENRE_OVERRIDES = genreOverridesData as Record<string, string>;

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
  genres: [],
  sort: "rating",
};

// 各店のジャンルを一度だけ計算（店名判定 ∪ Web調査による上書き）
const SHOP_GENRES = new Map<Shop, string[]>(
  ALL_SHOPS.map((s) => {
    const tags = new Set(genreTags(s.name));
    const ov = s.placeId ? GENRE_OVERRIDES[s.placeId] : undefined;
    if (ov) tags.add(ov);
    return [s, [...tags]];
  })
);

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [focus, setFocus] = useState<Shop | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [paneHidden, setPaneHidden] = useState(false);
  const [showPoi, setShowPoi] = useState(true); // コンビニ・GSは既定でON
  const [dest, setDest] = useState<Shop | null>(null); // 目的地
  const [showTrack, setShowTrack] = useShowTrack();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<Shop | null>(null);
  const [pickerFor, setPickerFor] = useState<Shop | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { favs, toggle, isFav, importKeys } = useFavorites();
  const [navApp, setNavApp] = useNavApp();
  const [safetyAck, setSafetyAck] = useSafetyAck();
  const theme = useTheme();
  const geo = useGeolocation();

  // 自動走行（常時オン）: 走行モードOFFの間は移動を監視し、走り出しで自動ON
  useMovementDetector(
    !follow,
    useCallback(() => {
      setFollow(true);
      setToast("移動を検知 → 走行モードに切替");
    }, [])
  );

  // 走行モードに入ったら左ペインを自動でしまう（地図を最大化）。終了したら元に戻す。
  // 走行中でも左端ハンドルから手動で開閉でき、その操作はこの効果では上書きしない（follow変化時のみ同期）
  useEffect(() => {
    setPaneHidden(follow);
    if (follow) setSheetOpen(false);
  }, [follow]);

  // 初回タップ時に方位センサー許可を取得（iOSはジェスチャ必須。自動走行でもコンパスを使えるように）
  useEffect(() => {
    const once = () => {
      requestOrientationPermission();
      window.removeEventListener("pointerdown", once);
    };
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

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
      if (
        filters.genres.length &&
        !filters.genres.some((g) => SHOP_GENRES.get(s)!.includes(g))
      )
        return false;
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

  // ジャンル別の件数（ジャンル以外の絞り込みを反映＝チップに今の該当数を表示）
  const genreCounts = useMemo(() => {
    const q = filters.query.trim();
    const c: Record<string, number> = {};
    for (const s of ALL_SHOPS) {
      if (s.rating < filters.minRating) continue;
      if (s.reviews < filters.minReviews) continue;
      if (filters.region !== "all" && s.region !== filters.region) continue;
      if (favOnly && !favs.has(shopKey(s))) continue;
      if (q && !(s.name.includes(q) || s.address.includes(q))) continue;
      for (const g of SHOP_GENRES.get(s)!) c[g] = (c[g] || 0) + 1;
    }
    return c;
  }, [
    filters.query,
    filters.minRating,
    filters.minReviews,
    filters.region,
    favOnly,
    favs,
  ]);

  const toggleGenre = (key: string) =>
    set(
      "genres",
      filters.genres.includes(key)
        ? filters.genres.filter((g) => g !== key)
        : [...filters.genres, key]
    );

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
      // 未同意なら「停車中ですか」を再確認
      if (!safetyAck) {
        setPendingNav(shop);
        return;
      }
      proceedNav(shop);
    },
    [safetyAck, proceedNav]
  );

  const doShare = useCallback(async (shop: Shop) => {
    const r = await shareNav(shop, shop.name);
    if (r === "copied") setToast("ナビリンクをコピーしました");
    else if (r === "failed") setToast("共有できませんでした");
    // "shared" / "cancelled" は通知不要
  }, []);

  const onSetDest = useCallback((shop: Shop) => {
    setDest(shop);
    setSheetOpen(false);
    setToast(`目的地に設定: ${shop.name}（走行モードで残り距離を表示）`);
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
    filters.genres.length > 0 ||
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
    <div className={`app${paneHidden ? " pane-hidden" : ""}`}>
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
            onClick={() => {
              const n = !follow;
              if (n) requestOrientationPermission(); // iOS: タップ内で方位許可
              setFollow(n);
              setToast(
                n
                  ? "走行モード: 自車を追従します（操作は停車中に）"
                  : "走行モードを終了しました"
              );
            }}
          >
            <span className="ic" aria-hidden="true">
              🧭
            </span>
            <span>走行</span>
          </button>
          <button
            className={`tool-btn${showPoi ? " on" : ""}`}
            aria-pressed={showPoi}
            onClick={() => {
              const n = !showPoi;
              setShowPoi(n);
              setToast(
                n
                  ? "周辺のコンビニ・GSを表示（地図を拡大すると出ます）"
                  : "コンビニ・GS表示をOFFにしました"
              );
            }}
          >
            <span className="ic" aria-hidden="true">
              🏪
            </span>
            <span>コンビニ</span>
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

          {dest && (
            <div className="dest-chip">
              <span>🎯 目的地: {dest.name}</span>
              <button onClick={() => setDest(null)} aria-label="目的地を解除">
                ✕
              </button>
            </div>
          )}

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

              <div className="field">
                <label>ジャンル（店名＋有名店は調査で判定）</label>
                <div className="chips-row">
                  {GENRE_DEFS.map((g) => (
                    <button
                      key={g.key}
                      className={`chip chip--sm${
                        filters.genres.includes(g.key) ? " chip--on" : ""
                      }`}
                      disabled={!genreCounts[g.key]}
                      onClick={() => toggleGenre(g.key)}
                    >
                      {g.label}（{genreCounts[g.key] || 0}）
                    </button>
                  ))}
                </div>
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
                <button
                  className={`act act--icon${dest === s ? " on" : ""}`}
                  onClick={() => onSetDest(s)}
                  aria-label="目的地に設定"
                  title="目的地に設定"
                >
                  🎯
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
        <button
          className="pane-handle"
          onClick={() => setPaneHidden((v) => !v)}
          aria-label={paneHidden ? "店舗一覧を表示" : "店舗一覧を隠す"}
          aria-expanded={!paneHidden}
          title={paneHidden ? "店舗一覧を表示" : "店舗一覧を隠す"}
        >
          {paneHidden ? "☰" : "‹"}
        </button>
        <RamenMap
          shops={shops}
          focus={focus}
          follow={follow}
          paneHidden={paneHidden}
          showPoi={showPoi}
          showTrack={showTrack}
          dest={dest}
          onSetDest={onSetDest}
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
          showTrack={showTrack}
          setShowTrack={setShowTrack}
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

      <UpdatePrompt />
    </div>
  );
}
