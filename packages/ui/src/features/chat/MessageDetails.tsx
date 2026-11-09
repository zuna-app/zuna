// The smaller parts of a message: system messages, who it was forwarded from, its reactions
// and ticks, the reply above a channel message, and editing it in place.

import type { ConversationView, MessageView, ReactionView } from "@zuna/core";
import { AlertCircle, ArrowRight, Clock, CornerUpLeft, Forward, Image as ImageIcon, ShieldAlert } from "lucide-react";
import { plainText } from "@zuna/core/plain-text";
import { MAX_TEXT_LENGTH } from "@zuna/core/validate";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Emote } from "@/components/Emote";
import { Avatar, Tooltip } from "@/components/ui";
import { focusComposer } from "@/lib/focus";
import { formatFull, formatStamp, nameColor } from "@/lib/format";
import { useGrowWithText } from "@/lib/grow";
import { timerChangeText } from "@/lib/disappearing";
import { useApp } from "@/state/store";
import { emotesIn, mentionsIn } from "./Composer";
import { useServerField, serverOf } from "./use-server-field";

export function SystemMessage({ message, highlighted, channel }: { message: MessageView; highlighted: boolean; channel: boolean }) {
  const text = useServerField((server) => {
    const name = (id?: string) => {
      if (!id) return "Someone";
      if (id === server.self?.userId) return "You";
      return server.users[id]?.displayName ?? "Someone";
    };
    const system = message.system!;
    const targets = (system.targetIds ?? []).map(name).join(", ");
    switch (system.type) {
      case "group_created":
        return `${name(system.actorId)} created this group`;
      case "member_added":
        return `${name(system.actorId)} added ${targets}`;
      case "member_removed":
        return `${name(system.actorId)} removed ${targets}`;
      case "member_left":
        return `${name(system.actorId)} left the group`;
      case "member_rejoined":
        return `${name(system.actorId)} rejoined this chat`;
      case "unexpected_join":
        return `${name(system.actorId)} joined without being added by a member. Check that this is expected.`;
      case "identity_changed":
        return `${name(system.actorId)}'s security key changed. Verify it before trusting new messages.`;
      case "identity_rotated":
        return `${name(system.actorId)}'s security key changed since you verified it. You can compare keys again if you'd like.`;
      case "device_added":
        return `${name(system.actorId)} added a device`;
      case "timer_changed":
        return timerChangeText(name(system.actorId), system.seconds ?? 0);
    }
  }, "");
  const warning = message.system!.type === "unexpected_join" || message.system!.type === "identity_changed";
  // In a channel it's a line of its own, with an arrow where a picture would be, as in Discord.
  if (channel) {
    return (
      <div className={`msg is-channel cmsg-system${warning ? " is-warning" : ""}${highlighted ? " is-highlighted" : ""}`}>
        <span className="cmsg-system-icon">{warning ? <ShieldAlert size={16} /> : <ArrowRight size={16} />}</span>
        <span className="cmsg-system-text">
          {text}
          <time className="cmsg-time" title={formatFull(message.createdAt)}>
            {formatStamp(message.createdAt)}
          </time>
        </span>
      </div>
    );
  }
  return (
    <div className={`system-row${highlighted ? " is-highlighted" : ""}`}>
      <span className={warning ? "system-pill is-warning" : "system-pill"}>
        {warning && <ShieldAlert size={13} />}
        {text}
      </span>
    </div>
  );
}

/** Whose message this was, as in Telegram. Forwarded from another server, it only says it's forwarded. */
export function ForwardedFrom({ userId }: { userId?: string }) {
  const name = useServerField((server) => {
    if (!userId) return null;
    if (userId === server.self?.userId) return "You";
    return server.users[userId]?.displayName ?? null;
  }, null);
  return (
    <span className="msg-forwarded">
      <Forward size={13} />
      {name && userId ? (
        <>
          Forwarded from{" "}
          <button className="msg-forwarded-name" onClick={() => useApp.getState().setOverlay({ type: "verify", userId })}>
            {name}
          </button>
        </>
      ) : (
        "Forwarded"
      )}
    </span>
  );
}

/** A reaction, as in Telegram: emoji with the people who reacted, or a count once there are many. */
export function ReactionChip({
  reaction,
  selfId,
  serverUrl,
  showPeople,
  onToggle,
}: {
  reaction: ReactionView;
  selfId: string;
  serverUrl: string;
  showPeople: boolean;
  onToggle: () => void;
}) {
  const names = useServerField((server) => reaction.userIds.map((id) => (id === selfId ? "You" : (server.users[id]?.displayName ?? "Someone"))).join(", "), "");
  const people = useApp(
    useShallow((state) => {
      const server = serverOf(state);
      return showPeople && server ? reaction.userIds.map((id) => server.users[id]) : null;
    }),
  );
  const mine = reaction.userIds.includes(selfId);
  const chip = (
    <button className={`reaction${mine ? " is-mine" : ""}`} onClick={onToggle} aria-label={`${reaction.key}, ${names}`}>
      {reaction.emote ? <Emote name={reaction.key} emote={reaction.emote} serverUrl={serverUrl} size="reaction" note={`Reacted by ${names}`} /> : <span className="reaction-emoji">{reaction.key}</span>}
      {people ? (
        <span className="reaction-people">
          {reaction.userIds.map((id, index) => (
            <Avatar key={id} name={people[index]?.displayName ?? "?"} seed={id} avatar={people[index]?.avatar} size={16} />
          ))}
        </span>
      ) : (
        <span>{reaction.userIds.length}</span>
      )}
    </button>
  );
  return reaction.emote ? (
    chip
  ) : (
    <Tooltip text={names} side="top">
      {chip}
    </Tooltip>
  );
}

