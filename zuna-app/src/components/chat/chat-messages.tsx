import { useEffect, useRef, useMemo } from "react";
import { ChatMember } from "@/types/serverTypes";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, CheckCheck } from "lucide-react";

type MessageStatus = "sent" | "read";

interface DemoMessage {
  id: string;
  content: string;
  isOwn: boolean;
  timestamp: string;
  showTimestamp?: boolean;
  status?: MessageStatus;
}

const BASE_MESSAGES: Array<{ content: string; isOwn: boolean; ts: string }> = [
  { content: "Hey! How's everything going?", isOwn: true, ts: "10:24 AM" },
  {
    content: "Pretty good, thanks for asking! Just wrapped up a big sprint.",
    isOwn: false,
    ts: "10:25 AM",
  },
  { content: "Nice! How did it go?", isOwn: true, ts: "10:25 AM" },
  {
    content:
      "Really well actually. We finally shipped the feature we've been working on for weeks.",
    isOwn: false,
    ts: "10:26 AM",
  },
  {
    content: "That's awesome, congrats! 🎉",
    isOwn: true,
    ts: "10:26 AM",
  },
  {
    content: "Thanks! Did you get a chance to look at those files I sent?",
    isOwn: false,
    ts: "10:28 AM",
  },
  {
    content:
      "Yes, went through them this morning. Really solid work overall. I had a few minor suggestions but nothing major.",
    isOwn: true,
    ts: "10:31 AM",
  },
  {
    content: "Oh great! What did you think of the architecture section?",
    isOwn: false,
    ts: "10:32 AM",
  },
  {
    content:
      "I think the modular approach is the right call. The alternative could get messy fast once you start scaling.",
    isOwn: true,
    ts: "10:33 AM",
  },
  {
    content: "Exactly my thinking. Glad we're on the same page.",
    isOwn: false,
    ts: "10:33 AM",
  },
  {
    content: "Are you free sometime this week to go over it together?",
    isOwn: true,
    ts: "10:35 AM",
  },
  {
    content: "Thursday afternoon works for me. Say 3 PM?",
    isOwn: false,
    ts: "10:36 AM",
  },
  {
    content: "Perfect, I'll send a calendar invite.",
    isOwn: true,
    ts: "10:36 AM",
  },
  { content: "Sounds good. See you then 👋", isOwn: false, ts: "10:37 AM" },
];

const TIMESTAMP_DIVIDERS = ["10:00 AM", "10:30 AM", "Now"];

function generateMessages(member: ChatMember): DemoMessage[] {
  const nameLen = member.username.length;
  const offset = nameLen % 3;

  const readCutoff = BASE_MESSAGES.length - 3;

  return BASE_MESSAGES.map((m, i) => ({
    id: `msg-${i}`,
    content:
      i === 0 ? `Hey ${member.username}! How's everything going?` : m.content,
    isOwn: m.isOwn,
    timestamp: m.ts,
    showTimestamp:
      i === 0 || i === Math.floor(BASE_MESSAGES.length / 2) + offset,
    status: m.isOwn
      ? ((i >= readCutoff ? "read" : "sent") as MessageStatus)
      : undefined,
  }));
}

function groupMessages(messages: DemoMessage[]) {
  type GroupedMessage = DemoMessage & {
    isFirst: boolean;
    isLast: boolean;
  };

  const result: GroupedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    result.push({
      ...messages[i],
      isFirst: !prev || prev.isOwn !== messages[i].isOwn,
      isLast: !next || next.isOwn !== messages[i].isOwn,
    });
  }
  return result;
}

interface ChatMessagesProps {
  member: ChatMember;
}

export function ChatMessages({ member }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => generateMessages(member), [member.id]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [member.id]);

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="px-4 py-4 space-y-0.5">
        <div className="flex items-center gap-3 py-3">
          <div className="flex-1 h-px bg-border/40" />
          <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
            Today
          </span>
          <div className="flex-1 h-px bg-border/40" />
        </div>

        {grouped.map((msg, i) => {
          const showDivider = msg.showTimestamp && i > 0;

          return (
            <div key={msg.id}>
              {showDivider && (
                <div className="flex items-center gap-3 py-3 mt-2">
                  <div className="flex-1 h-px bg-border/40" />
                  <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                    {msg.timestamp}
                  </span>
                  <div className="flex-1 h-px bg-border/40" />
                </div>
              )}
              <div
                className={cn(
                  "flex",
                  msg.isOwn ? "justify-end" : "justify-start",
                  msg.isFirst ? "mt-3" : "mt-0.5",
                )}
              >
                <div
                  className={cn(
                    "relative max-w-[95%] lg:max-w-[65%] px-3.5 py-2 text-sm leading-relaxed wrap-break-word",
                    msg.isOwn
                      ? cn(
                          "bg-primary text-primary-foreground",
                          msg.isFirst && msg.isLast && "rounded-2xl",
                          msg.isFirst &&
                            !msg.isLast &&
                            "rounded-t-2xl rounded-bl-2xl rounded-br-md",
                          !msg.isFirst &&
                            msg.isLast &&
                            "rounded-b-2xl rounded-tl-2xl rounded-tr-md",
                          !msg.isFirst &&
                            !msg.isLast &&
                            "rounded-l-2xl rounded-r-md",
                        )
                      : cn(
                          "bg-muted/70 dark:bg-muted/40 text-foreground",
                          msg.isFirst && msg.isLast && "rounded-2xl",
                          msg.isFirst &&
                            !msg.isLast &&
                            "rounded-t-2xl rounded-br-2xl rounded-bl-md",
                          !msg.isFirst &&
                            msg.isLast &&
                            "rounded-b-2xl rounded-tr-2xl rounded-tl-md",
                          !msg.isFirst &&
                            !msg.isLast &&
                            "rounded-r-2xl rounded-l-md",
                        ),
                  )}
                >
                  <span>{msg.content}</span>
                  {msg.isLast && (
                    <>
                      <span
                        aria-hidden
                        className="inline-block align-bottom ml-1.5 opacity-0 pointer-events-none select-none text-[10px]"
                      >
                        {msg.timestamp}
                        {msg.isOwn && msg.status && "\u00a0\u00a0\u2713"}
                      </span>
                      <span
                        className={cn(
                          "absolute bottom-2 right-3.5 flex items-center gap-0.5 text-[10px]",
                          msg.isOwn
                            ? "text-primary-foreground/60"
                            : "text-muted-foreground/50",
                        )}
                      >
                        {msg.timestamp}
                        {msg.isOwn && msg.status === "sent" && (
                          <Check
                            className="size-3 shrink-0"
                            strokeWidth={2.5}
                          />
                        )}
                        {msg.isOwn && msg.status === "read" && (
                          <CheckCheck
                            className="size-3 shrink-0"
                            strokeWidth={2.5}
                          />
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} className="pt-1" />
      </div>
    </ScrollArea>
  );
}
