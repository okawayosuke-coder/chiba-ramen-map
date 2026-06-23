import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** ログ識別用ラベル（例: "map" / "app"） */
  label?: string;
  /** 失敗時の見出し（既定: 表示中に問題が発生しました） */
  message?: string;
}
interface State {
  hasError: boolean;
}

/** 描画/effect時の例外を捕捉し、全画面が白くなるのを防ぐ。
 *  フォールバックUI（再読み込み/再試行）を出し、原因はコンソールに残す。
 *  ※イベントハンドラや非同期コールバック内の例外は対象外（Reactの仕様）。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // 白画面の代わりに原因を残す
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary${this.props.label ? ":" + this.props.label : ""}]`,
      error,
      info
    );
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="errboundary" role="alert">
        <p className="errboundary__msg">
          {this.props.message ?? "表示中に問題が発生しました。"}
        </p>
        <div className="errboundary__btns">
          <button
            className="errboundary__btn"
            onClick={() => window.location.reload()}
          >
            再読み込み
          </button>
          <button
            className="errboundary__btn errboundary__btn--ghost"
            onClick={() => this.setState({ hasError: false })}
          >
            再試行
          </button>
        </div>
      </div>
    );
  }
}
