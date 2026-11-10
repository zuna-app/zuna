// Asks before coming into a voice channel or a call here, while another of this person's
// devices is in one on the same server: only one of them stays in, so the other is taken out.

import { Confirm } from "@/components/ui";
import { conversationOfGroup, useApp, type ServerState } from "@/state/store";
import { useVoice, type VoiceMove } from "@/voice/store";

/** Where the other device is, in words that follow "You're in". */
function whereElsewhere(server: ServerState | undefined, moving: VoiceMove): string {
  const channel = server?.channels.find((item) => item.id === moving.from);
  if (moving.from === moving.channelId) return channel ? "this voice channel" : "this call";
  if (channel) return channel.name || "a voice channel";
  const conversation = conversationOfGroup(server, moving.from);
  if (!conversation) return "a call";
  return conversation.kind === "dm" ? `a call with ${conversation.title}` : `a call in ${conversation.title}`;
}

export function MoveVoice() {
  const moving = useVoice((state) => state.moving);
  const answerMove = useVoice((state) => state.answerMove);
  const where = useApp((state) => (moving ? whereElsewhere(state.servers[moving.serverId], moving) : ""));
  if (!moving) return null;
  return (
    <Confirm title="Join on this device?" action="Join here" kind="primary" onCancel={() => answerMove(false)} onConfirm={() => answerMove(true)}>
      {`You're in ${where} on another device. Joining here disconnects that device.`}
    </Confirm>
  );
}
