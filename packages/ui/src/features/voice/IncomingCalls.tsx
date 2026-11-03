// Calls ringing this person, wherever in the app they are, and the ringing itself: for a
// call coming in, and for the one calling while it rings the others.

import type { CallView, ConversationView } from "@zuna/core";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Avatar, Tooltip } from "@/components/ui";
import { conversationOfGroup, useApp, type ServerState } from "@/state/store";
import { setRinging } from "@/voice/sounds";
import { useVoice } from "@/voice/store";

interface Incoming {
  serverId: string;
  call: CallView;
  conversation: ConversationView;
  /** The conversation is muted, so it shows without a sound. */
  quiet: boolean;
}

/** The calls ringing this person that this device could answer. */
function incomingCalls(servers: Record<string, ServerState>, inServer: string | null, inRoom: string | null): Incoming[] {
  const found: Incoming[] = [];
  for (const [serverId, server] of Object.entries(servers)) {
    const self = server.self?.userId;
    if (!self || server.entry.signedOut) continue;
    for (const call of Object.values(server.calls)) {
      if (!call.ringing.includes(self) || (inServer === serverId && inRoom === call.groupId)) continue;
      const conversation = conversationOfGroup(server, call.groupId);
      if (!conversation || conversation.removed || conversation.blocked || server.prefs.blocked?.includes(call.startedBy)) continue;
      found.push({ serverId, call, conversation, quiet: conversation.muted });
    }
  }
  return found.sort((a, b) => a.call.startedAt - b.call.startedAt);
}

function IncomingCall({ incoming, multipleServers }: { incoming: Incoming; multipleServers: boolean }) {
  const server = useApp((state) => state.servers[incoming.serverId]);
  const join = useVoice((state) => state.join);
  const decline = useVoice((state) => state.decline);
  const { conversation, call } = incoming;
  const caller = server?.users[call.startedBy]?.displayName ?? "Someone";
  const what = conversation.kind === "dm" ? "Calling you" : `${caller} started a call`;
  const answer = (camera: boolean) => {
    const app = useApp.getState();
    app.selectServer(incoming.serverId);
    app.selectConversation(conversation.key);
    void join(incoming.serverId, call.groupId, undefined, { camera });
  };
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`${conversation.title}: ${what}`}>
      <Avatar name={conversation.title} seed={conversation.peerId ?? conversation.groupId ?? ""} avatar={conversation.avatar} size={48} />
      <div className="incoming-call-who">
        <b className="truncate">{conversation.title}</b>
        <span className="truncate">
          {what}
          {multipleServers && server ? ` · ${server.entry.name}` : ""}
        </span>
      </div>
      <Tooltip text="Decline" side="bottom">
        <button className="call-button is-decline" onClick={() => decline(incoming.serverId, call.groupId)} aria-label="Decline">
          <PhoneOff size={18} />
        </button>
      </Tooltip>
      <Tooltip text="Answer with video" side="bottom">
        <button className="call-button is-video" onClick={() => answer(true)} aria-label="Answer with video">
          <Video size={18} />
        </button>
      </Tooltip>
      <Tooltip text="Answer" side="bottom">
        <button className="call-button is-answer" onClick={() => answer(false)} aria-label="Answer">
          <Phone size={18} />
        </button>
      </Tooltip>
    </div>
  );
}

export function IncomingCalls() {
  const servers = useApp((state) => state.servers);
  const inServer = useVoice((state) => state.serverId);
  const inRoom = useVoice((state) => state.channelId);
  const status = useVoice((state) => state.status);
  const isCall = useVoice((state) => state.call);
  const volume = useVoice((state) => Math.min(1, state.settings.outputVolume));
  const incoming = useMemo(() => incomingCalls(servers, inServer, inRoom), [servers, inServer, inRoom]);

  // The one calling hears it ring while it rings the others and nobody else has come.
  const server = inServer ? servers[inServer] : undefined;
  const self = server?.self?.userId;
  const ringingOthers =
    isCall &&
    status === "connected" &&
    !!inRoom &&
    (server?.calls[inRoom]?.ringing.length ?? 0) > 0 &&
    !Object.values(server?.voice ?? {}).some((member) => member.channelId === inRoom && member.userId !== self);
  const ring = incoming.some((item) => !item.quiet) ? "incoming" : ringingOthers ? "outgoing" : null;

  useEffect(() => {
    setRinging(ring, volume);
  }, [ring, volume]);
  useEffect(() => () => setRinging(null), []);

  if (incoming.length === 0) return null;
  return (
    <div className="incoming-calls">
      {incoming.map((item) => (
        <IncomingCall key={`${item.serverId}:${item.call.groupId}`} incoming={item} multipleServers={Object.keys(servers).length > 1} />
      ))}
    </div>
  );
}
