import type { ConversationView, Emote as ServerEmote, EmoteRef, LinkPreview, MessageView } from "@zuna/core";
import { findLink } from "@zuna/core/links";
import { MAX_TEXT_LENGTH } from "@zuna/core/validate";
import { plainText } from "@zuna/core/plain-text";
import { Check, CornerUpLeft, File as FileIcon, Link as LinkIcon, MapPin, Mic, Paperclip, Pencil, SendHorizontal, Smile, Trash2, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Emote } from "@/components/Emote";
import { Avatar, PopupMenu, Tooltip } from "@/components/ui";
import { focusComposer, registerComposer } from "@/lib/focus";
import { formatBytes, formatDuration } from "@/lib/format";
import { MAX_VOICE_SECONDS, VoiceRecorder } from "@/lib/voice";
import { prepareFile, type PreparedFile } from "@/lib/media";
import type { NotificationReply } from "@/platform";
import { findConversation, useActiveServer, useApp } from "@/state/store";
import { EmotePicker, type Pick } from "./EmotePicker";

export interface ComposerHandle {
  addFiles(files: File[]): void;
}

const drafts = new Map<string, string>();
const MAX_SUGGESTIONS = 8;
/** How long typing pauses before a link's page is fetched. */
const PREVIEW_DELAY_MS = 400;

interface Suggestion {
  key: string;
  label: string;
  hint?: string;
  insert: string;
  render: React.ReactNode;
}

export function mentionsIn(text: string, users: Record<string, { id: string; username: string }>): string[] {
  const byName = new Map(Object.values(users).map((user) => [user.username.toLowerCase(), user.id]));
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})/g)) {
    const id = byName.get(match[1]!.toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The server's emotes a message uses, by the word that stands for each. */
export function emotesIn(text: string, emotes: readonly ServerEmote[]): Record<string, EmoteRef> {
  const byName = new Map(emotes.map((emote) => [emote.name, emote]));
  const out: Record<string, EmoteRef> = {};
  for (const word of text.split(/\s+/)) {
    const emote = byName.get(word);
    if (emote) out[word] = { id: emote.id, animated: emote.animated, zeroWidth: emote.zero_width, owner: emote.owner };
  }
  return out;
}

/**
 * Sends what was typed into a notification. As in Telegram, it answers the message in
 * a group, where that says which one, and reads the chat.
 */
export function sendNotificationReply({ route, messageId, text }: NotificationReply): void {
  const { servers, session, toast } = useApp.getState();
  const server = servers[route.serverId];
  const conversation = findConversation(server, route.key);
  const value = text.trim();
  if (!server || !conversation || !value) return;
  const remote = session(route.serverId);
  const newest = conversation.lastMessage?.seq;
  if (conversation.groupId && newest) void remote.markRead(conversation.groupId, newest).catch(() => undefined);
  void remote
    .sendMessage(route.key, {
      text: value,
      replyTo: conversation.kind === "dm" ? undefined : messageId,
      emotes: emotesIn(value, server.emotes.emotes),
      mentions: mentionsIn(value, server.users),
    })
    .catch((error: Error) => toast(error.message, "error"));
}

/** Discord's attach button: a filled circle with a plus cut out of it. */
function PlusCircle() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" fillRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 6a1 1 0 1 0-2 0v3H8a1 1 0 1 0 0 2h3v3a1 1 0 1 0 2 0v-3h3a1 1 0 1 0 0-2h-3V8Z" />
    </svg>
  );
}

