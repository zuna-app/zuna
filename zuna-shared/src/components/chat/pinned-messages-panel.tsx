import { useEffect, useRef, useState } from "react";
import { Pin, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { decrypt } from "../../crypto/x25519";
import { usePlatform } from "../../platform";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import {
  Message,
  RawMessageDTO,
  Server,
  ChatMember,
} from "@/types/serverTypes";
import { cn } from "@/lib/utils";
import { formatTime } from "./messages/types";
import { ZunaAvatar } from "../avatar";

interface PinnedMessagesPanelProps {
  server: Server;
  member: ChatMember;
  sharedSecret: string | null;
}

interface DecryptedPinnedMessage {
  msg: Message;
  plaintext: string;
}

export function PinnedMessagesPanel({
  server,
  member,
  sharedSecret,
}: PinnedMessagesPanelProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DecryptedPinnedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sharedSecretRef = useRef(sharedSecret);
  sharedSecretRef.current = sharedSecret;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);

    authorizedFetch(
      `/api/chat/pinned?chat_id=${encodeURIComponent(member.chatId)}`,
    )
      .then((res) => res.json())
      .then(async (json: { messages: RawMessageDTO[] }) => {
        if (cancelled) return;
        const raw = json.messages ?? [];
        const secret = sharedSecretRef.current;

        const items: DecryptedPinnedMessage[] = await Promise.all(
          raw.map(async (m) => {
            const msg: Message = {
              id: m.id,
              localId: null,
              chatId: member.chatId,
              cipherText: m.cipher_text,
              iv: m.iv,
              authTag: m.auth_tag,
              sentAt: m.sent_at,
              readAt: m.read_at > 0 ? m.read_at : undefined,
              senderId: m.sender_id,
              isOwn: m.sender_id === server.id,
              pending: false,
              attachmentId: m.attachment_id,
              attachmentMetadata: m.attachment_metadata,
              attachmentMetadataIv: m.attachment_metadata_iv,
              attachmentMetadataAuthTag: m.attachment_metadata_auth_tag,
              modified: m.modified,
              pinned: true,
              isReply: false,
            };

            let plaintext = "";
            if (secret) {
              try {
                const text = decrypt(secret, {
                  ciphertext: m.cipher_text,
                  iv: m.iv,
                  authTag: m.auth_tag,
                });
                plaintext = text === "\u200b" ? "" : text;
              } catch {
                plaintext = "[decryption failed]";
              }
            }

            return { msg, plaintext };
          }),
        );

        if (!cancelled) {
          // Server returns newest-first; reverse so oldest is at top, newest at bottom
          setMessages(items.reverse());
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, member.chatId, authorizedFetch]);

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (!loading && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [loading, messages.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Pin className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>Pinned messages</span>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        className="w-96 p-0 overflow-hidden flex flex-col max-h-120"
        sideOffset={6}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 shrink-0">
          <div className="flex items-center gap-2">
            <Pin className="size-3.5 text-muted-foreground" />
            <span className="text-sm font-semibold">Pinned Messages</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent] px-3 py-3 space-y-2">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground/50">
              <Pin className="size-8" />
              <p className="text-sm">No pinned messages yet</p>
            </div>
          ) : (
            messages.map(({ msg, plaintext }) => (
              <PinnedMessageItem
                key={msg.id}
                msg={msg}
                plaintext={plaintext}
                member={member}
                server={server}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PinnedMessageItemProps {
  msg: Message;
  plaintext: string;
  member: ChatMember;
  server: Server;
}

function PinnedMessageItem({
  msg,
  plaintext,
  member,
  server,
}: PinnedMessageItemProps) {
  const isOwn = msg.isOwn;
  const displayName = isOwn ? server.username : member.username;
  const avatarSrc = isOwn ? undefined : member.avatar;

  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-xl px-3 py-2.5",
        "bg-muted/40 hover:bg-muted/60 transition-colors",
      )}
    >
      <div className="shrink-0 mt-0.5 [&>span]:size-7 [&>span]:text-[10px]">
        <ZunaAvatar
          username={displayName}
          src={avatarSrc}
          isOnline={false}
          noBadge
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-xs font-semibold truncate">{displayName}</span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {formatTime(msg.sentAt)}
          </span>
        </div>
        {msg.attachmentId ? (
          <p className="text-sm text-muted-foreground italic">
            📎 {plaintext || "Attachment"}
          </p>
        ) : plaintext ? (
          <p className="text-sm leading-relaxed wrap-break-word line-clamp-4 text-foreground/90">
            {plaintext}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground/50 italic">[encrypted]</p>
        )}
        {msg.modified && (
          <span className="text-[10px] text-muted-foreground/50">edited</span>
        )}
      </div>
    </div>
  );
}
