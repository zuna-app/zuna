// The rows of buttons under a bot's message. One with a link opens it, as a link in a
// message does. One with data sends that back to the bot: a press goes to the whole chat,
// as a chat's messages do, and nobody's app shows it.

import type { MessageView } from "@zuna/core";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useAction } from "@/components/ui";
import { useApp } from "@/state/store";

export function MessageButtons({ message }: { message: MessageView }) {
  const session = useApp((state) => state.session);
  const { run } = useAction();
  const [pressing, setPressing] = useState<string | null>(null);
  if (message.buttons.length === 0 || message.deletedAt !== null) return null;
  return (
    <div className="msg-buttons">
      {message.buttons.map((row, rowIndex) => (
        <div key={rowIndex} className="msg-button-row">
          {row.map((button, column) => {
            const key = `${rowIndex}/${column}`;
            if (button.url !== undefined) {
              return (
                <a key={key} className="msg-button" href={button.url} target="_blank" rel="noreferrer noopener" title={button.url}>
                  <span className="truncate">{button.text}</span>
                  <ArrowUpRight size={12} className="msg-button-link" />
                </a>
              );
            }
            return (
              <button
                key={key}
                className={`msg-button${pressing === key ? " is-pressing" : ""}`}
                disabled={message.status !== "sent" || pressing !== null}
                onClick={() => {
                  setPressing(key);
                  void run(() => session().pressButton(message.groupId, message.id, rowIndex, column)).finally(() => setPressing(null));
                }}
              >
                <span className="truncate">{button.text}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
