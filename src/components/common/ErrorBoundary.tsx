import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-primary)] p-8">
          <AlertTriangle className="h-12 w-12 text-amber-500" />
          <div className="text-center max-w-md">
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              An unexpected error occurred while rendering the application.
              Your editor content and connection state have been preserved.
            </p>
            {this.state.error && (
              <pre className="mb-4 max-h-32 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 text-left text-xs text-red-400">
                {this.state.error.message}
              </pre>
            )}
          </div>
          <button
            onClick={this.handleReload}
            className="inline-flex items-center gap-2 rounded bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            <RefreshCw className="h-4 w-4" />
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
