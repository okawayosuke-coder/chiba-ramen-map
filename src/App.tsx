import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import RamenMap from "./components/RamenMap";
import SafetyGate from "./components/SafetyGate";
import NavPicker from "./components/NavPicker";
import Settings from "./components/Settings";
import ErrorBoundary from "./components/ErrorBoundary";
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
  type Dest,
} from "./nav";
import {
  shopKey,
  useBigLabels,
  useGyroGrade,
  useHeadingUp,
  useFavorites,
  useHwOverride,
  useNavApp,
  usePoiKinds,
  useSafetyAck,
  useShowTrack,
  useTraffic,
  useThreeD,
  useHome,
  useRecentDests,
  useTheme,
} from "./storage";
import { geocodePlaces, type PlaceHit } from "./geocode";
import { useGeolocation, useMovementDetector } from "./hooks";
import { downloadTrackGPX, trackStats } from "./track";
import {
  buildSearchKey,
  matchesQuery,
  parseQuery,
  scoreQuery,
  type SearchKey,
} from "./search";
import shopsData from "./data/shops.json";
import genreOverridesData from "./data/genre-overrides.json";
import metaData from "./data/meta.json";

// Mapbox 版地図（試験・URL に ?engine=mapbox で有効化）。
// mapbox-gl(約1MB)は lazy import で別チャンク化し、既定(Leaflet)利用者には読み込ませない。
const RamenMapbox = lazy(() => import("./components/RamenMapbox"));
// 地図エンジン選択。【既定=Mapbox】。?engine=leaflet で従来のLeaflet版に切替（記憶）。
// ?engine=mapbox で既定へ戻す。クエリ無し（ホーム画面アイコン起動含む）は、明示的に
// leaflet を選んでいない限り Mapbox。iOSのPWAはSafariと別ストレージだが「空＝既定Mapbox」
// なのでインストール版でもMapboxで起動する。
const ENGINE_MAPBOX = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get("engine");
    if (q === "leaflet" || q === "off") {
      localStorage.setItem("crm_engine", "leaflet");
      return false;
    }
    if (q === "mapbox") {
      localStorage.removeItem("crm_engine");
      return true;
    }
    return localStorage.getItem("crm_engine") !== "leaflet";
  } catch {
    return true;
  }
})();

const ALL_SHOPS = shopsData as Shop[];
// Web調査でジャンルを判定した店（placeId→ジャンルキー）。店名判定とマージする
const GENRE_OVERRIDES = genreOverridesData as Record<string, string>;

// データ最終更新日（refine.py が収集時のJST日付を meta.json に書き込む）
const DATA_UPDATED = (() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((metaData as { updatedAt?: string }).updatedAt ?? "");
  return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : null;
})();

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

// あいまい検索用の正規化キー（店名＋読み仮名＋住所＋ジャンル）を一度だけ計算。
// 読み仮名(reading)で漢字店名を「むさし/musashi」等の読みで引け、ジャンルラベルで
// 「つけ麺」「豚骨」等の系統名でも引ける。
const GENRE_LABEL = new Map(GENRE_DEFS.map((g) => [g.key, g.label]));
const SHOP_SEARCH = new Map<Shop, SearchKey>(
  ALL_SHOPS.map((s) => {
    const genres = (SHOP_GENRES.get(s) || [])
      .map((k) => GENRE_LABEL.get(k) || "")
      .join(" ");
    return [
      s,
      buildSearchKey(`${s.name} ${s.reading ?? ""} ${s.address} ${genres}`),
    ];
  })
);

