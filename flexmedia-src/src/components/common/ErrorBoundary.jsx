import { AlertTriangle, RefreshCw, ChevronDown, Home, Bug } from "lucide-react";
import { Component } from "react";

/**
 * Reusable error boundary with a polished fallback UI.
 *
 * Props:
 *   - fallbackLabel (string)   – optional heading override, e.g. "Calendar"
 *   - compact       (boolean)  – render a smaller inline variant for widgets
 *   - onReset       (function) – called after the internal state resets
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, showStack: false, resetKey: 0 };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Always log to console with component stack for debugging
    console.error(
      `[ErrorBoundary${this.props.fallbackLabel ? ` :: ${this.props.fallbackLabel}` : ""}] Caught error:`,
      error
    );
    console.error("[ErrorBoundary] Component stack:", errorInfo?.componentStack);

    this.setState({ errorInfo });
  }

  // Reset error state when the resetKey prop changes (e.g. on route navigation)
  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      // BUG FIX: also increment internal resetKey so children remount with a new key,
      // preventing the same broken component from immediately re-throwing
      this.setState(s => ({ hasError: false, error: null, errorInfo: null, showStack: false, resetKey: s.resetKey + 1 }));
    }
  }

  handleReset = () => {
    // Increment internal resetKey to force children to remount via key change
    this.setState(s => ({ hasError: false, error: null, errorInfo: null, showStack: false, resetKey: s.resetKey + 1 }));
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env?.DEV;
      const errorMessage = this.state.error?.message || "An unexpected error occurred";
      const stackTrace = this.state.error?.stack || "";
      const componentStack = this.state.errorInfo?.componentStack || "";
      const label = this.props.fallbackLabel;

      /* ── Compact variant for widgets / cards ────────────────────────────── */
      if (this.props.compact) {
        return (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/40 flex items-center justify-center mb-3">
              <AlertTriangle className="h-5 w-5 text-red-500" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              {label ? `${label} failed to load` : "Failed to load"}
            </p>
            <p className="text-xs text-muted-foreground mb-4 max-w-xs">{errorMessage}</p>
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Try Again
            </button>
          </div>
        );
      }

      /* ── Full-page / route-level variant ────────────────────────────────── */
      return (
        <div className="flex items-center justify-center min-h-[50vh] px-6 py-16">
          <div className="w-full max-w-lg">
            {/* Icon */}
            <div className="flex justify-center mb-6">
              <div className="relative">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-red-50 to-red-100 dark:from-red-950/50 dark:to-red-900/30 flex items-center justify-center shadow-sm">
                  <AlertTriangle className="h-8 w-8 text-red-500" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shadow-md">
                  <Bug className="h-3 w-3 text-white" />
                </div>
              </div>
            </div>

            {/* Heading & description */}
            <div className="text-center mb-8">
              <h2 className="text-xl font-semibold tracking-tight mb-2">
                {label ? `${label} encountered an error` : "Something went wrong"}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
                {errorMessage}
              </p>
              <p className="text-xs text-muted-foreground/70 mt-2">
                If this keeps happening, try refreshing the page or contact support.
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-3 mb-6">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 shadow-sm hover:shadow-md transition-all"
              >
                <RefreshCw className="h-4 w-4" />
                Try Again
              </button>
              <a
                href="/Dashboard"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-all"
              >
                <Home className="h-4 w-4" />
                Go to Dashboard
              </a>
            </div>

            {/* Dev-only: error details with stack trace */}
            {isDev && (
              <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
                <button
                  onClick={() => this.setState((s) => ({ showStack: !s.showStack }))}
                  className="w-full flex items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <Bug className="h-3.5 w-3.5" />
                    Developer Details
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${
                      this.state.showStack ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {this.state.showStack && (
                  <div className="border-t border-border/60">
                    {/* Error message */}
                    <div className="px-4 py-3 bg-red-50/50 dark:bg-red-950/20 border-b border-border/40">
                      <p className="text-xs font-mono font-semibold text-red-700 dark:text-red-400 break-all">
                        {this.state.error?.name || "Error"}: {errorMessage}
                      </p>
                    </div>

                    {/* Stack trace */}
                    {stackTrace && (
                      <div className="px-4 py-3 border-b border-border/40">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                          Stack Trace
                        </p>
                        <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap break-all">
                          {stackTrace}
                        </pre>
                      </div>
                    )}

                    {/* Component stack */}
                    {componentStack && (
                      <div className="px-4 py-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                          Component Stack
                        </p>
                        <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap break-all">
                          {componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Wrap children in a keyed fragment so "Try Again" forces a remount
    // (prevents the same broken component from immediately re-throwing)
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}

export default ErrorBoundary;
