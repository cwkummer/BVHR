/**
 * Catches errors thrown while rendering its children (including a lazily loaded chunk failing to download,
 * which is what happens to an open tab after a new deploy replaces the old files) and shows an
 * `ErrorPanel` instead of leaving a blank page. It cannot catch errors in event handlers or async code;
 * those are handled where they happen.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorPanel } from "./ErrorPanel";

type Props = {
  title?: string;
  message?: string;
  children: ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UI error caught by boundary:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorPanel
        title={this.props.title ?? "Something went wrong"}
        message={this.props.message ?? "The game hit an unexpected error. Reloading the page usually fixes it."}
        detail={error.stack ?? error.message}
      />
    );
  }
}
