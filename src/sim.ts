// 走行シミュレーション（テスト用）。URL に ?sim=drive を付けたときだけ有効。
// 実機GPSが無いPC等で「前方を広く表示」する追従や自車補間を目視確認するためのもの。
// 前進は自動。←/→ キーで 90度ずつ左右に曲がれる（左90°ターン等の確認用）。
// navigator.geolocation を擬似化し、現在の進行方位へ一定速度で進むフィックスを約1Hzで供給する。
// コールバックは実GPSと同様に必ず非同期で呼ぶ（同期呼び出しは購読側の初期化途中に走り得るため）。

const enabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("sim") === "drive";

if (enabled) {
  let speedMs = 12; // 約43km/h（↑/↓で増減）
  const TICK_MS = 1000; // 1秒ごとにフィックス供給
  const TURN_RATE = 35; // 1tickで目標方位へ寄せる角度（90°ターンを約3秒で）

  // 既定は千葉市付近スタート。?simstart=lat,lng で開始地点を上書き可（検証用）。
  let lat = 35.61;
  let lng = 140.12;
  const startParam = new URLSearchParams(window.location.search).get("simstart");
  if (startParam) {
    const [pLat, pLng] = startParam.split(",").map(Number);
    if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
      lat = pLat;
      lng = pLng;
    }
  }
  let heading = 0; // 現在の進行方位(deg, 0=北)
  let target = 0; // 目標方位（←/→で±90）

  const norm = (d: number) => ((d % 360) + 360) % 360;
  const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

  const advance = () => {
    // 目標方位へ滑らかに（最大TURN_RATE/tick）寄せる
    const d = angDiff(target, heading);
    heading = norm(heading + Math.max(-TURN_RATE, Math.min(TURN_RATE, d)));
    // 現在方位へ前進
    const distM = speedMs * (TICK_MS / 1000);
    const rad = (heading * Math.PI) / 180;
    lat += (distM * Math.cos(rad)) / 111320;
    lng += (distM * Math.sin(rad)) / (111320 * Math.cos((lat * Math.PI) / 180));
  };

  // ?nohead=1 で coords.heading を null に（GPS方位非対応端末の検証用）
  const noHead =
    new URLSearchParams(window.location.search).get("nohead") === "1";
  const makePos = (): GeolocationPosition =>
    ({
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy: 6,
        altitude: null,
        altitudeAccuracy: null,
        heading: noHead ? null : heading,
        speed: speedMs,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);

  const listeners = new Set<PositionCallback>();
  const geo = navigator.geolocation as unknown as Record<string, unknown>;
  geo.getCurrentPosition = (cb: PositionCallback) => {
    const p = makePos();
    window.setTimeout(() => cb(p), 0);
  };
  geo.watchPosition = (cb: PositionCallback) => {
    listeners.add(cb);
    window.setTimeout(() => cb(makePos()), 0);
    return listeners.size;
  };
  geo.clearWatch = () => {};

  const fire = () => {
    const p = makePos();
    listeners.forEach((cb) => {
      try {
        cb(p);
      } catch {
        /* noop */
      }
    });
  };

  window.setInterval(() => {
    advance();
    fire();
  }, TICK_MS);

  // テスト用の手動操作フック（?sim=drive のときだけ存在）。ヘッドレスでの
  // タイマースロットリングに左右されず、eval から決定論的に走行を進められる。
  (window as unknown as Record<string, unknown>).__sim = {
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) advance();
      fire();
      return [lat, lng, heading];
    },
    set: (la: number, ln: number, hd?: number) => {
      lat = la;
      lng = ln;
      if (typeof hd === "number") {
        heading = hd;
        target = hd;
      }
      fire();
      return [lat, lng, heading];
    },
    turn: (d: number) => {
      target = norm(target + d);
      return target;
    },
    pos: () => [lat, lng, heading],
  };

  // ←/→ で90°ずつ曲がる、↑/↓ で±10km/h
  const hint = document.createElement("div");
  const render = () => {
    hint.textContent = `🧪 走行シミュ  ${Math.round(
      speedMs * 3.6
    )}km/h  進行${Math.round(heading)}°  ←/→曲がる ↑/↓加減速`;
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "ArrowLeft") target = norm(target - 90);
      else if (e.key === "ArrowRight") target = norm(target + 90);
      else if (e.key === "ArrowUp")
        speedMs = Math.min(41.7, speedMs + 2.78); // +10km/h（上限約150）
      else if (e.key === "ArrowDown")
        speedMs = Math.max(0, speedMs - 2.78); // -10km/h
      else return;
      e.preventDefault();
      render();
    },
    true
  );

  const start = () => {
    hint.style.cssText =
      "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,.8);color:#fff;font:700 13px/1.4 monospace;padding:7px 14px;border-radius:10px;pointer-events:none;white-space:nowrap";
    render();
    document.body.appendChild(hint);
  };
  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start);

  // eslint-disable-next-line no-console
  console.log(
    "🧪 走行シミュレーション ON（?sim=drive）。数秒で走行モードに入ります。←/→＝90°ターン、↑/↓＝±10km/h。"
  );
}
