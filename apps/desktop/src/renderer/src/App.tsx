import { AlertTriangle } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";
import { desktop } from "@/core/bridge";
import { Logo, Toasts } from "@/components/ui";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { Shell } from "@/features/shell/Shell";
import { Overlays } from "@/features/overlays/Overlays";
import { applySettings, saveSettings } from "@/state/settings";
import { useApp } from "@/state/store";

function TitleBar() {
  const [platform, setPlatform] = useState<string | null>(null);
  const activeServer = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId] : null));
  useEffect(() => {
    void desktop?.platform().then(setPlatform);
  }, []);
  if (!desktop) return null;
  const connection = activeServer?.connection;
  const status =
    connection === "connecting" ? "Connecting" : connection === "offline" ? "Waiting for network" : connection === "syncing" ? "Updating" : null;
  return (
    <div className={`titlebar${platform === "darwin" ? " is-mac" : ""}`}>
      <span className="titlebar-brand">
        <Logo size={14} />
        Zuna
      </span>
      {status && (
        <span className="titlebar-status">
          <i />
          {status}
        </span>
      )}
    </div>
  );
}

function BootScreen() {
  return (
    <div className="boot">
      <Logo size={44} />
    </div>
  );
}

function BootFailure({ message }: { message: string }) {
  return (
    <div className="boot">
      <div className="empty-state" style={{ maxWidth: 440 }}>
        <AlertTriangle size={26} className="empty-icon" style={{ color: "var(--red)" }} />
        <h3>Zuna couldn't start</h3>
        <p>Its encrypted storage didn't open. Your messages are safe on your servers. Try restarting the app.</p>
        <p className="mono faint" style={{ fontSize: 12 }}>{message}</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  );
}

export function App() {
  const phase = useApp((state) => state.phase);
  const bootError = useApp((state) => state.bootError);
  const boot = useApp((state) => state.boot);
  const hasServers = useApp((state) => state.order.length > 0);
  const settings = useApp((state) => state.settings);
  const setOverlay = useApp((state) => state.setOverlay);

  useEffect(() => {
    document.body.classList.toggle("has-titlebar", !!desktop);
    void boot();
  }, [boot]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    void desktop?.setCloseToTray(settings.closeToTray);
  }, [settings]);

  // OS integration: invite links and clicks on notifications.
  useEffect(() => {
    if (phase !== "ready") return;
    const openLink = (link: string) => setOverlay({ type: "add-server", link });
    void desktop?.takeDeepLink().then((link) => {
      if (link) openLink(link);
    });
    const removers = [
      desktop?.onDeepLink(openLink),
      desktop?.onOpenConversation((route) => {
        const { serverId, key } = route as { serverId: string; key: string };
        useApp.getState().selectServer(serverId);
        useApp.getState().selectConversation(key);
      }),
      desktop?.onFocus((focused) => {
        useApp.setState({ windowFocused: focused });
      }),
    ];
    const onFocus = () => useApp.setState({ windowFocused: true });
    const onBlur = () => useApp.setState({ windowFocused: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      for (const remove of removers) remove?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [phase, setOverlay]);

  // A dropped connection comes back as soon as the network does.
  useEffect(() => {
    const onOnline = () => void useApp.getState().core?.client.nudge();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return (
    <MotionConfig reducedMotion={settings.reduceMotion ? "always" : "user"}>
      <div className="app-root">
        <TitleBar />
        <div className="app-body">
          {phase === "booting" && <BootScreen />}
          {phase === "failed" && <BootFailure message={bootError ?? ""} />}
          {phase === "ready" && !hasServers && <Onboarding />}
          {phase === "ready" && hasServers && (
            <div className="shell-wrap">
              <Shell />
            </div>
          )}
        </div>
        <Overlays />
        <Toasts />
      </div>
    </MotionConfig>
  );
}