/** Thin and slanted, as in Telegram. Reading a message adds a second tick beside the first, which stays put. */
function Ticks({ read }: { read: boolean }) {
  return (
    <svg className={`msg-tick${read ? " is-read" : ""}`} width="18" height="10" viewBox="0 0 18 10" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M.6 5.6 3.7 8.8 12 .6" />
      {read && <path d="M7.4 7.4 8.9 8.8 17.2 .6" />}
    </svg>
  );
}

/** How far anyone else has read here, for the ticks, or -1 where nobody's reading is known, as in a channel. */
export function readUpToOf(conversation: ConversationView, selfId: string): number {
  if (conversation.kind === "channel") return -1;
  return Object.entries(conversation.readBy).reduce((highest, [id, seq]) => (id === selfId ? highest : Math.max(highest, seq)), 0);
}

export function ReadTicks({ message, readUpTo }: { message: MessageView; readUpTo: number }) {
  if (message.status === "sending") return <Clock size={11} className="msg-tick is-sending" />;
  if (message.status === "failed") return <AlertCircle size={12} className="msg-tick is-failed" />;
  // Below zero means nobody's reading is known here, as in a channel.
  if (message.seq === null || readUpTo < 0) return null;
  return <Ticks read={readUpTo >= message.seq} />;
}

export const openProfile = (userId: string) => useApp.getState().setOverlay({ type: "verify", userId });

/** What a message in a channel answers: above it, joined to its picture by a line, as in Discord. */
export function ChannelReply({ message, blocked }: { message: MessageView; blocked: boolean }) {
  const reply = message.reply!;
  const jump = useApp((state) => state.jumpToMessage);
  const user = useServerField((server) => server.users[reply.senderId] ?? null, null);
  const name = user?.displayName ?? "Unknown";
  const text = reply.deleted ? "Original message was deleted" : blocked ? "Message from someone you blocked" : plainText(reply.text);
  return (
    <div className="cmsg-reply">
      {reply.deleted ? (
        <span className="cmsg-reply-gone">
          <CornerUpLeft size={10} />
        </span>
      ) : (
        <>
          <Avatar name={name} seed={reply.senderId} avatar={user?.avatar} size={16} />
          <button className="cmsg-reply-name" style={{ color: nameColor(reply.senderId || "x") }} onClick={() => reply.senderId && openProfile(reply.senderId)}>
            @{name}
          </button>
        </>
      )}
      <button className={`cmsg-reply-text${text ? "" : " is-empty"}`} onClick={() => jump(message.groupId, reply.id)}>
        <span className="truncate">{text || (reply.hasAttachment ? "Click to see attachment" : "Click to see message")}</span>
        {!text && reply.hasAttachment && <ImageIcon size={15} />}
      </button>
    </div>
  );
}

/** A message in a channel is edited where it is, as in Discord: Enter saves it, Escape leaves it as it was. */
export function InlineEditor({ message, listId }: { message: MessageView; listId: string }) {
  const session = useApp((state) => state.session);
  const setEditing = useApp((state) => state.setEditing);
  const toast = useApp((state) => state.toast);
  const enterToSend = useApp((state) => state.settings.enterToSend);
  const [text, setText] = useState(message.text);
  const input = useRef<HTMLTextAreaElement>(null);
  useGrowWithText(input, text);

  useEffect(() => {
    const element = input.current!;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const stop = () => {
    setEditing(listId, null);
    focusComposer();
  };
  const save = () => {
    const value = text.trim();
    if (value.length > MAX_TEXT_LENGTH) {
      toast("That message is too long.", "error");
      return;
    }
    if (value && value !== message.text) {
      const state = useApp.getState();
      const server = state.activeServerId ? state.servers[state.activeServerId] : undefined;
      void session().editMessage(message.groupId, message.id, value, emotesIn(value, server?.emotes.emotes ?? []), mentionsIn(value, server?.users ?? {}));
    }
    stop();
  };

  return (
    <div className="cmsg-editor">
      <textarea
        ref={input}
        className="cmsg-editor-input"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            stop();
          } else if (event.key === "Enter" && ((!event.shiftKey && enterToSend) || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        aria-label="Edit message"
        spellCheck
      />
      <span className="cmsg-editor-hint">
        escape to{" "}
        <button className="link-button" onClick={stop}>
          cancel
        </button>{" "}
        • enter to{" "}
        <button className="link-button" onClick={save}>
          save
        </button>
      </span>
    </div>
  );
}
