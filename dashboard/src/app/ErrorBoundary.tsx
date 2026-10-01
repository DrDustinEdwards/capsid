import { Component, type ReactNode } from "react";
import { APP_URL } from "../lib/api";

// A render error shows what broke instead of a blank page.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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
    return (
      <div className="page">
        <div className="callout crit" role="alert">
          <b>The dashboard failed to render.</b> {e.message}. <a href={APP_URL}>Reload</a>
        </div>
      </div>
    );
  }
}
