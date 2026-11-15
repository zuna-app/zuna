// Asks before coming into a voice channel or a call here, while another of this person's
// devices is in one on the same server: only one of them stays in, so the other is taken out.

import { Confirm } from "@/components/ui";
import { t } from "@/lib/i18n";
import { conversationOfGroup, useApp, type ServerState } from "@/state/store";
import { useVoice, type VoiceMove } from "@/voice/store";

/** Where the other device is, and what joining here does to it. */
function whereElsewhere(server: ServerState | undefined, moving: VoiceMove): string {
  const channel = server?.channels.find((item) => item.id === moving.from);
  if (moving.from === moving.channelId) return channel ? t("voice.moveHere.thisChannel") : t("voice.moveHere.thisCall");
  if (channel) return channel.name ? t("voice.moveHere.channel", { channel: channel.name }) : t("voice.moveHere.unnamedChannel");
  const conversation = conversationOfGroup(server, moving.from);
  if (!conversation) return t("voice.moveHere.call");
  return conversation.kind === "dm" ? t("voice.moveHere.callWith", { name: conversation.title }) : t("voice.move.callIn", { name: conversation.title });
}

export function MoveVoice() {
  const moving = useVoice((state) => state.moving);
  const answerMove = useVoice((state) => state.answerMove);
  const where = useApp((state) => (moving ? whereElsewhere(state.servers[moving.serverId], moving) : ""));
  if (!moving) return null;
  return (
    <Confirm title={t("voice.moveHere.title")} action={t("voice.moveHere.join")} kind="primary" onCancel={() => answerMove(false)} onConfirm={() => answerMove(true)}>
      {where}
    </Confirm>
  );
}
