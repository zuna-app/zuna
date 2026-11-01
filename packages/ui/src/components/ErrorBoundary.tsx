import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one thing that can't be drawn from taking the rest of the app with it.
 * What's drawn comes from other people, and the core checks it first, so this is
 * the second line of defence, not the first.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[zuna] something couldn't be displayed", error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
