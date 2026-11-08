import { Lock, LogOut, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner, useAction } from "@/components/ui";
import { installStickyFocus } from "@/lib/focus";
import { prefetchEmotes } from "@/lib/media";
import { useActiveChannel, useActiveConversation, useActiveField, useApp, type ServerState } from "@/state/store";
import { ChatView } from "@/features/chat/ChatView";
import { channelTitle } from "@/features/voice/ChannelList";
import { IncomingCalls } from "@/features/voice/IncomingCalls";
import { VoicePanel } from "@/features/voice/VoicePanel";
import { VoiceStage } from "@/features/voice/VoiceStage";
import { watchPushToTalk } from "@/voice/ptt";
import { useVoice } from "@/voice/store";
import { ConversationList } from "./ConversationList";
import { ServerRail } from "./ServerRail";

const LIST_WIDTH_KEY = "zuna-list-width";
const MIN_LIST_WIDTH = 260;
const MAX_LIST_WIDTH = 460;
const PREFETCH_DELAY_MS = 3000;

function loadWidth(): number {
  const stored = Number(localStorage.getItem(LIST_WIDTH_KEY));
  return stored >= MIN_LIST_WIDTH && stored <= MAX_LIST_WIDTH ? stored : 320;
}

/** A channel opened before this device has come into it, which takes a moment and needs nobody to do anything. */
function JoiningChannel() {
  return (
    <div className="no-chat">
      <div className="empty-state">
        <Spinner size={22} />
        <p>Getting the keys to this channel…</p>
      </div>
    </div>
  );
}

function NoConversation() {
  const name = useActiveField((server) => server.entry.name, null);
  return (
    <div className="no-chat">
      <div className="empty-state">
        <MessageCircle size={28} className="empty-icon" />
        <h3>{name ?? "Zuna"}</h3>
        <p>Pick someone from the list to start talking.</p>
        <p className="row faint" style={{ gap: 6, fontSize: 12.5, marginTop: 4 }}>
          <Lock size={12} /> Everything here is end-to-end encrypted
        </p>
      </div>
    </div>
  );
}

/**
 * The server ended this device's session. Nothing is erased on its word: what's
 * here stays until the person signs in again or clears it, or after a month.
 */
function SignedOut({ server }: { server: Pick<ServerState, "entry"> }) {
  const core = useApp((state) => state.core);
  const setOverlay = useApp((state) => state.setOverlay);
  const removeServer = useApp((state) => state.removeServer);
  const { busy, run } = useAction();
  const reason = server.entry.signedOut;
  return (
    <div className="no-chat">
      <div className="empty-state" style={{ maxWidth: 460 }}>
        <LogOut size={28} className="empty-icon" />
        <h3>
          {reason === "banned"
            ? `You were removed from ${server.entry.name}`
            : reason === "account_deleted"
              ? `Your account on ${server.entry.name} was deleted`
              : `You're signed out of ${server.entry.name}`}
        </h3>
        <p>
          {reason === "device_revoked"
            ? "This device was removed from your account."
            : reason === "banned"
              ? "Its admins ended your access."
              : reason === "account_deleted"
                ? "It was deleted from another of your devices."
                : "The server ended this device's session."}{" "}
          {reason === "account_deleted"
            ? "What's on this device stays here for 30 days, or until you remove it."
            : "What's on this device stays here for 30 days, or until you sign in again or remove it."}
        </p>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          {reason !== "banned" && reason !== "account_deleted" && (
            <button className="btn btn-primary" onClick={() => setOverlay({ type: "add-server", signInUrl: server.entry.address })}>
              Sign in again
            </button>
          )}
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const id = server.entry.id;
                await core!.client.leaveServer(id);
                removeServer(id);
              })
            }
          >
            {busy ? <Spinner /> : "Remove from this device"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Alt+Up and Alt+Down move through conversations, Ctrl+K jumps to search. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("conversation-search")?.focus();
        return;
      }
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const state = useApp.getState();
      const server = state.activeServerId ? state.servers[state.activeServerId] : null;
      if (!server) return;
      const visible = server.conversations.filter((item) => !item.hidden);
      const index = visible.findIndex((item) => item.key === server.activeKey);
      const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        state.selectConversation(next.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Each joined server's emotes, once the app has settled, and again if they change. */
function useEmotePrefetch() {
  const sets = useApp((state) =>
    Object.values(state.servers)
      .map((server) => `${server.entry.id}/${server.emotes.set_id}/${server.emotes.emotes.length}`)
      .join(),
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const server of Object.values(useApp.getState().servers)) prefetchEmotes(server.entry.url, server.emotes.emotes);
    }, PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sets]);
}

export function Shell() {
  const conversation = useActiveConversation();
  const channel = useActiveChannel();
  const activeServerId = useApp((state) => state.activeServerId);
  const inThisVoice = useVoice((state) => channel?.type === "voice" && state.channelId === channel.id && state.serverId === activeServerId);
  const activeKey = useActiveField((server) => server.activeKey, null);
  const entry = useActiveField((server) => server.entry, null);
  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);

  useEffect(installStickyFocus, []);
  useEffect(watchPushToTalk, []);
  useShortcuts();
  useEmotePrefetch();

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      dragging.current = true;
      document.body.style.cursor = "col-resize";
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (move: MouseEvent) => {
        setWidth(Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, startWidth + move.clientX - startX)));
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width],
  );

  useEffect(() => {
    localStorage.setItem(LIST_WIDTH_KEY, String(width));
  }, [width]);

  return (
    <div className="shell">
      <ServerRail />
      <aside className="sidebar" style={{ width }}>
        <div className="sidebar-column">
          <div key={activeServerId} className="sidebar-inner">
            <ConversationList />
          </div>
          <VoicePanel />
        </div>
        <div className="sidebar-resizer" onMouseDown={onResizeStart} />
      </aside>
      <IncomingCalls />
      <main className="main">
        <div className="main-inner">
          {/* Switching chats is instant: messages are already in memory or a few milliseconds away. */}
          {entry?.signedOut ? (
            <SignedOut server={{ entry }} />
          ) : channel && inThisVoice ? (
            <VoiceStage
              key={`${activeServerId}:${channel.id}`}
              room={{ id: channel.id, call: false, title: channelTitle(channel), topic: channel.topic, conversation: channel.conversation, screenLimit: channel.screenLimit, sounds: channel.sounds }}
            />
          ) : conversation ? (
            <ChatView key={`${activeServerId}:${activeKey}`} conversation={conversation} voice={channel?.type === "voice"} />
          ) : channel ? (
            <JoiningChannel />
          ) : (
            <NoConversation />
          )}
        </div>
      </main>
    </div>
  );
}