// 関連度の並べ替え用に「店名＋読み」だけのキーも持つ（住所/ジャンルより店名一致を上位に）
const SHOP_NAME = new Map<Shop, SearchKey>(
  ALL_SHOPS.map((s) => [s, buildSearchKey(`${s.name} ${s.reading ?? ""}`)])
);

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [focus, setFocus] = useState<Shop | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false); // 最近の目的地は既定折りたたみ（固定部を空ける）
  const [follow, setFollow] = useState(false);
  const [paneHidden, setPaneHidden] = useState(false);
  const [showPoi, setShowPoi] = useState(true); // 周辺POIレイヤーの全体ON/OFF（既定ON）
  const [poiKinds, setPoiKinds] = usePoiKinds(); // 表示する種類（既定: コンビニ・GS）
  const [dest, setDest] = useState<Dest | null>(null); // 目的地（店 or 周辺POI）
  const [showTrack, setShowTrack] = useShowTrack();
  const [bigLabels, setBigLabels] = useBigLabels();
  const [gyroGrade, setGyroGrade] = useGyroGrade();
  const [headingUp, setHeadingUp] = useHeadingUp();
  const [traffic, setTraffic] = useTraffic();
  const [threeD, setThreeD] = useThreeD();
  const [home, setHome] = useHome(); // 自宅（端末内のみ保存）。🏠帰宅ボタンの目的地
  const { recents, push: pushRecent, clear: clearRecents } = useRecentDests(); // 最近の目的地（端末内のみ）
  // 検索ボックスの入力を地名/駅/施設/住所として解決した候補（ラーメン店に限らず任意地点を目的地化）
  const [placeHits, setPlaceHits] = useState<PlaceHit[]>([]);
  const addrReqRef = useRef(0); // ジオコーディングの競合（古い応答）を捨てるための連番
  // 検索候補タップ後の「決定前プレビュー」地点（地図にピン＋確認ポップアップを出す→決定でルート化）
  const [candidate, setCandidate] = useState<{ lat: number; lng: number; name: string; subtitle?: string } | null>(null);
  const [recenterTick, setRecenterTick] = useState(0); // 「地図で見る」で地図を目的地へ寄せる信号
  const [hwOverride, cycleHwOverride] = useHwOverride(); // 高速道路切り替え（手動: 自動/高速/一般道）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<Dest | null>(null);
  const [pickerFor, setPickerFor] = useState<Dest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 走行終了後のバックアップ案内 / 端末ストレージの永続化警告
  const [backupPrompt, setBackupPrompt] = useState<{ km: number } | null>(null);
  const [persistWarn, setPersistWarn] = useState(false);
  const prevFollowRef = useRef(false);
  const followStartCountRef = useRef(0);
  const pendingAppRef = useRef<NavApp | null>(null); // 安全ゲート通過後に起動するナビアプリ

  const { favs, toggle, isFav, importKeys } = useFavorites();
  const [navApp, setNavApp] = useNavApp();
  const [safetyAck, setSafetyAck] = useSafetyAck();
  const geo = useGeolocation();
  const theme = useTheme(geo.pos);

  // 全体OFFなら空＝何も取得・表示しない。ONなら選択中の種類を表示
  const activePoiKinds = useMemo(
    () => (showPoi ? poiKinds : []),
    [showPoi, poiKinds]
  );

  // 走行モード終了時、その走行で軌跡が増えていれば GPX 保存を案内（iOSは保存データを消すことがあるため）
  useEffect(() => {
    if (follow && !prevFollowRef.current) {
      followStartCountRef.current = trackStats().count;
    } else if (!follow && prevFollowRef.current) {
      const st = trackStats();
      if (st.count - followStartCountRef.current >= 5)
        setBackupPrompt({ km: st.km });
    }
    prevFollowRef.current = follow;
  }, [follow]);

  // 端末内保存の永続化を要求し、許可されなければ一度だけ警告（消失リスクの周知）
  useEffect(() => {
    (async () => {
      try {
        const sm = navigator.storage;
        if (!sm?.persisted) return;
        await sm.persist?.();
        const ok = await sm.persisted();
        if (!ok && !localStorage.getItem("crm_persist_warned"))
          setPersistWarn(true);
      } catch {
        /* noop */
      }
    })();
  }, []);
  const dismissPersistWarn = () => {
    try {
      localStorage.setItem("crm_persist_warned", "1");
    } catch {
      /* noop */
    }
    setPersistWarn(false);
  };


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

  // 方位センサー許可は「走行モードON」の意図的タップ内でのみ要求する（App.tsx の走行ボタン）。
  // 以前はページ最初のpointerdown(どのタップでも)で要求していたが、起動直後に予期せずダイアログが
  // 出て煩わしいため廃止。コンパス自体は走行モードに入れば従来どおり常時有効。

  // 「日の入りで自動」テーマ選択時、現在地が未取得なら一度だけ取得
  useEffect(() => {
    if (theme.pref === "sun" && !geo.pos && geo.status === "idle") geo.request();
  }, [theme.pref, geo]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const view = useMemo(() => {
    const qterms = parseQuery(filters.query);
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
      if (qterms && !matchesQuery(SHOP_SEARCH.get(s)!, qterms)) return false;
      return true;
    }).map((s) => ({
      s,
      km: geo.pos ? haversineKm(geo.pos, s) : null,
      // 検索時の関連度（店名/読み一致を上位に。住所/ジャンルだけの一致は下位）
      score: qterms ? scoreQuery(SHOP_NAME.get(s)!, qterms) : 0,
    }));

    arr.sort((a, b) => {
      // 検索中は関連度を最優先（同点なら選択中の並び順）
      if (qterms && b.score !== a.score) return b.score - a.score;
      if (filters.sort === "near" && a.km != null && b.km != null)
        return a.km - b.km;
      if (filters.sort === "reviews") return b.s.reviews - a.s.reviews;
      if (filters.sort === "name") return a.s.name.localeCompare(b.s.name, "ja");
      return b.s.rating - a.s.rating || b.s.reviews - a.s.reviews;
    });
    return arr;
  }, [filters, favOnly, favs, geo.pos]);

  const shops = useMemo(() => view.map((v) => v.s), [view]);
  // 地図のラーメンピンは「検索テキストでは絞り込まない」＝目的地キーワード検索(佐倉駅 等)や店名検索の入力で
  // 地図からピンが消えないように、必ず表示する。評価/レビュー/エリア/ジャンル/お気に入りの絞り込みは反映。
  const mapShops = useMemo(
    () =>
      ALL_SHOPS.filter((s) => {
        if (s.rating < filters.minRating) return false;
        if (s.reviews < filters.minReviews) return false;
        if (filters.region !== "all" && s.region !== filters.region) return false;
        if (filters.genres.length && !filters.genres.some((g) => SHOP_GENRES.get(s)!.includes(g))) return false;
        if (favOnly && !favs.has(shopKey(s))) return false;
        return true;
      }),
    [filters.minRating, filters.minReviews, filters.region, filters.genres, favOnly, favs]
  );

  // ジャンル別の件数（ジャンル以外の絞り込みを反映＝チップに今の該当数を表示）
  const genreCounts = useMemo(() => {
    const qterms = parseQuery(filters.query);
    const c: Record<string, number> = {};
    for (const s of ALL_SHOPS) {
      if (s.rating < filters.minRating) continue;
      if (s.reviews < filters.minReviews) continue;
      if (filters.region !== "all" && s.region !== filters.region) continue;
      if (favOnly && !favs.has(shopKey(s))) continue;
      if (qterms && !matchesQuery(SHOP_SEARCH.get(s)!, qterms)) continue;
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
    (d: Dest) => {
      if (!navApp) {
        setPickerFor(d);
        return;
      }
      launchNav(navApp, d, d.name);
      setToast(navToast(navApp, d.name));
    },
    [navApp]
  );

  // 「Googleマップ」ボタン: Googleマップで外部ナビ起動（安全ゲート経由）
  const startGoogleNav = useCallback(
    (target: Dest) => {
      if (!safetyAck) {
        pendingAppRef.current = "google";
        setPendingNav(target);
        return;
      }
      launchNav("google", target, target.name);
      setToast(navToast("google", target.name));
    },
    [safetyAck]
  );

  const doShare = useCallback(async (shop: Shop) => {
    const r = await shareNav(shop, shop.name);
    if (r === "copied") setToast("ナビリンクをコピーしました");
    else if (r === "failed") setToast("共有できませんでした");
    // "shared" / "cancelled" は通知不要
  }, []);

  const onSetDest = useCallback(
    (d: Dest) => {
      setDest(d);
      pushRecent(d); // 店舗/POI/住所/地図長押し、どの入口でも履歴に残す
      setSheetOpen(false);
      setToast(`目的地に設定: ${d.name}（走行モードで残り距離を表示）`);
    },
    [pushRecent]
  );

  // 検索ボックスの入力を地名/駅/施設/住所として解決（Mapbox Search Box・デバウンス）。解決できたら
  // 検索結果の先頭に候補行（📍地名・住所）を複数出す（自動では目的地化しない＝誤爆防止）。「佐倉駅」等の
  // キーワード/POIも解決できる。店名検索（shops.json 照合）はこれと独立に従来どおり並行動作する。
  useEffect(() => {
    const q = filters.query.trim();
    if (q.length < 2) {
      setPlaceHits([]);
      return;
    }
    const id = ++addrReqRef.current;
    const t = setTimeout(async () => {
      const r = await geocodePlaces(q, geo.pos); // 現在地を近接ヒントに（近い候補を上位へ）
      if (id !== addrReqRef.current) return; // 古い応答は捨てる
      setPlaceHits(r);
    }, 400);
    return () => clearTimeout(t);
  }, [filters.query, geo.pos]);

  // 候補行をタップ → 即ルート化せず、まず地図にプレビュー（ピン＋確認ポップアップ）。
  // 地図上で「🧭 ここへ案内」を押して初めて目的地確定＝ルート化（RamenMapbox の candidate effect が担当）。
  const onSetDestFromPlace = useCallback((p: PlaceHit) => {
    // 走行モードは解除しない（HUD・「現在地」ボタンを残す）。カメラ追従の一時停止は RamenMapbox の
    // candidate effect が followApiRef.suspend() で行い、プレビュー後は「現在地」タップで追従復帰。
    setCandidate({ lat: p.lat, lng: p.lng, name: p.title, subtitle: p.subtitle });
    setPlaceHits([]); // 候補リストを閉じる
    setSheetOpen(false); // 狭い画面ではサイドシートを閉じて地図を見せる
  }, []);

  // この店が現在の目的地か（座標一致で判定）。最近の目的地チップ等で dest が
  // 店オブジェクトと別参照になっても「🧭 ルート」ボタンを正しく点灯させる。
  const isDestHere = useCallback(
    (s: Shop) =>
      !!dest && Math.abs(dest.lat - s.lat) < 1e-6 && Math.abs(dest.lng - s.lng) < 1e-6,
    [dest]
  );

  // 目的地までの直線距離（現在地があるときだけ）
  const destDist = dest && geo.pos ? haversineKm(geo.pos, dest) : null;

  // 目的地カード:「🧭 地図で見る」＝地図を目的地（＋現在地）へ寄せる
  const onShowDestOnMap = useCallback(() => setRecenterTick((t) => t + 1), []);

  // 目的地カード:「共有」＝任意目的地のナビリンクを共有
  const doShareDest = useCallback(async (d: Dest) => {
    const r = await shareNav(d, d.name);
    if (r === "copied") setToast("ナビリンクをコピーしました");
    else if (r === "failed") setToast("共有できませんでした");
  }, []);

  const onClearDest = useCallback(() => {
    setDest(null);
    // 解除はクリーンな状態へ戻す＝残った検索語も消して「最近の目的地」を再表示する
    setFilters((f) => (f.query ? { ...f, query: "" } : f));
    setToast("目的地を解除しました");
  }, []);

  // 🏠帰宅: 自宅を目的地に設定。未登録なら設定の登録を促す。
  const onGoHome = useCallback(() => {
    if (home) {
      setDest(home);
      setSheetOpen(false);
      setToast(`自宅へ向かいます: ${home.name}`);
    } else {
      setToast("先に「設定 → 自宅」で自宅を登録してください");
      setSettingsOpen(true);
    }
  }, [home]);

  // テスト用フック（?sim=drive のときだけ）。eval から任意座標を目的地に設定でき、
  // 店舗位置に縛られず特定の高速区間（例: 館山道の市原SA）を通るルートを検証できる。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("sim") !== "drive") return;
    (window as unknown as Record<string, unknown>).__setDest = (
      lat: number,
      lng: number,
      name = "テスト目的地"
    ) => {
      setDest({ lat, lng, name });
      return { lat, lng, name };
    };
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
        {/* ブランディング＋ツールバーはスクロールで退避（固定領域を空けて一覧を最大化） */}
        <div className="sidebar__header">
          <h1 className="brand">
            <img
              className="brand__logo"
              src={`${import.meta.env.BASE_URL}techmagic-logo.svg`}
              alt="TECHMAGIC"
            />
            <span className="brand__navi">Navi</span>
          </h1>
          <p>千葉県＋江東区・江戸川区＋茨城県南（つくば・土浦ほか）／カーナビ起動対応</p>
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
                  ? "周辺の施設を表示（地図を拡大すると出ます・種類は設定で選択）"
                  : "周辺施設の表示をOFFにしました"
              );
            }}
          >
            <span className="ic" aria-hidden="true">
              🏪
            </span>
            <span>周辺</span>
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

        {/* 上部固定（最小）: 検索＋チップ＋(設定済みのみ)目的地ミニカード。一覧を最大化するためここだけ固定 */}
        <div className="sidebar__controls">
          {dest && (
            <div className="dest-mini">
              <div className="dest-mini__top">
                <span className="dest-mini__name">🎯 {dest.name}</span>
                <button
                  className="dest-mini__x"
                  onClick={onClearDest}
                  aria-label="目的地を解除"
                  title="目的地を解除"
                >
                  ✕
                </button>
              </div>
              {destDist != null && (
                <div className="dest-mini__dist">
                  📍 直線{fmtDistance(destDist)}・車約{roughMinutes(destDist)}分
                </div>
              )}
              <div className="dest-mini__actions">
                <button
                  className="act act--route"
                  onClick={onShowDestOnMap}
                  title="地図で目的地・ルートを表示"
                >
                  🧭 地図で見る
                </button>
                <button
                  className="act act--nav"
                  onClick={() => startGoogleNav(dest)}
                  title="Googleマップでナビ起動"
                >
                  🚗 ナビ
                </button>
                <button
                  className="act"
                  onClick={() => doShareDest(dest)}
                  title="ナビリンクを共有"
                >
                  共有
                </button>
              </div>
            </div>
          )}

          <div className="field">
            <input
              type="text"
              aria-label="店名・住所・場所で検索"
              placeholder="🔍 店名・住所・場所で検索"
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
        </div>

        {/* ここから下はスクロール領域（固定しない）＝絞り込みを開いても一覧を押し出さない */}
        {!dest && (
          <div className="dest-setup">
            <div className="dest-setup__head">🎯 目的地を設定（店以外も）</div>
            <div className="dest-methods">
              <button
                className="dest-method"
                onClick={() =>
                  setToast("地図を長押しすると、その地点を目的地に設定できます")
                }
                title="地図を長押しすると、その地点を目的地にできます"
              >
                📍 地図を長押し
              </button>
              <button
                className="dest-method"
                onClick={onGoHome}
                title="自宅を目的地に設定"
              >
                🏠 自宅へ
              </button>
              {recents.length > 0 && (
                <button
                  className={`dest-method${recentsOpen ? " dest-method--on" : ""}`}
                  onClick={() => setRecentsOpen((o) => !o)}
                  aria-expanded={recentsOpen}
                  title="最近の目的地"
                >
                  🕘 最近{recentsOpen ? " ▲" : `（${recents.length}）▼`}
                </button>
              )}
            </div>
            {recents.length > 0 && recentsOpen && (
              <div className="recent-row">
                <div className="chips-row">
                  {recents.map((r, i) => (
                    <button
                      key={`${r.lat},${r.lng},${i}`}
                      className="chip chip--recent"
                      onClick={() => onSetDest(r)}
                      title={`「${r.name}」を目的地に設定`}
                    >
                      {r.name}
                    </button>
                  ))}
                  <button
                    className="chip chip--clear"
                    onClick={clearRecents}
                    title="最近の目的地の履歴を消去"
                  >
                    消去
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {filtersOpen && (
          <div className="filters">
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
          </div>
        )}

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

        {DATA_UPDATED && (
          <p className="data-updated">
            データ最終更新: {DATA_UPDATED}（Google マップ情報・閉店の場合あり）
          </p>
        )}

        {favOnly && shops.length >= 2 && (
          <button className="hashigo-btn" onClick={hashigo}>
            🍜🚗 お気に入り{shops.length}件で「はしご」ルートを作成（Googleマップ）
          </button>
        )}

        <div className="list">
          {placeHits.map((p, i) => (
            <button
              key={`${p.lat},${p.lng},${i}`}
              className="addr-suggest"
              onClick={() => onSetDestFromPlace(p)}
              title={`「${p.title}」を目的地に設定`}
            >
              <span className="addr-suggest__ic" aria-hidden="true">
                📍
              </span>
              <span className="addr-suggest__txt">
                <span className="addr-suggest__t">{p.title}</span>
                {p.subtitle && <span className="addr-suggest__a">{p.subtitle}</span>}
              </span>
              <span className="addr-suggest__go">設定 →</span>
            </button>
          ))}
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
                <button
                  className="act act--nav"
                  onClick={() => startGoogleNav(s)}
                  title="Googleマップでナビ起動"
                >
                  🚗 Googleマップ
                </button>
                <button
                  className={`act act--route${isDestHere(s) ? " on" : ""}`}
                  onClick={() => onSetDest(s)}
                  title="アプリ内で道なりルートを表示"
                >
                  🧭 ルート
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
        <button
          className="pane-handle"
          onClick={() => setPaneHidden((v) => !v)}
          aria-label={paneHidden ? "店舗一覧を表示" : "店舗一覧を隠す"}
          aria-expanded={!paneHidden}
          title={paneHidden ? "店舗一覧を表示" : "店舗一覧を隠す"}
        >
          {paneHidden ? "☰" : "‹"}
        </button>
        <ErrorBoundary label="map" message="地図の表示で問題が発生しました。再読み込みしてください（店舗一覧は引き続き使えます）。">
          {(() => {
            // 地図 props は1箇所で定義し、Leaflet版/Mapbox版どちらにも同じものを渡す。
            const mapProps = {
              shops: mapShops, // 地図のピンは検索テキストで消さない（常時表示）。リスト/はしごは絞り込み後の shops を使用
              focus,
              follow,
              paneHidden,
              poiKinds: activePoiKinds,
              showTrack,
              bigLabels,
              gyroGrade,
              headingUp,
              theme: theme.resolved, // 夜間/ライト: Mapboxは地図スタイルをdark/lightに切替（Leafletはタイルにフィルタ）
              traffic, // リアルタイム渋滞表示（Mapbox Traffic v1）
              threeD, // 3D表示（地形＋3D建物＋俯瞰ピッチ）
              onToggle3D: () => setThreeD(!threeD), // 地図上の「3D」ボタン用（縮尺ボタンの下）
              onToggleHeadingUp: () => setHeadingUp(!headingUp), // 地図上の方位コンパスボタン用（3Dボタンの下・設定チップと同一state）
              hwOverride,
              onCycleHwOverride: cycleHwOverride,
              dest,
              onSetDest,
              onClearDest,
              candidate, // 検索候補の決定前プレビュー（地図にピン＋確認ポップアップ）
              onCandidateClose: () => setCandidate(null), // 決定/取消でプレビューを閉じる
              recenterDest: recenterTick, // 「地図で見る」で目的地へカメラを寄せる信号
              home, // 自宅（地図の🏠帰宅ボタン表示判定）
              onGoHome, // 🏠帰宅ボタン: 自宅を目的地に設定
              userPos: geo.pos,
              isFav,
              onToggleFav: toggle,
              onNav: startGoogleNav,
              onShare: doShare,
              distanceTo,
            };
            return ENGINE_MAPBOX ? (
              <Suspense fallback={<div className="map" />}>
                <RamenMapbox {...mapProps} />
              </Suspense>
            ) : (
              <RamenMap {...mapProps} />
            );
          })()}
        </ErrorBoundary>
      </div>

      {pendingNav && (
        <SafetyGate
          shopName={pendingNav.name}
          onAccept={() => {
            setSafetyAck(true);
            const s = pendingNav;
            setPendingNav(null);
            const app = pendingAppRef.current;
            pendingAppRef.current = null;
            if (app) {
              launchNav(app, s, s.name);
              setToast(navToast(app, s.name));
            } else {
              proceedNav(s);
            }
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
          bigLabels={bigLabels}
          setBigLabels={setBigLabels}
          gyroGrade={gyroGrade}
          setGyroGrade={setGyroGrade}
          headingUp={headingUp}
          setHeadingUp={setHeadingUp}
          traffic={traffic}
          setTraffic={setTraffic}
          threeD={threeD}
          setThreeD={setThreeD}
          home={home}
          setHome={setHome}
          currentPos={geo.pos}
          showPoi={showPoi}
          setShowPoi={setShowPoi}
          poiKinds={poiKinds}
          setPoiKinds={setPoiKinds}
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

      {backupPrompt && (
        <div className="update-bar" role="status">
          <span className="update-bar__msg">
            🛰️ 今の走行軌跡（約{backupPrompt.km.toFixed(1)}km）をGPXで保存しますか？
            <br />
            端末内のデータはiOS等が自動削除する場合があります
          </span>
          <div className="update-bar__btns">
            <button
              className="update-bar__go"
              onClick={() => {
                downloadTrackGPX();
                setBackupPrompt(null);
              }}
            >
              GPXで保存
            </button>
            <button
              className="update-bar__later"
              onClick={() => setBackupPrompt(null)}
            >
              後で
            </button>
          </div>
        </div>
      )}

      {!backupPrompt && persistWarn && (
        <div className="update-bar" role="status">
          <span className="update-bar__msg">
            ⚠️ この端末では保存データが自動削除されることがあります。大事な走行軌跡は設定からGPXで書き出しを。
          </span>
          <div className="update-bar__btns">
            <button className="update-bar__later" onClick={dismissPersistWarn}>
              了解
            </button>
          </div>
        </div>
      )}

      <UpdatePrompt />
    </div>
  );
}
