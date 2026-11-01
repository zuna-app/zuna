import { AlertTriangle } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";
import { ConnectionStatus, Logo, Toasts } from "@/components/ui";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { Shell } from "@/features/shell/Shell";
import { Overlays } from "@/features/overlays/Overlays";
import { applySettings, saveSettings } from "@/state/settings";
import { useApp } from "@/state/store";
import { watchActivity } from "@/state/activity";
import { platform } from "@/platform";

function TitleBar() {
  const [os, setOs] = useState<string | null>(null);
  useEffect(() => {
    void platform.os?.().then(setOs);
  }, []);
  if (!platform.titleBar) return null;
  return (
    <div className={`titlebar${os === "darwin" ? " is-mac" : ""}`}>
      <span className="titlebar-brand">
        <Logo size={14} />
        Zuna
      </span>
      <ConnectionStatus />
    </div>
  );
}

/** The web app's files changed on its host. Reloading picks up the new version. */
function UpdateNotice() {
  const [ready, setReady] = useState(false);
  useEffect(() => platform.onUpdate?.(() => setReady(true)), []);
  if (!ready) return null;
  return (
    <div className="update-notice" role="status">
      <span>Zuna was updated.</span>
      <button className="btn btn-small btn-primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

/** Whether anything is still on its way out, which closing a tab would stop. */
function isSending(lists: ReturnType<typeof useApp.getState>["lists"]): boolean {
  return Object.values(lists).some((list) => list.items.some((item) => item.status === "sending"));
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
    document.body.classList.toggle("has-titlebar", platform.titleBar);
    void boot();
  }, [boot]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    platform.setCloseToTray?.(settings.closeToTray);
  }, [settings]);

  // OS integration: invite links and clicks on notifications.
  useEffect(() => {
    if (phase !== "ready") return;
    const openLink = (link: string) => setOverlay({ type: "add-server", link });
    void platform.takeDeepLink?.().then((link) => {
      if (link) openLink(link);
    });
    const removers = [
      platform.onDeepLink?.(openLink),
      platform.onOpenConversation?.((route) => {
        const { serverId, key } = route as { serverId: string; key: string };
        useApp.getState().selectServer(serverId);
        useApp.getState().selectConversation(key);
      }),
    ];
    return () => {
      for (const remove of removers) remove?.();
    };
  }, [phase, setOverlay]);

  // Whether the window has focus decides what counts as read. The window usually gains
  // focus while the app is still starting, so this listens from the first render.
  useEffect(() => {
    const setFocused = (focused: boolean) => useApp.setState({ windowFocused: focused });
    setFocused(document.hasFocus());
    const removeHost = platform.onFocus?.(setFocused);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      removeHost?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Where notifications go: here while the person is at the computer, their phone otherwise.
  useEffect(() => (phase === "ready" ? watchActivity() : undefined), [phase]);

  // A tab can be closed in the middle of a send. The desktop keeps running in its tray instead.
  useEffect(() => {
    if (!platform.warnBeforeLeaving) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isSending(useApp.getState().lists)) event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

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
        <UpdateNotice />
      </div>
    </MotionConfig>
  );
}
