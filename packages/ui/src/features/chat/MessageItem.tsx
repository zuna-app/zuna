import type { EmoteRef, MessageView, UserView } from "@zuna/core";
import {
  AlertCircle,
  Ban,
  Check,
  CheckCheck,
  CircleCheck,
  Copy,
  CornerUpLeft,
  Forward,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  ShieldAlert,
  SmilePlus,
  Timer,
  Trash2,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { plainText } from "@zuna/core/plain-text";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Emote } from "@/components/Emote";
import { Avatar, PopupMenu, Spinner, Tooltip, useAction, useContextMenu, type MenuEntry } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatFull, formatStamp, formatTime, nameColor } from "@/lib/format";
import { emoteFor, jumboSize, renderMarkup } from "@/lib/markup";
import { useApp } from "@/state/store";
import { canActOn } from "./use-drag-pick";
import { useMarkupContext } from "./use-markup-context";
import { EmotePicker } from "./EmotePicker";
import { useServerField } from "./use-server-field";
import { SystemMessage, ForwardedFrom, ReactionChip, ReadTicks, openProfile, ChannelReply, InlineEditor } from "./MessageDetails";
import { Attachments, LinkCard, LocationCard } from "./MessageAttachments";
import { MessageButtons } from "@/features/bots/MessageButtons";
import { BotBadge } from "@/components/ui";
import { t } from "@/lib/i18n";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

interface MessageItemProps {
  message: MessageView;
  listId: string;
  isGroup: boolean;
  isGroupAdmin: boolean;
  readUpTo: number;
  grouped: boolean;
  lastInGroup: boolean;
  fresh: boolean;
  highlighted: boolean;
  own: boolean;
  /** Laid out as in a Discord channel, rather than in bubbles. */
  channel: boolean;
}

