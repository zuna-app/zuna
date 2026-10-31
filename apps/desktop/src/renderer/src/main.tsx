import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/onboarding.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/panels.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

createRoot(document.getElementById("root")!).render(
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
