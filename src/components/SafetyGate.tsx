import { useEscape } from "../hooks";

interface Props {
  shopName: string;
  onAccept: () => void;
  onCancel: () => void;
}

/** 初回ナビ起動時の安全ゲート（道交法配慮・停車中前提のセルフ確認） */
export default function SafetyGate({ shopName, onAccept, onCancel }: Props) {
  useEscape(onCancel);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="safety-title">🚗 ナビを起動する前に</h2>
        <p className="modal__lead">
          <b>運転中のスマートフォンの操作・注視は道路交通法違反</b>です（ながら運転）。
        </p>
        <ul className="modal__list">
          <li>停車中に操作していますか？</li>
          <li>スマホは固定ホルダーに設置し、音声案内を使う準備はできていますか？</li>
          <li>可能なら<b>同乗者の端末</b>でナビを開いてもらってください（各店の「共有」が便利です）。</li>
        </ul>
        <p className="modal__small">
          このアプリは案内をGoogle/Apple/Yahoo!カーナビに引き継ぐだけで、自動で起動することはありません。
        </p>
        <div className="modal__actions">
          <button className="btn-ghost" onClick={onCancel}>
            やめる
          </button>
          <button className="btn-primary" onClick={onAccept}>
            了解（停車中です）→「{shopName}」へ
          </button>
        </div>
        <p className="modal__note">※この確認は次回から表示されません（設定で再表示できます）</p>
      </div>
    </div>
  );
}
