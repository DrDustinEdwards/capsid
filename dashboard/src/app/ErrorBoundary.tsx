import { Component, type ReactNode } from "react";
import { APP_URL } from "../lib/api";

// A render error shows what broke instead of a blank page. With a fallback it holds one part
// of a page, so the rest stays up.
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Watch Floor: render failed", error);
  }

  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    // A part of a page (a lazy chart whose chunk did not load) shows its own small message.
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="page">
        <div className="callout crit" role="alert">
          <b>The dashboard failed to render.</b> {e.message}. <a href={APP_URL}>Reload</a>
        </div>
      </div>
    );
  }
}
