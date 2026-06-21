import React from "react";
import ReactDOM from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import App from "./App";

// 走行軌跡など端末内保存(localStorage)が、容量逼迫やITPで消されにくくなるよう永続化を要求。
// インストール済みPWAでは多くの場合付与される（拒否されても通常の保存は機能する）。
navigator.storage?.persist?.().catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
