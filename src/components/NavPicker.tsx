import { NAV_APP_META, type NavApp } from "../nav";
import { useEscape } from "../hooks";

interface Props {
  shopName: string;
  apps: NavApp[];
  onPick: (app: NavApp) => void;
  onCancel: () => void;
}

/** ナビアプリ選択（初回のみ。選んだものは既定として記憶される） */
export default function NavPicker({ shopName, apps, onPick, onCancel }: Props) {
  useEscape(onCancel);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="navpick-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="navpick-title">どのナビで案内する？</h2>
        <p className="modal__small">「{shopName}」へ。選んだアプリは次回から既定になります（設定で変更可）。</p>
        <div className="navpick">
          {apps.map((key) => {
            const meta = NAV_APP_META[key];
            return (
              <button key={key} className="navpick__btn" onClick={() => onPick(key)}>
                <span className="navpick__label">🚗 {meta.label}</span>
                <span className="navpick__note">{meta.note}</span>
              </button>
            );
          })}
        </div>
        <div className="modal__actions">
          <button className="btn-ghost" onClick={onCancel}>
            やめる
          </button>
        </div>
      </div>
    </div>
  );
}