/** Who in a group has read a message, as far as their read receipts say. People who turned them off never show. */
function readersOf(serverId: string, message: MessageView): UserView[] {
  const server = useApp.getState().servers[serverId];
  const conversation = server?.conversations.find((item) => item.groupId === message.groupId);
  const seq = message.seq;
  if (!server || !conversation || seq === null) return [];
  return conversation.members
    .filter((member) => member.userId !== server.self?.userId && (conversation.readBy[member.userId] ?? 0) >= seq)
    .map((member) => server.users[member.userId])
    .filter((user): user is UserView => !!user)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export const MessageItem = memo(function MessageItem({ message, listId, isGroup, isGroupAdmin, readUpTo, grouped, lastInGroup, fresh, highlighted, own, channel }: MessageItemProps) {
  const session = useApp((state) => state.session);
  const setReply = useApp((state) => state.setReply);
  const setEditing = useApp((state) => state.setEditing);
  const jump = useApp((state) => state.jumpToMessage);
  const toast = useApp((state) => state.toast);
  const serverId = useApp((state) => state.activeServerId) ?? "";
  // Whoever wrote one that hasn't opened isn't known yet: it's drawn as nobody's, with no profile to open.
  const known = message.senderId !== "";
  const senderName = useServerField((server) => (known ? (server.users[message.senderId]?.displayName ?? t("chat.unknown")) : t("message.senderNotKnown")), t("chat.unknown"));
  const senderIsBot = useServerField((server) => !!server.users[message.senderId]?.bot, false);
  const senderAvatar = useServerField((server) => server.users[message.senderId]?.avatar ?? null, null);
  const replyName = useServerField((server) => {
    const id = message.reply?.senderId;
    if (!id) return t("message.reply.earlier");
    return id === server.self?.userId ? t("common.you") : (server.users[id]?.displayName ?? t("chat.unknown"));
  }, "");
  const baseContext = useMarkupContext();
  const menu = useContextMenu();
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const { run } = useAction();
  const selecting = useApp((state) => state.selection?.listId === listId);
  const selected = useApp((state) => state.selection?.listId === listId && state.selection.ids.includes(message.id));
  // Someone blocked shows as a line, as in Discord, and their message only when asked.
  const blockedSender = useServerField((server) => !own && (server.prefs.blocked?.includes(message.senderId) ?? false), false);
  const blockedReply = useServerField((server) => !!message.reply && (server.prefs.blocked?.includes(message.reply.senderId) ?? false), false);
  const [revealed, setRevealed] = useState(false);
  const editingHere = useApp((state) => channel && state.editing[listId]?.id === message.id);

  const selfId = baseContext.selfId;
  const canDelete = own || (isGroup && isGroupAdmin);
  const isDeleted = message.deletedAt !== null;
  const canAct = canActOn(message);

  const context = useMemo(
    () => ({
      ...baseContext,
      emotes: message.emotes,
      onMention: (userId: string) => useApp.getState().setOverlay({ type: "verify", userId }),
    }),
    [baseContext, message.emotes],
  );
  const jumbo = useMemo(() => (message.attachments.length === 0 ? jumboSize(message.text, message.emotes) : 0), [message.text, message.emotes, message.attachments.length]);

  const hasReactions = message.reactions.length > 0;
  // The time goes at the end of the text, or below a link's preview, or below a big emote.
  const metaInText =
    !!message.text && !jumbo && !message.preview && !hasReactions && !isDeleted && message.status !== "undecryptable" && message.status !== "unverified" && message.status !== "invalid";
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const onlyImages = !message.text && images.length > 0 && images.length === message.attachments.length && !hasReactions;
  const onlyRound = !message.text && message.attachments.length === 1 && !!message.attachments[0]!.round && !message.reply && !message.forwarded;

  const meta = (
    <span
      className={`msg-meta${onlyImages ? " is-overlay" : ""}`}
      title={[
        formatFull(message.createdAt),
        message.timeDiffers ? `. ${t("message.meta.timeDiffers")}` : "",
        message.expiresAt ? `. ${t("message.meta.disappearsSentence", { time: formatFull(message.expiresAt) })}` : "",
      ].join("")}
    >
      {message.timeDiffers && <ShieldAlert size={11} aria-label={t("message.meta.timeWrong")} />}
      {message.expiresAt && <Timer size={10} className="msg-timer" aria-label={t("message.meta.disappearsLabel")} />}
      {message.pinnedAt && <Pin size={10} className="msg-pinned" />}
      {message.editedAt && !isDeleted && <span>{t("message.edited")}</span>}
      <span>{formatTime(message.createdAt)}</span>
      {own && !isDeleted && (
        <span className="msg-ticks">
          <ReadTicks message={message} readUpTo={readUpTo} />
        </span>
      )}
    </span>
  );

  // In a channel the time is beside the name, and only these follow the text.
  const trailing = channel ? (
    <>
      {message.editedAt && !isDeleted && (
        <span className="cmsg-edited" title={formatFull(message.editedAt)}>
          {t("message.editedChannel")}
        </span>
      )}
      {message.timeDiffers && (
        <span className="cmsg-flag" title={t("message.meta.timeDiffers")}>
          <ShieldAlert size={13} aria-label={t("message.meta.timeWrong")} />
        </span>
      )}
      {message.expiresAt && (
        <span className="cmsg-flag" title={t("message.meta.disappears", { time: formatFull(message.expiresAt) })}>
          <Timer size={12} className="msg-timer" aria-label={t("message.meta.disappearsLabel")} />
        </span>
      )}
    </>
  ) : metaInText ? (
    meta
  ) : undefined;

  const renderBody = (after?: ReactNode) => {
    if (!message.text) return null;
    if (jumbo) {
      return (
        <>
          {message.text
            .trim()
            .split(/\s+/)
            .map((word, index) => {
              const emote = emoteFor(message.emotes, word);
              return emote ? (
                <Emote key={index} name={word} emote={emote} serverUrl={context.serverUrl} size="jumbo" stackOnPrevious={emote.zeroWidth} />
              ) : (
                <span key={index} className="jumbo-emoji">
                  {word}
                </span>
              );
            })}
          {channel && after}
        </>
      );
    }
    return renderMarkup(message.text, context, after);
  };
  const body = renderBody(trailing);

  if (message.system) return <SystemMessage message={message} highlighted={highlighted} channel={channel} />;
  if (blockedSender && !revealed) {
    return (
      <div className={`msg is-other is-blocked${channel ? " is-channel" : ""}${highlighted ? " is-highlighted" : ""}`}>
        {isGroup && !channel && <span className="msg-avatar" />}
        <span className="msg-blocked">
          <Ban size={13} /> {t("message.blocked")}
          <button className="link-button" onClick={() => setRevealed(true)}>
            {t("message.showBlocked")}
          </button>
        </span>
      </div>
    );
  }

  const toggleReaction = (key: string, emote?: EmoteRef) => {
    void run(() => session().toggleReaction(message.groupId, message.id, key, emote));
  };

  // Worked out as the menu opens, as in Telegram, for your own messages in a group.
  const readers = menu.menu && own && isGroup && canAct ? readersOf(serverId, message) : [];
  const entries: MenuEntry[] = [
    ...(canAct ? [{ label: t("message.action.reply"), icon: <CornerUpLeft size={15} />, onSelect: () => setReply(listId, message) }] : []),
    ...(canAct
      ? [
          { label: t("message.action.forward"), icon: <Forward size={15} />, onSelect: () => useApp.getState().setOverlay({ type: "forward", serverId, groupId: message.groupId, ids: [message.id] }) },
          { label: t("message.action.select"), icon: <CircleCheck size={15} />, onSelect: () => useApp.getState().toggleSelected(listId, message.id) },
        ]
      : []),
    ...(message.text && !isDeleted
      ? [
          {
            label: window.getSelection()?.toString() ? t("message.action.copySelection") : t("message.action.copyText"),
            icon: <Copy size={15} />,
            onSelect: () => void copyText(window.getSelection()?.toString() || message.text).then(() => toast(t("common.copied"))),
          },
        ]
      : []),
    ...(canAct && own && message.text && !message.forwarded ? [{ label: t("common.edit"), icon: <Pencil size={15} />, onSelect: () => setEditing(listId, message) }] : []),
    ...(canAct
      ? [
          {
            label: message.pinnedAt ? t("message.action.unpin") : t("message.action.pin"),
            icon: message.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />,
            onSelect: () => void run(() => session().setPinned(message.groupId, message.id, !message.pinnedAt)),
          },
        ]
      : []),
    ...(readers.length > 0
      ? [
          {
            label: t("message.action.readBy", { count: readers.length }),
            icon: <CheckCheck size={15} />,
            submenu: readers.map((user) => ({
              label: user.displayName,
              icon: <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={20} />,
              onSelect: () => useApp.getState().selectConversation(`user:${user.id}`),
            })),
          },
        ]
      : []),
    ...(message.status === "failed"
      ? [
          { label: t("message.action.retry"), icon: <RefreshCw size={15} />, onSelect: () => void run(() => session().retryMessage(message.groupId, message.id)) },
          { label: t("message.action.discard"), icon: <Trash2 size={15} />, danger: true, onSelect: () => void session().discardMessage(message.groupId, message.id) },
        ]
      : []),
    ...(canAct && canDelete
      ? [{ separator: true }, { label: t("message.action.deleteForEveryone"), icon: <Trash2 size={15} />, danger: true, onSelect: () => void run(() => session().deleteMessage(message.groupId, message.id)) }]
      : []),
  ];

  const quickReactions = canAct ? (
    <div className="menu-react">
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => {
            menu.close();
            toggleReaction(emoji);
          }}
          aria-label={t("message.action.reactWith", { emoji })}
        >
          {emoji}
        </button>
      ))}
    </div>
  ) : undefined;

  const className = [
    "msg",
    own ? "is-own" : "is-other",
    grouped ? "is-grouped" : "",
    lastInGroup ? "is-last" : "",
    highlighted ? "is-highlighted" : "",
    jumbo ? "is-jumbo" : "",
    // A video message alone is a circle, without a bubble, as large emoji are.
    onlyRound ? "is-jumbo is-round" : "",
    fresh ? "is-fresh" : "",
    selecting ? "is-selecting" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Not on something with its own click, such as a link, a picture or a reaction.
  const repliesOnDoubleClick = (event: React.MouseEvent) =>
    canAct && !selecting && !(event.target as Element).closest("button, a, input, textarea, video, audio, [role='slider']");
  const totalReactors = message.reactions.reduce((sum, reaction) => sum + reaction.userIds.length, 0);
  const placeholder = isDeleted ? (
    <span className="msg-placeholder">{t("message.deleted")}</span>
  ) : message.status === "undecryptable" ? (
    <span className="msg-placeholder">
      <Spinner size={12} /> {t("message.waitingForKeys")}
    </span>
  ) : message.status === "unverified" ? (
    <span className="msg-placeholder is-danger">
      <ShieldAlert size={14} /> {t("message.unverified")}
    </span>
  ) : message.status === "invalid" ? (
    <span className="msg-placeholder is-danger">
      <ShieldAlert size={14} /> {t("message.invalid")}
    </span>
  ) : null;
  const check = selecting && (
    <span className={`msg-check${selected ? " is-on" : ""}${canAct ? "" : " is-disabled"}`} role="checkbox" aria-checked={selected} aria-label={t("message.selectLabel")}>
      {selected && <Check size={13} strokeWidth={3} />}
    </span>
  );
  const pickReaction = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPicker({ x: rect.left, y: rect.top });
  };
  const popups = (
    <AnimatePresence>
      {menu.menu && <PopupMenu x={menu.menu.x} y={menu.menu.y} entries={entries} onClose={menu.close} header={quickReactions} />}
      {picker && (
        <EmotePicker
          key="reaction-picker"
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(pick) => {
            setPicker(null);
            if (pick.kind === "emoji") toggleReaction(pick.value);
            else toggleReaction(pick.name, { id: pick.id, animated: pick.animated, zeroWidth: pick.zeroWidth, owner: pick.owner });
          }}
        />
      )}
    </AnimatePresence>
  );

  // As in a Discord channel: a picture and a name over a run of messages, each a full-width
  // row with its time beside the name, or on the left on hover further down the run.
  if (channel) {
    const mentionsMe = !own && (message.mentions.includes(selfId) || message.reply?.senderId === selfId);
    const canEdit = canAct && own && !!message.text && !message.forwarded;
    const classes = [
      className,
      "is-channel",
      mentionsMe ? "is-mentioned" : "",
      menu.menu || picker ? "is-menu-open" : "",
      message.status === "sending" ? "is-sending" : "",
      message.status === "failed" ? "is-failed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        className={classes}
        onContextMenu={(event) => !selecting && entries.length > 0 && menu.open(event)}
        onClickCapture={
          selecting
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (canAct) useApp.getState().toggleSelected(listId, message.id);
              }
            : undefined
        }
        onMouseDown={(event) => event.detail > 1 && repliesOnDoubleClick(event) && event.preventDefault()}
        onDoubleClick={(event) => !editingHere && repliesOnDoubleClick(event) && setReply(listId, message)}
      >
        {check}
        {message.reply && !placeholder && <ChannelReply message={message} blocked={blockedReply} />}
        <div className="cmsg-main">
          {grouped ? (
            <time className="cmsg-gutter-time" title={formatFull(message.createdAt)}>
              {formatTime(message.createdAt)}
            </time>
          ) : (
            <>
              <button className="cmsg-avatar" onClick={() => known && openProfile(message.senderId)} aria-label={known ? t("message.profileOf", { name: senderName }) : senderName} tabIndex={-1} disabled={!known}>
                <Avatar name={senderName} seed={message.senderId} avatar={senderAvatar} size={40} />
              </button>
              <h3 className="cmsg-head">
                <button className="cmsg-author" style={known ? { color: nameColor(message.senderId) } : undefined} onClick={() => known && openProfile(message.senderId)} disabled={!known}>
                  {senderName}
                </button>
                {senderIsBot && <BotBadge />}
                <time className="cmsg-time" title={formatFull(message.createdAt)}>
                  {formatStamp(message.createdAt)}
                </time>
              </h3>
            </>
          )}
          <div className="cmsg-body">
            {placeholder ??
              (editingHere ? (
                <InlineEditor message={message} listId={listId} />
              ) : (
                <>
                  {message.forwarded && <ForwardedFrom userId={message.forwarded.userId} />}
                  {body && <div className="msg-text selectable">{body}</div>}
                  {message.attachments.length > 0 && (
                    <div className="cmsg-attachments">
                      <Attachments message={message} serverId={serverId} flush={false} own={false} />
                    </div>
                  )}
                  {message.preview && <LinkCard preview={message.preview} />}
                  {message.location && <LocationCard location={message.location} />}
                  <MessageButtons message={message} />
                </>
              ))}
            {hasReactions && (
              <div className="reactions">
                {message.reactions.map((reaction) => (
                  <ReactionChip key={reaction.key} reaction={reaction} selfId={selfId} serverUrl={context.serverUrl} showPeople={false} onToggle={() => toggleReaction(reaction.key, reaction.emote)} />
                ))}
                {canAct && (
                  <Tooltip text={t("message.action.addReaction")} side="top">
                    <button className="reaction reaction-add" onClick={pickReaction} aria-label={t("message.action.addReaction")}>
                      <SmilePlus size={16} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
            {message.status === "failed" && (
              <button className="msg-retry" onClick={() => void run(() => session().retryMessage(message.groupId, message.id))}>
                <AlertCircle size={13} /> {t("message.notSent")}
              </button>
            )}
          </div>
        </div>
        {canAct && !selecting && !editingHere && (
          <div className="cmsg-toolbar">
            {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
              <button key={emoji} className="cmsg-tool is-emoji" onClick={() => toggleReaction(emoji)} aria-label={t("message.action.reactWith", { emoji })}>
                {emoji}
              </button>
            ))}
            <span className="cmsg-tool-divider" />
            <Tooltip text={t("message.action.addReaction")} side="top">
              <button className="cmsg-tool" onClick={pickReaction} aria-label={t("message.action.addReaction")}>
                <SmilePlus size={19} />
              </button>
            </Tooltip>
            {canEdit && (
              <Tooltip text={t("common.edit")} side="top">
                <button className="cmsg-tool" onClick={() => setEditing(listId, message)} aria-label={t("common.edit")}>
                  <Pencil size={17} />
                </button>
              </Tooltip>
            )}
            <Tooltip text={t("message.action.reply")} side="top">
              <button className="cmsg-tool" onClick={() => setReply(listId, message)} aria-label={t("message.action.reply")}>
                <CornerUpLeft size={19} />
              </button>
            </Tooltip>
            <Tooltip text={t("message.action.forward")} side="top">
              <button className="cmsg-tool" onClick={() => useApp.getState().setOverlay({ type: "forward", serverId, groupId: message.groupId, ids: [message.id] })} aria-label={t("message.action.forward")}>
                <Forward size={19} />
              </button>
            </Tooltip>
            <Tooltip text={t("message.action.more")} side="top">
              <button
                className="cmsg-tool"
                aria-label={t("message.action.more")}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  menu.open({ clientX: rect.right, clientY: rect.bottom + 2 });
                }}
              >
                <MoreHorizontal size={19} />
              </button>
            </Tooltip>
          </div>
        )}
        {popups}
      </div>
    );
  }

  return (
    <div
      className={className}
      onContextMenu={(event) => !selecting && entries.length > 0 && menu.open(event)}
      // While picking messages, a click picks this one instead of opening links or pictures.
      onClickCapture={
        selecting
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (canAct) useApp.getState().toggleSelected(listId, message.id);
            }
          : undefined
      }
    >
      {check}
      {!own && isGroup && <span className="msg-avatar">{lastInGroup && known && <Avatar name={senderName} seed={message.senderId} avatar={senderAvatar} size={32} />}</span>}
      <div className="msg-stack">
        <div
          className={`bubble${message.status === "sending" ? " is-sending" : ""}${message.status === "failed" ? " is-failed" : ""}`}
          // A double click replies, as in Telegram, rather than selecting a word.
          onMouseDown={(event) => event.detail > 1 && repliesOnDoubleClick(event) && event.preventDefault()}
          onDoubleClick={(event) => repliesOnDoubleClick(event) && setReply(listId, message)}
        >
          {!own && isGroup && !grouped && !jumbo && known && (
            <span className="msg-author" style={{ color: nameColor(message.senderId) }}>
              {senderName}
              {senderIsBot && <> <BotBadge /></>}
            </span>
          )}
          {placeholder ?? (
            <>
              {message.forwarded && <ForwardedFrom userId={message.forwarded.userId} />}
              {message.reply && (
                <button className="msg-reply" onClick={() => jump(message.groupId, message.reply!.id)}>
                  <span className="msg-reply-author" style={{ color: nameColor(message.reply.senderId || "x") }}>
                    {replyName}
                  </span>
                  <span className="msg-reply-text truncate">{message.reply.deleted ? t("message.deleted") : blockedReply ? t("message.blocked") : plainText(message.reply.text) || (message.reply.hasAttachment ? t("message.reply.attachment") : t("message.reply.tapToView"))}</span>
                </button>
              )}
              {message.attachments.length > 0 && <Attachments message={message} serverId={serverId} flush={onlyImages} own={own} />}
              {body && (
                <div className="msg-text selectable">
                  {body}
                </div>
              )}
              {message.preview && <LinkCard preview={message.preview} />}
              {message.location && <LocationCard location={message.location} />}
            </>
          )}
          {hasReactions ? (
            <div className="reactions">
              {message.reactions.map((reaction) => (
                <ReactionChip key={reaction.key} reaction={reaction} selfId={selfId} serverUrl={context.serverUrl} showPeople={totalReactors <= 3} onToggle={() => toggleReaction(reaction.key, reaction.emote)} />
              ))}
              {meta}
            </div>
          ) : (
            !metaInText && meta
          )}
        </div>
        {!placeholder && <MessageButtons message={message} />}
        {message.status === "failed" && (
          <button className="msg-retry" onClick={() => void run(() => session().retryMessage(message.groupId, message.id))}>
            <AlertCircle size={13} /> {t("message.notSent")}
          </button>
        )}
      </div>
      {canAct && !selecting && (
        <div className="msg-actions">
          <Tooltip text={t("message.action.react")} side="top">
            <button className="icon-btn is-small" aria-label={t("message.action.react")} onClick={pickReaction}>
              <SmilePlus size={15} />
            </button>
          </Tooltip>
          <Tooltip text={t("message.action.reply")} side="top">
            <button className="icon-btn is-small" onClick={() => setReply(listId, message)} aria-label={t("message.action.reply")}>
              <CornerUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip text={t("message.action.more")} side="top">
            <button
              className="icon-btn is-small"
              aria-label={t("message.action.more")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                menu.open({ clientX: own ? rect.left : rect.right, clientY: rect.bottom + 2 });
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          </Tooltip>
        </div>
      )}
      {popups}
    </div>
  );
});
