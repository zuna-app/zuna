import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/onboarding.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/panels.css";
import "./styles/voice.css";
import "./styles/channel.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { setPlatform, type Platform } from "./platform";
import { useVoice } from "./voice/store";

export type { BootResult, NotificationRoute, NotificationsToClear, NotifyPayload, Platform } from "./platform";
export { connectWorker, type DeviceInfo } from "./core/boot";

/** Shows the app in the page's #root, on whatever the host provides, until the returned function removes it. */
export function startApp(host: Platform): () => void {
  setPlatform(host);
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <ErrorBoundary
      fallback={
        <div className="boot">
          <div className="empty-state" style={{ maxWidth: 440 }}>
            <h3>Something went wrong</h3>
            <p>Zuna couldn't display this. Your messages are safe.</p>
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      }
    >
      <App />
    </ErrorBoundary>,
  );
  return () => {
    // The voice room lives outside React, so it would keep the microphone and the call going.
    useVoice.getState().leave();
    root.unmount();
  };
}