export const Composer = forwardRef<ComposerHandle, { conversation: ConversationView; listId: string }>(function Composer({ conversation, listId }, ref) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const settings = useApp((state) => state.settings);
  const replyTo = useApp((state) => state.replyTo[listId] ?? null);
  const isChannel = conversation.kind === "channel";
  // A channel's messages are edited where they are, so its message box only ever writes new ones.
  const editing = useApp((state) => (isChannel ? null : (state.editing[listId] ?? null)));
  const setReply = useApp((state) => state.setReply);
  const setEditing = useApp((state) => state.setEditing);
  const panel = useApp((state) => state.panel);
  const setPanel = useApp((state) => state.setPanel);
  const lastOwn = useApp((state) => {
    const items = state.lists[listId]?.items ?? [];
    const selfId = state.activeServerId ? state.servers[state.activeServerId]?.self?.userId : null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.senderId === selfId && item.text && item.seq !== null && !item.deletedAt && !item.system && !item.forwarded) return item;
    }
    return null;
  });

  const [text, setText] = useState(drafts.get(conversation.key) ?? "");
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null);
  const [attachAt, setAttachAt] = useState<{ x: number; y: number } | null>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [linkPreview, setLinkPreview] = useState<{ url: string; preview: LinkPreview | null; loading: boolean } | null>(null);
  const [dismissedLink, setDismissedLink] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ recorder: VoiceRecorder; levels: number[]; elapsed: number } | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const emotes = server?.emotes.emotes ?? [];
  const users = server?.users ?? {};
  const serverUrl = server?.entry.url ?? "";

  useEffect(() => {
    const element = input.current!;
    const unregister = registerComposer(element);
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    return unregister;
  }, []);

  useEffect(() => {
    drafts.set(conversation.key, text);
  }, [text, conversation.key]);

  useEffect(() => {
    if (editing) {
      setText(editing.text);
      setTimeout(() => {
        input.current?.focus();
        input.current?.setSelectionRange(editing.text.length, editing.text.length);
      });
    }
  }, [editing?.id]);

  useEffect(() => {
    if (replyTo) focusComposer();
  }, [replyTo?.id]);

  // The first link's preview, made on this device once typing pauses. Edits keep the one they had.
  const link = useMemo(() => (settings.linkPreviews && !editing ? findLink(text) : null), [text, settings.linkPreviews, editing]);
  useEffect(() => {
    if (!link || link === dismissedLink) {
      setLinkPreview(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setLinkPreview((shown) => (shown?.url === link ? shown : { url: link, preview: null, loading: true }));
      void useApp
        .getState()
        .core?.client.linkPreview(link)
        .then((preview) => current && setLinkPreview({ url: link, preview, loading: false }))
        .catch(() => current && setLinkPreview(null));
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [link, dismissedLink]);

  const addFiles = useCallback(async (incoming: File[]) => {
    const prepared = await Promise.all(incoming.map(prepareFile));
    setFiles((current) => [...current, ...prepared].slice(0, 10));
  }, []);

  useImperativeHandle(ref, () => ({ addFiles: (incoming) => void addFiles(incoming) }), [addFiles]);

  // Autocomplete: ":name" for emotes, from the ":" on, and "@name" for people.
  const trigger = useMemo(() => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|\s)([:@])([\p{L}\p{N}_.-]{0,32})$/u);
    if (!match || (match[1] === "@" && !match[2])) return null;
    return { kind: match[1] as ":" | "@", query: match[2]!.toLowerCase(), start: caret - match[2]!.length - 1 };
  }, [text, caret]);
  // Until two letters are typed, as in ":D", Enter sends what's written, and only the
  // arrows or Tab pick an emote, so nothing is picked to begin with.
  const tentative = trigger?.kind === ":" && trigger.query.length < 2;
  const emoteSuggestion = (emote: ServerEmote): Suggestion => ({
    key: emote.id,
    label: emote.name,
    hint: emote.owner ? `by ${emote.owner}` : undefined,
    insert: `${emote.name} `,
    render: <Emote name={emote.name} emote={{ id: emote.id, animated: emote.animated }} serverUrl={serverUrl} size="reaction" hoverCard={false} />,
  });

  const suggestions: Suggestion[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === ":") {
      if (!trigger.query) return emotes.slice(0, MAX_SUGGESTIONS).map(emoteSuggestion);
      const starts: typeof emotes = [];
      const contains: typeof emotes = [];
      for (const emote of emotes) {
        const lower = emote.name.toLowerCase();
        if (lower.startsWith(trigger.query)) starts.push(emote);
        else if (lower.includes(trigger.query)) contains.push(emote);
        if (starts.length >= MAX_SUGGESTIONS) break;
      }
      return [...starts, ...contains].slice(0, MAX_SUGGESTIONS).map(emoteSuggestion);
    }
    // Anyone on the server can be mentioned in a channel, even someone whose device hasn't come in yet.
    const members = conversation.kind === "group" ? conversation.members.map((member) => member.userId) : Object.keys(users);
    return members
      .map((id) => users[id])
      .filter((user): user is NonNullable<typeof user> => !!user && !user.banned)
      .filter((user) => user.username.toLowerCase().includes(trigger.query) || user.displayName.toLowerCase().includes(trigger.query))
      .slice(0, MAX_SUGGESTIONS)
      .map((user) => ({
        key: user.id,
        label: user.displayName,
        hint: `@${user.username}`,
        insert: `@${user.username} `,
        render: <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={24} />,
      }));
  }, [trigger, emotes, users, serverUrl, conversation.kind, conversation.members]);

  useEffect(() => setSelected(tentative ? -1 : 0), [trigger?.query, trigger?.kind]);

  const applySuggestion = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + suggestion.insert + text.slice(caret);
    const position = trigger.start + suggestion.insert.length;
    setText(next);
    setCaret(position);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  };

  const emotesInText = useCallback((value: string) => emotesIn(value, emotes), [emotes]);

  const send = () => {
    const value = text.trim();
    if (!value && files.length === 0) return;
    if (value.length > MAX_TEXT_LENGTH) {
      toast("That message is too long. Try sending it as a file.", "error");
      return;
    }
    if (editing) {
      if (value && value !== editing.text) {
        void session().editMessage(editing.groupId, editing.id, value, emotesInText(value), mentionsIn(value, users));
      }
      setEditing(listId, null);
      setText("");
      focusComposer();
      return;
    }
    const body = {
      text: value || undefined,
      replyTo: replyTo?.id,
      emotes: emotesInText(value),
      mentions: mentionsIn(value, users),
      preview: linkPreview?.preview && value.includes(linkPreview.url) ? linkPreview.preview : undefined,
    };
    // A preview that isn't ready yet, as when a link is pasted and sent at once, goes
    // with the message if it's ready within a few seconds; the message shows straight away.
    const settled = linkPreview?.url === link && !linkPreview.loading;
    const options = { previewUrl: link && link !== dismissedLink && !body.preview && !settled ? link : undefined };
    if (files.length > 0) {
      const sending = files;
      setFiles([]);
      void session()
        .sendWithAttachments(
          conversation.key,
          sending.map(({ blob, name, mime, width, height, thumb, duration }) => ({ blob, name, mime, width, height, thumb, duration })),
          body,
          { ...options, keepMetadata: !settings.removeMetadata },
        )
        .catch((error: Error) => toast(error.message, "error"));
    } else {
      void session()
        .sendMessage(conversation.key, body, options)
        .catch((error: Error) => toast(error.message, "error"));
    }
    // From a window of older messages, sending goes back to the newest.
    if (useApp.getState().lists[listId]?.detached) void useApp.getState().returnToLatest(listId);
    setText("");
    setReply(listId, null);
    setLinkPreview(null);
    setDismissedLink(null);
    focusComposer();
  };

  // --- Voice messages ---

  const startRecording = async () => {
    try {
      const started = await VoiceRecorder.start((level) =>
        setRecording((current) => current && { ...current, levels: [...current.levels.slice(-59), level], elapsed: current.recorder.elapsed }),
      );
      recorder.current = started;
      setRecording({ recorder: started, levels: [], elapsed: 0 });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  const cancelRecording = () => {
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(null);
    focusComposer();
  };

  const sendRecording = async () => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    setRecording(null);
    const voice = await active.stop();
    focusComposer();
    // A click on the microphone and straight back isn't a message.
    if (voice.duration < 0.5) return;
    const extension = voice.mime === "audio/mp4" ? "m4a" : "webm";
    void session()
      .sendWithAttachments(
        conversation.key,
        [{ blob: voice.blob, name: `Voice message.${extension}`, mime: voice.mime, duration: voice.duration, voice: true, waveform: voice.waveform }],
        { replyTo: replyTo?.id },
      )
      .catch((error: Error) => toast(error.message, "error"));
    setReply(listId, null);
  };

  // Enter sends a recording and Escape throws it away; a very long one is sent when it reaches the limit.
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void sendRecording();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener("keydown", onKey, true);
    if (recording.elapsed >= MAX_VOICE_SECONDS) void sendRecording();
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Leaving the chat throws an unsent recording away.
  useEffect(() => () => recorder.current?.cancel(), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((value) => (value + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((value) => (value < 0 ? suggestions.length - 1 : (value - 1 + suggestions.length) % suggestions.length));
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && selected >= 0)) {
        event.preventDefault();
        applySuggestion(suggestions[Math.max(0, selected)]!);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && settings.enterToSend) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Escape") {
      if (editing) {
        setEditing(listId, null);
        setText("");
      } else if (replyTo) {
        setReply(listId, null);
      } else if (panel) {
        setPanel(null);
      }
      return;
    }
    if (event.key === "ArrowUp" && !text && lastOwn) {
      event.preventDefault();
      setEditing(listId, lastOwn);
    }
  };

  const onInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    setCaret(event.target.selectionStart);
    if (conversation.groupId && event.target.value) {
      void session().sendTyping(conversation.groupId).catch(() => undefined);
    }
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length > 0) {
      event.preventDefault();
      void addFiles(pasted);
    }
  };

  const onPick = (pick: Pick) => {
    const insert = pick.kind === "emoji" ? pick.value : `${pick.name} `;
    const element = input.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const needsSpace = pick.kind === "emote" && start > 0 && !/\s$/.test(text.slice(0, start));
    const addition = needsSpace ? ` ${insert}` : insert;
    setText(text.slice(0, start) + addition + text.slice(end));
    const position = start + addition.length;
    setTimeout(() => element?.setSelectionRange(position, position));
  };

  const context: MessageView | null = editing ?? replyTo;
  const contextSender = context ? (context.senderId === server?.self?.userId ? "yourself" : (users[context.senderId]?.displayName ?? "Unknown")) : "";
  const canSend = !!text.trim() || files.length > 0;

  return (
    <div className={`composer-area${isChannel ? " is-channel" : ""}`}>
      {suggestions.length > 0 && (
        <div className="suggestions" role="listbox">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.key}
              role="option"
              aria-selected={index === selected}
              className={`suggestion${index === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                applySuggestion(suggestion);
              }}
            >
              {suggestion.render}
              <span className="truncate">{suggestion.label}</span>
              {suggestion.hint && <span className="faint truncate">{suggestion.hint}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="composer">
        {context && (
          <div className="composer-context">
            <div className="composer-context-inner">
              {editing ? <Pencil size={15} /> : <CornerUpLeft size={15} />}
              <span className="grow">
                {isChannel ? (
                  <span className="composer-context-text">
                    Replying to <b>{contextSender}</b>
                  </span>
                ) : (
                  <>
                    <span className="composer-context-title">{editing ? "Editing message" : `Replying to ${contextSender}`}</span>
                    <span className="composer-context-text truncate">{plainText(context.text) || context.attachments[0]?.name || "Attachment"}</span>
                  </>
                )}
              </span>
              <button
                className="icon-btn is-small"
                aria-label="Cancel"
                onClick={() => {
                  if (editing) {
                    setEditing(listId, null);
                    setText("");
                  } else {
                    setReply(listId, null);
                  }
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        {linkPreview && (linkPreview.loading || linkPreview.preview) && (
          <div className="composer-context link-draft">
            <div className="composer-context-inner">
              <LinkIcon size={15} />
              <span className="grow">
                <span className="composer-context-title truncate">{linkPreview.preview?.title ?? linkPreview.preview?.siteName ?? "Loading the link's preview…"}</span>
                <span className="composer-context-text truncate">{linkPreview.preview?.description ?? linkPreview.url}</span>
              </span>
              {linkPreview.preview?.image && <img className="link-draft-image" src={linkPreview.preview.image.data} alt="" />}
              <button className="icon-btn is-small" aria-label="Remove the link's preview" onClick={() => setDismissedLink(linkPreview.url)}>
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        {files.length > 0 && (
          <div className="composer-files">
            {files.map((file, index) => (
              <div key={`${file.name}-${index}`} className="file-chip">
                {file.mime.startsWith("image/") && file.previewUrl ? (
                  <img src={file.previewUrl} alt="" />
                ) : (
                  <span className="file-chip-icon">
                    <FileIcon size={16} />
                  </span>
                )}
                <span className="file-chip-info">
                  <span className="truncate">{file.name}</span>
                  <span className="faint">{formatBytes(file.blob.size)}</span>
                </span>
                <button className="file-chip-remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {recording ? (
          <div className="composer-row recording-row">
            <Tooltip text="Delete recording" side="top">
              <button className="icon-btn" onClick={cancelRecording} aria-label="Delete recording">
                <Trash2 size={18} />
              </button>
            </Tooltip>
            <span className="recording-dot" />
            <span className="recording-time">{formatDuration(recording.elapsed)}</span>
            <span className="recording-levels" aria-hidden>
              {recording.levels.map((level, index) => (
                <i key={index} style={{ height: `${Math.max(8, level * 100)}%` }} />
              ))}
            </span>
            <button className="send-button is-ready" onClick={() => void sendRecording()} aria-label="Send voice message">
              <SendHorizontal size={18} />
            </button>
          </div>
        ) : (
          <div className="composer-row">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addFiles([...event.target.files]);
                event.target.value = "";
              }}
            />
            {!editing && (
              <Tooltip text="Attach" side="top">
                <button
                  className={`icon-btn${attachAt ? " is-active" : ""}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAttachAt(attachAt ? null : { x: rect.left, y: rect.top - 6 });
                  }}
                  aria-label="Attach"
                >
                  {isChannel ? <PlusCircle /> : <Paperclip size={18} />}
                </button>
              </Tooltip>
            )}
            {attachAt && (
              <PopupMenu
                x={attachAt.x}
                y={attachAt.y}
                onClose={() => setAttachAt(null)}
                entries={[
                  { label: "Photo or file", icon: <FileIcon size={15} />, onSelect: () => fileInput.current?.click() },
                  { label: "Location", icon: <MapPin size={15} />, onSelect: () => useApp.getState().setOverlay({ type: "share-location", conversationKey: conversation.key }) },
                ]}
              />
            )}
            <textarea
              ref={input}
              className="composer-input"
              rows={1}
              placeholder={conversation.peerId && conversation.peerId === server?.self?.userId ? "Write a note to yourself" : `Message ${isChannel ? "#" : ""}${conversation.title}`}
              value={text}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
              onClick={(event) => setCaret(event.currentTarget.selectionStart)}
              onPaste={onPaste}
              aria-label="Message"
              spellCheck
            />
            <Tooltip text="Emoji and emotes" side="top">
              <button
                className={`icon-btn${pickerAt ? " is-active" : ""}`}
                aria-label="Emoji and emotes"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setPickerAt(pickerAt ? null : { x: rect.right - 330, y: rect.top });
                }}
              >
                <Smile size={18} />
              </button>
            </Tooltip>
            {!canSend && !editing ? (
              <Tooltip text="Record a voice message" side="top">
                <button className="send-button is-ready" onClick={() => void startRecording()} aria-label="Record a voice message">
                  <Mic size={18} />
                </button>
              </Tooltip>
            ) : (
              <button className={`send-button${canSend ? " is-ready" : ""}`} disabled={!canSend} onClick={send} aria-label={editing ? "Save edit" : "Send"}>
                {editing ? <Check size={18} /> : <SendHorizontal size={18} />}
              </button>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {pickerAt && (
          <EmotePicker
            key="composer-picker"
            anchor={pickerAt}
            onClose={() => setPickerAt(null)}
            onPick={(pick) => {
              onPick(pick);
              if (pick.kind === "emote") setPickerAt(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
});
