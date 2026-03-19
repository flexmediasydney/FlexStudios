import { AlertTriangle, RefreshCw, ChevronDown } from "lucide-react";
import { Component } from "react";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[ErrorBoundary] Caught error:", error);
    console.error("[ErrorBoundary] Component stack:", errorInfo?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env?.DEV;
      const errorMessage = this.state.error?.message || "Unknown error";

      return (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center min-h-[300px]">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Something went wrong</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            This section encountered an error. Try refreshing — if it keeps happening,
            contact support.
          </p>
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium hover:bg-muted transition-colors"
            >
              Reload page
            </button>
          </div>

          {/* Error details — always visible in dev, toggle in prod */}
          {isDev && (
            <div className="mt-6 w-full max-w-lg text-left">
              <button
                onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${this.state.showDetails ? "rotate-180" : ""}`} />
                {this.state.showDetails ? "Hide" : "Show"} error details
              </button>
              {this.state.showDetails && (
                <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-auto max-h-48 text-left">
                  {errorMessage}
                </pre>
              )}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;