import { Component, type ReactNode } from "react";
import { AlertTriangle, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthContext";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render-time crashes anywhere below it and shows a recoverable
 * screen instead of a blank/black page. Rendered inside AuthProviderRoot so
 * the fallback can still offer a real sign-out via useAuth(). Doesn't catch
 * async/listener failures (auth profile loads, Firestore listeners) — those
 * already surface through their own discriminated states (AuthContext) or
 * the sync-error status pill (src/data/outbox.ts); this is only the last
 * line of defense for an unexpected exception during render. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("City Ops OS: unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { logout } = useAuth();
  return (
    <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-critical/30 bg-surface p-6 space-y-4 text-center">
        <AlertTriangle className="size-8 text-critical mx-auto" />
        <div>
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted mt-1">{message || "City Ops OS hit an unexpected error."}</p>
        </div>
        <div className="grid gap-2">
          <Button className="w-full h-11" onClick={onRetry}>
            <RefreshCw className="size-4" /> Try again
          </Button>
          <Button variant="secondary" className="w-full h-11" onClick={() => void logout()}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
