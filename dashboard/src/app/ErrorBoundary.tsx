import { Banner } from "capsomer/react/banner";
import { Component, type ReactNode } from "react";
import { APP_URL } from "../lib/api";

// React 19 logs the caught error itself.
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="cap-admin-page">
        <Banner tone="crit">
          <b>The dashboard failed to render.</b> {e.message}. <a href={APP_URL}>Reload</a>
        </Banner>
      </div>
    );
  }
}
