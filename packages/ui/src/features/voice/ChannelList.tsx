import type { ChannelView, VoiceMember } from "@zuna/core";
import { BellOff, Camera, ChevronDown, Hash, HeadphoneOff, MicOff, Pencil, Plus, Settings, Trash2, Volume2, VolumeX } from "lucide-react";
import { Reorder } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Tooltip, useContextMenu, type MenuEntry } from "@/components/ui";
import { muteEntries } from "@/lib/mute";
import { activeServerNow, useActiveField, useApp } from "@/state/store";
import { useShallow } from "zustand/react/shallow";
import { selfIsSpeaking, useVoice } from "@/voice/store";

const COLLAPSED_KEY = "zuna-collapsed-categories";

function loadCollapsed(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

interface Section {
  name: string;
  channels: ChannelView[];
  /** What the add button makes here, when it's one of the usual headings. */
  type: "text" | "voice";
}

/** A channel's own heading if it has one, or one for its type, in the order they come up. */
function sectionsOf(channels: ChannelView[]): Section[] {
  const sections = new Map<string, Section>();
  for (const channel of channels) {
    const name = channel.category || (channel.type === "voice" ? "Voice channels" : "Text channels");
    let section = sections.get(name);
    if (!section) {
      section = { name, channels: [], type: channel.type };
      sections.set(name, section);
    }
    section.channels.push(channel);
  }
  return [...sections.values()];
}

const NO_CHANNELS: ChannelView[] = [];

export const channelTitle = (channel: ChannelView): string => channel.name || (channel.unreadable ? "Unreadable channel" : "Channel");

const VoiceOccupant = memo(function VoiceOccupant({ member }: { member: VoiceMember }) {
  const serverId = useApp((state) => state.activeServerId);
  const selfId = useActiveField((server) => server.self?.userId, undefined);
  const inThisCall = useVoice((state) => state.channelId === member.channelId && state.serverId === serverId);
  const speaking = useVoice((state) => (member.userId === selfId ? selfIsSpeaking(state) && state.status === "connected" : inThisCall && !!state.speaking[member.userId]));
  const user = useActiveField((server) => server.users[member.userId], undefined);
  const name = user?.displayName ?? "Someone";
  return (
    <div className={`voice-occupant${speaking ? " is-speaking" : ""}`}>
      <span className="voice-occupant-avatar">
        <Avatar name={name} seed={member.userId} avatar={user?.avatar} size={22} />
      </span>
      <span className="truncate grow">{name}</span>
      {member.screen && <span className="voice-live">Live</span>}
      {member.camera && <Camera size={13} className="faint" />}
      {member.serverMuted ? <MicOff size={13} className="voice-server-muted" /> : member.muted && !member.deafened && <MicOff size={13} className="faint" />}
      {member.deafened && <HeadphoneOff size={13} className="faint" />}
    </div>
  );
});

function ChannelRow({ channel, onMenu, canEdit }: { channel: ChannelView; onMenu: (event: React.MouseEvent, channel: ChannelView) => void; canEdit: boolean }) {
  const serverId = useApp((state) => state.activeServerId);
  const selectConversation = useApp((state) => state.selectConversation);
  const setOverlay = useApp((state) => state.setOverlay);
  const join = useVoice((state) => state.join);
  const toast = useApp((state) => state.toast);
  const inChannel = useVoice((state) => state.channelId === channel.id && state.serverId === serverId);
  const active = useActiveField((server) => server.activeKey === channel.key, false);
  const { conversation } = channel;
  // A voice channel is somewhere to go, not something to read, so only a mention marks one.
  const unread = channel.type === "text" && !!conversation && conversation.unread > 0 && !conversation.muted;
  const mentions = conversation?.unreadMentions ?? 0;
  const occupants = useApp(
    useShallow((state) => {
      const server = state.activeServerId ? state.servers[state.activeServerId] : null;
      return Object.values(server?.voice ?? {})
        .filter((member) => member.channelId === channel.id)
        .sort((a, b) => a.since - b.since);
    }),
  );
  const full = channel.userLimit > 0 && occupants.length >= channel.userLimit;
  const onOpen = () => {
    const server = activeServerNow();
    if (channel.type === "voice" && server) {
      // Clicking a voice channel is coming into it, as in Discord. Leaving goes back to what was open before.
      const activeIsVoice = server.channels.find((item) => item.key === server.activeKey)?.type === "voice";
      if (server.info?.voice) {
        // It opens as this device comes in, which may wait to be asked about.
        void join(server.entry.id, channel.id, activeIsVoice ? undefined : server.activeKey, { open: channel.key });
        return;
      }
      selectConversation(channel.key);
      toast("This server doesn't have a media server yet, so you can't join its voice channels.", "info");
      return;
    }
    selectConversation(channel.key);
  };
  return (
    <>
      <button
        data-row-key={channel.key}
        className={`channel-row${active ? " is-active" : ""}${unread ? " is-unread" : ""}${inChannel ? " is-connected" : ""}`}
        onClick={onOpen}
        onContextMenu={(event) => onMenu(event, channel)}
        aria-current={active}
        disabled={channel.unreadable}
        title={channel.topic || undefined}
      >
        {channel.type === "voice" ? <Volume2 size={20} className="channel-icon" /> : <Hash size={20} className="channel-icon" />}
        <span className="channel-name truncate">{channelTitle(channel)}</span>
        {conversation?.muted && <BellOff size={12} className="conv-muted" />}
        {channel.type === "voice" && channel.userLimit > 0 && (
          <span className={`channel-limit${full ? " is-full" : ""}`}>
            {occupants.length}/{channel.userLimit}
          </span>
        )}
        {canEdit && (
          // A button can't hold another, so this one is only for the mouse; the row's menu has it too.
          <Tooltip text="Edit channel">
            <span
              className="channel-edit"
              role="button"
              aria-label={`Edit ${channelTitle(channel)}`}
              onClick={(event) => {
                event.stopPropagation();
                setOverlay({ type: "channel", channelId: channel.id });
              }}
            >
              <Settings size={16} />
            </span>
          </Tooltip>
        )}
        {mentions > 0 && (
          <span className="channel-mentions" aria-label={`${mentions} mentioning you`}>
            {mentions > 99 ? "99+" : mentions}
          </span>
        )}
      </button>
      {occupants.length > 0 && (
        <div className="voice-occupants">
          {occupants.map((member) => (
            <VoiceOccupant key={member.deviceId} member={member} />
          ))}
        </div>
      )}
    </>
  );
}

/** The server's channels, at the top of the list, under headings that fold away. */
export function ChannelSections({ query }: { query: string }) {
  const hasServer = useApp((state) => !!state.activeServerId && !!state.servers[state.activeServerId]);
  const role = useActiveField((server) => server.self?.role, undefined);
  const channels = useActiveField((server) => server.channels, NO_CHANNELS);
  // The voice channels this account is in, which a folded heading keeps showing.
  const mine = useActiveField((server) => Object.values(server.voice).filter((member) => member.userId === server.self?.userId).map((member) => member.channelId).join(" "), "");
  const session = useApp((state) => state.session);
  const setOverlay = useApp((state) => state.setOverlay);
  const toast = useApp((state) => state.toast);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const rowMenu = useContextMenu();
  const [menuChannel, setMenuChannel] = useState<ChannelView | null>(null);
  // While a row is being dragged, this is what's shown; otherwise, what the server says.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragged = useRef(false);

  const isAdmin = role === "owner" || role === "admin";
  const needle = query.trim().toLowerCase();
  const ordered = useMemo(() => {
    if (!dragOrder) return channels;
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return dragOrder.flatMap((id) => byId.get(id) ?? []);
  }, [channels, dragOrder]);
  const shown = needle ? ordered.filter((channel) => channel.name.toLowerCase().includes(needle)) : ordered;
  const sections = useMemo(() => sectionsOf(shown), [shown]);

  if (!hasServer) return null;
  if (channels.length === 0 && !isAdmin) return null;

  const toggleSection = (name: string) => {
    setCollapsed((current) => {
      const next = { ...current };
      if (next[name]) delete next[name];
      else next[name] = true;
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // It just won't be remembered.
      }
      return next;
    });
  };

  const entries = (channel: ChannelView): MenuEntry[] => [
    ...(channel.conversation
      ? [
          channel.conversation.muted
            ? { label: "Unmute", icon: <Volume2 size={15} />, onSelect: () => void session().unmute(channel.key) }
            : { label: "Mute", icon: <VolumeX size={15} />, submenu: muteEntries((until) => void session().mute(channel.key, until)) },
        ]
      : []),
    ...(isAdmin
      ? [
          { label: "Edit channel", icon: <Pencil size={15} />, onSelect: () => setOverlay({ type: "channel", channelId: channel.id }) },
          {
            label: "Delete channel",
            icon: <Trash2 size={15} />,
            danger: true,
            onSelect: () => {
              if (window.confirm(`Delete ${channelTitle(channel)}? Its messages will be deleted for everyone.`)) {
                void session()
                  .deleteChannel(channel.id)
                  .catch((error: Error) => toast(error.message, "error"));
              }
            },
          },
        ]
      : []),
  ];

  return (
    <div className="channel-sections">
      {sections.map((section) => {
        const folded = !!collapsed[section.name] && !needle;
        const ids = section.channels.map((channel) => channel.id);
        // A folded heading keeps showing what someone's in, and what mentions them.
        const visible = folded ? section.channels.filter((channel) => channel.conversation?.unreadMentions || mine.split(" ").includes(channel.id)) : section.channels;
        return (
          <section key={section.name} className="channel-section">
            <header className="channel-section-head">
              <button className={`channel-section-title${folded ? " is-folded" : ""}`} onClick={() => toggleSection(section.name)} aria-expanded={!folded}>
                <ChevronDown size={12} strokeWidth={2.5} />
                <span className="truncate">{section.name}</span>
              </button>
              {isAdmin && (
                <Tooltip text="New channel">
                  <button className="icon-btn is-small" onClick={() => setOverlay({ type: "channel", channelType: section.type })} aria-label={`New channel in ${section.name}`}>
                    <Plus size={14} />
                  </button>
                </Tooltip>
              )}
            </header>
            {isAdmin && !folded && !needle ? (
              <Reorder.Group
                as="div"
                axis="y"
                values={ids}
                onReorder={(next: string[]) => {
                  const others = ordered.map((channel) => channel.id);
                  const first = others.findIndex((id) => ids.includes(id));
                  const rest = others.filter((id) => !ids.includes(id));
                  rest.splice(first, 0, ...next);
                  setDragOrder(rest);
                }}
              >
                {section.channels.map((channel) => (
                  <Reorder.Item
                    as="div"
                    key={channel.id}
                    value={channel.id}
                    onPointerDown={() => (dragged.current = false)}
                    onDragStart={() => (dragged.current = true)}
                    onDragEnd={() => {
                      const order = dragOrder;
                      setDragOrder(null);
                      if (order) void session().reorderChannels(order).catch((error: Error) => toast(error.message, "error"));
                    }}
                  >
                    <ChannelRow
                      channel={channel}
                      canEdit={isAdmin}
                      onMenu={(event, target) => {
                        setMenuChannel(target);
                        rowMenu.open(event);
                      }}
                    />
                  </Reorder.Item>
                ))}
              </Reorder.Group>
            ) : (
              visible.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  canEdit={isAdmin}
                  onMenu={(event, target) => {
                    setMenuChannel(target);
                    rowMenu.open(event);
                  }}
                />
              ))
            )}
          </section>
        );
      })}
      {channels.length === 0 && isAdmin && !needle && (
        <div className="channel-empty">
          <button className="btn btn-small" onClick={() => setOverlay({ type: "channel", channelType: "text" })}>
            <Plus size={14} /> New channel
          </button>
        </div>
      )}
      {rowMenu.menu && menuChannel && entries(menuChannel).length > 0 && <PopupMenu key="channel-menu" x={rowMenu.menu.x} y={rowMenu.menu.y} entries={entries(menuChannel)} onClose={rowMenu.close} />}
    </div>
  );
}
