import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";

import "../index.css";

const mountNode = document.getElementById("root");

if (!mountNode) {
  throw new Error("Notification host mount node not found");
}

type MessageNotification = {
  avatarUrl?: string;
  senderName: string;
  content: string;
};

type QueuedNotification = MessageNotification & { id: number };

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 7500;

const CARD_SPRING = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.75,
};

const LAYOUT_SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 30,
  mass: 0.8,
};

const initialsFromName = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const NotificationCard = ({
  notification,
  onDismissAll,
}: {
  notification: QueuedNotification;
  onDismissAll: () => void;
}) => {
  const hasAvatar = Boolean(notification.avatarUrl);

  return (
    <motion.button
      layout
      layoutId={`notif-${notification.id}`}
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: CARD_SPRING }}
      exit={{
        opacity: 0,
        scale: 0.94,
        y: 6,
        transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
      }}
      whileHover={{
        y: -2,
        transition: { type: "spring", stiffness: 500, damping: 28 },
      }}
      transition={LAYOUT_SPRING}
      type="button"
      onClick={() => onDismissAll()}
      className="relative flex w-full cursor-pointer items-start gap-3 overflow-hidden rounded-md border border-border bg-muted px-2 py-1 text-left transition-colors duration-150 hover:border-white/20 hover:bg-background"
      style={{ willChange: "transform, opacity" }}
    >
      <div className="relative flex h-full shrink-0 items-center justify-center mt-1.5">
        {hasAvatar ? (
          <img
            src={notification.avatarUrl}
            alt={notification.senderName}
            className="size-10 rounded-xl border border-white/15 object-cover shadow-lg"
          />
        ) : (
          <div className="flex size-10 items-center justify-center rounded-xl border border-white/15 bg-zinc-800 text-xs font-semibold tracking-wide text-zinc-200">
            {initialsFromName(notification.senderName)}
          </div>
        )}
      </div>

      <div className="relative min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-zinc-100">
          {notification.senderName}
        </p>
        <p className="line-clamp-2 text-xs text-zinc-300">
          {notification.content}
        </p>
      </div>
    </motion.button>
  );
};

export const NotificationHost = () => {
  const [notifications, setNotifications] = useState<QueuedNotification[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nextIdRef = useRef(1);
  const dismissTimersRef = useRef(new Map<number, number>());

  const visible = notifications;

  // Sync window height whenever the container resizes (including during layout animations)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      void window.notification.resize(container.offsetHeight);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimersRef.current.delete(id);
    }
    setNotifications((prev) => {
      const next = prev.filter((n) => n.id !== id);
      if (next.length === 0) setDroppedCount(0);
      return next;
    });
  }, []);

  const dismissAll = useCallback(() => {
    dismissTimersRef.current.forEach((t) => window.clearTimeout(t));
    dismissTimersRef.current.clear();
    setNotifications([]);
    setDroppedCount(0);

    window.notification.restore();
  }, []);

  const enqueue = useCallback(
    (notification: MessageNotification) => {
      // Drop incoming notifications when the queue is already full
      if (dismissTimersRef.current.size >= MAX_VISIBLE) {
        setDroppedCount((c) => c + 1);
        return;
      }

      const audio = new Audio("/notification-sound.mp3");
      audio.play().catch(() => {});

      const id = nextIdRef.current++;
      setNotifications((prev) => [...prev, { ...notification, id }]);
      const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      dismissTimersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    document.documentElement.classList.add("dark");
    const unsubscribe = window.notification.onShow(enqueue);
    return () => {
      document.documentElement.classList.remove("dark");
      unsubscribe();
      dismissTimersRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, [enqueue]);

  return (
    <div
      ref={containerRef}
      className="flex w-full flex-col items-end gap-2 p-2"
    >
      <LayoutGroup>
        <AnimatePresence mode="popLayout">
          {droppedCount > 0 && (
            <motion.div
              key="overflow-badge"
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1, transition: CARD_SPRING }}
              exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.15 } }}
              transition={LAYOUT_SPRING}
              className="flex h-7 w-full items-center justify-center whitespace-nowrap rounded-full border border-border bg-muted px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] tabular-nums text-muted-foreground"
            >
              and {droppedCount} more
            </motion.div>
          )}

          {visible.map((notification) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              onDismissAll={dismissAll}
            />
          ))}
        </AnimatePresence>
      </LayoutGroup>
    </div>
  );
};

createRoot(mountNode).render(
  <StrictMode>
    <NotificationHost />
  </StrictMode>,
);
